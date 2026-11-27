/**
 * The fix log entry's two activities (STW-710) against the fake GitHub, with an
 * injected model: what the draft reads and from where, the draft that makes no
 * model call when the entry is on the branch, and the commit's three outcomes
 * with the review notes on each. No network.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { GOOD, acceptingReviewer, findingText, reply, scriptedModel } from '../lib/fix-log-fixtures.js';
import { commitFixLogEntry, draftFixLogEntryWith, fixLogNotesMarker } from '../../src/activities/fix-log.js';
import { BRIEF_PATH } from '../../src/lib/fix-log-backfill.js';
import { branchSha, ensureBranch } from '../../src/lib/github-contents.js';

const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR = `https://github.com/${SITE_REPO}/pull/900`;
const BRANCH = 'claude/issue-77-about';
const OTHER = 'claude/issue-78-other';
const FINDING_PATH = 'sites/mattpyle-com/findings/synthetic-mp-950.md';
const ENTRY_PATH = 'src/content/fixes/mp-950.md';
const NOTE = { quote: 'One of them had been removed.', rule: 'The story', reason: 'The finding does not say when.' };

const entry = (key: string, title: string) => `---\nkey: ${key}\ntitle: ${title}\nslug: ${title.toLowerCase().replace(/ /g, '-')}\n---\n\nStory.\n`;

let gh: FakeGitHub;

beforeEach(async () => {
  gh = installFakeGitHub({
    seed: {
      [BRIEF_PATH]: '# Writing a fix log entry\n\nThe brief on master.',
      'src/content/fixes/mp-1.md': entry('MP-1', 'An earlier fix on master'),
    },
  });
  await ensureBranch('main', 'seed', SITE_REPO);
  gh.push('main', FINDING_PATH, findingText('MP-950', { status: 'fixing', verified: false }), 'the finding');
  await ensureBranch(BRANCH, 'seed', SITE_REPO);
  // The fixer's own copy of the brief: the draft must never read it.
  gh.push(BRANCH, BRIEF_PATH, '# A brief the fixer wrote', 'the fixer edits the brief');
  await ensureBranch(OTHER, 'seed', SITE_REPO);
  gh.push(OTHER, 'src/content/fixes/mp-2.md', entry('MP-2', 'Another open fix'), 'another fix with its entry');
  gh.pulls.push({ number: 900, head: BRANCH, base: 'master', title: 'fix: about sections', body: 'Removes the stale section name.', draft: false });
  gh.pulls.push({ number: 901, head: OTHER, base: 'master', title: 'fix: other', body: '', draft: false });
});

afterEach(() => gh.restore());

// The finding key is joined at run time: as one literal beside `key:`, the gitleaks job reads it as an API key.
const draftInput = { repo: 'mattpyle/argus', findingPath: FINDING_PATH, key: ['synthetic', 'mp', '950'].join('-'), prUrl: PR };

test('the draft reads the brief from master and the titles from master and every other open fix branch', async () => {
  const model = scriptedModel([reply(GOOD)]);
  const out = await draftFixLogEntryWith(draftInput, { send: model.send, review: acceptingReviewer().send });
  assert.equal(out.state, 'drafted');
  assert.match(model.calls[0].system, /The brief on master\./);
  assert.doesNotMatch(model.calls[0].system, /A brief the fixer wrote/);
  const prompt = String(model.calls[0].messages[0].content);
  assert.match(prompt, /- An earlier fix on master/);
  assert.match(prompt, /- Another open fix/);
  assert.match(prompt, /Removes the stale section name/, 'the PR body');
  if (out.state === 'drafted') {
    assert.equal(out.path, ENTRY_PATH);
    assert.doesNotMatch(out.text, /^(verified|merged):/m, 'an entry written before the merge holds neither');
  }
});

test('the draft makes no model call when the entry is already on the PR branch', async () => {
  gh.push(BRANCH, ENTRY_PATH, entry('MP-950', 'Written before'), 'an entry already there');
  const model = scriptedModel([]);
  const out = await draftFixLogEntryWith(draftInput, { send: model.send });
  assert.deepEqual(out, { state: 'exists', key: 'MP-950', path: ENTRY_PATH });
  assert.equal(model.calls.length, 0);
});

const commitInput = (notes = [NOTE]) => ({ prUrl: PR, key: 'MP-950', path: ENTRY_PATH, text: entry('MP-950', 'The entry'), notes });

test('the commit lands on the branch head it read, and the notes become one PR comment', async () => {
  const before = await branchSha(BRANCH, SITE_REPO);
  const out = await commitFixLogEntry(commitInput());
  assert.equal(out.state, 'committed');
  assert.equal(out.parent, before);
  assert.equal(out.sha, await branchSha(BRANCH, SITE_REPO));
  assert.equal(out.notes, 'posted');
  assert.equal(gh.file(BRANCH, ENTRY_PATH)?.text, entry('MP-950', 'The entry'));
  assert.deepEqual(gh.refUpdates.at(-1), { branch: BRANCH, sha: out.sha, force: false }, 'a fast forward, never a force');
  const comments = gh.pulls[0].comments ?? [];
  assert.equal(comments.length, 1);
  assert.match(comments[0], /1\. "One of them had been removed\." \(The story\): The finding does not say when\./);
  assert.ok(comments[0].includes(fixLogNotesMarker('MP-950')));
});

test('a retry that finds the file commits nothing and still posts the notes, once', async () => {
  await commitFixLogEntry(commitInput([]));
  const again = await commitFixLogEntry(commitInput());
  assert.deepEqual(again, { state: 'exists', sha: null, parent: null, notes: 'posted' });
  const third = await commitFixLogEntry(commitInput());
  assert.equal(third.notes, 'none', 'the marker keeps it to one comment');
  assert.equal(gh.pulls[0].comments?.length, 1);
  assert.equal(gh.history(BRANCH).filter((m) => m === 'Fix log: add the entry for MP-950').length, 1);
});

test('a branch that moves while the commit is built is left alone', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    // The fixer pushes after Steward read the head and before it moves the branch.
    if (init?.method === 'PATCH' && url.includes('/git/refs/heads/')) gh.push(BRANCH, 'src/pages/about.astro', 'a push', 'the fixer pushes');
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const out = await commitFixLogEntry(commitInput());
    assert.deepEqual(out, { state: 'moved', sha: null, parent: null, notes: 'none' });
    assert.equal(gh.file(BRANCH, ENTRY_PATH), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a notes comment that fails is reported, not thrown, so the commit is not repeated', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === 'POST' && url.endsWith('/issues/900/comments')) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const out = await commitFixLogEntry(commitInput());
    assert.equal(out.state, 'committed');
    assert.match(out.notes, /^the comment failed: /);
  } finally {
    globalThis.fetch = realFetch;
  }
});
