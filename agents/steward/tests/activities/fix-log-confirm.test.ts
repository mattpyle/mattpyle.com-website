import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { GOOD, findingText } from '../lib/fix-log-fixtures.js';
import {
  confirmFixLogEntryNow,
  mergeFixLogConfirmation,
  openFixLogConfirmation,
  type OpenFixLogConfirmationResult,
} from '../../src/activities/fix-log-confirm.js';
import { confirmationDiffRefusal } from '../../src/lib/fix-log-confirm.js';
import { entryData, entryFileText, entryPath, findingFacts } from '../../src/lib/fix-log-rules.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { branchSha, ensureBranch } from '../../src/lib/github-contents.js';

/**
 * The fix log confirmation's activities (STW-712) against the fake GitHub: the
 * entry on master completed from the finding after the verify, in a pull
 * request Steward opens and merges itself, and every case that leaves it alone
 * or open.
 */

const SITE_REPO = 'mattpyle/mattpyle.com-website';
const FINDINGS = 'mattpyle/argus';
const KEY = 'MP-950';
const FINDING_PATH = 'sites/mattpyle-com/findings/synthetic-mp-950.md';
const PASSING = [{ name: 'Private paths not tracked', status: 'completed', conclusion: 'success' }];

let github: FakeGitHub | undefined;
afterEach(() => {
  github?.restore();
  github = undefined;
});

/** The entry as the fix PR merged it: written before the merge, so no `verified`, no `merged`, no checks. */
function draftEntry(key = KEY, pr = 900): string {
  const facts = findingFacts(findingText(key, { status: 'fixing', verified: false, pr }))!;
  const data = entryData(facts, { number: pr, title: 'fix: the about page', opened: '2026-11-19T04:00:00Z', merged: null }, {
    title: `${GOOD.title}${key === KEY ? '' : ` (${key})`}`,
    lead: GOOD.lead,
    visual: false,
    measures: [GOOD.measure],
    story: GOOD.story,
  });
  return entryFileText(data, GOOD.story);
}

const REOPENED_VERIFICATION = (at: string) =>
  `\n## Verification\n\nSteward ran this finding's checks against production at ${at}. Outcome: reopened.\n\n1. Fail, \`text\` on https://www.mattpyle.com/about/. Expected: 0 occurrences of "old line". Measured: 1 occurrence.\n`;

/** The finding after its verify: `resolved` by default, or as given. */
function verifiedFinding(options: { status?: string; pr?: number; verification?: string; key?: string } = {}): string {
  const key = options.key ?? KEY;
  const text = findingText(key, { status: options.status ?? 'resolved', pr: options.pr ?? 900, verified: !options.verification });
  return options.verification ? text + options.verification : text;
}

async function stage(options: { finding?: string; entry?: string | null; prs?: number[] } = {}): Promise<FakeGitHub> {
  const seed: Record<string, string> = {};
  if (options.entry !== null) seed[entryPath(KEY)] = options.entry ?? draftEntry();
  const gh = installFakeGitHub({ seed });
  github = gh;
  await ensureBranch('main', 'seed', FINDINGS);
  gh.push('main', FINDING_PATH, options.finding ?? verifiedFinding(), 'the finding');
  for (const number of options.prs ?? [900]) {
    gh.pulls.push({ number, head: `claude/issue-${number}`, base: 'master', title: `fix: the about page (${number})`, body: '', draft: false, state: 'closed', merged: true, mergeSha: `m${number}` });
  }
  return gh;
}

const input = (pr = 900, findingPath = FINDING_PATH, key = KEY) => ({ repo: FINDINGS, findingPath, key, prUrl: `https://github.com/${SITE_REPO}/pull/${pr}` });

function opened(result: OpenFixLogConfirmationResult) {
  assert.equal(result.state, 'opened', JSON.stringify(result));
  return result as Extract<OpenFixLogConfirmationResult, { state: 'opened' }>;
}

const data = (text: string | undefined) => parseFrontmatter(text ?? '').data as Record<string, any>;

async function merge(gh: FakeGitHub, o: ReturnType<typeof opened>) {
  gh.checkRuns.set(o.headSha, PASSING);
  return mergeFixLogConfirmation({ repo: o.repo, prNumber: o.prNumber, branch: o.branch, expectedHeadSha: o.headSha, path: o.path });
}

test('a confirmed fix: the confirmed fields are completed, the writing is kept, and Steward merges it', async () => {
  const gh = await stage();
  const before = gh.file('master', entryPath(KEY))!.text;
  const o = opened(await openFixLogConfirmation(input()));
  assert.match(o.branch, /^steward\/fix-log-confirm-mp-950-pr900-20261120t100000$/);
  const entry = data(gh.file(o.branch, o.path)?.text);
  assert.equal(entry.status, 'fixed');
  assert.equal(entry.confirmedBy, 'check');
  assert.equal(entry.verified, '2026-11-20T10:00:00.000Z');
  assert.deepEqual(entry.changes, [{ number: 900, title: 'fix: the about page', opened: '2026-11-19T04:00:00Z', merged: '2026-11-27T20:00:00Z' }]);
  assert.equal(entry.checks.length, 1);
  assert.equal(entry.checks[0].passed, true);
  const was = data(before);
  for (const k of ['title', 'slug', 'lead', 'measures', 'found', 'approved', 'where']) assert.deepEqual(entry[k], was[k], k);
  assert.equal(parseFrontmatter(gh.file(o.branch, o.path)!.text).content.trim(), GOOD.story);
  assert.deepEqual(Object.keys(entry).slice(0, 14), ['key', 'title', 'slug', 'lead', 'type', 'kind', 'status', 'confirmedBy', 'where', 'visual', 'found', 'approved', 'verified', 'changes']);

  const outcome = await merge(gh, o);
  assert.deepEqual(outcome, { merged: true, mergeSha: `merge-${o.prNumber}` });
  assert.equal(data(gh.file('master', entryPath(KEY))?.text).verified, '2026-11-20T10:00:00.000Z');
});

test('a reopened fix: status reopened, and the failed check as production ran it', async () => {
  const gh = await stage({ finding: verifiedFinding({ status: 'reopened', verification: REOPENED_VERIFICATION('2026-11-20T10:00:00.000Z') }) });
  const o = opened(await openFixLogConfirmation(input()));
  const entry = data(gh.file(o.branch, o.path)?.text);
  assert.equal(entry.status, 'reopened');
  assert.equal(entry.checks[0].passed, false);
  assert.equal(entry.checks[0].measured, '1 occurrence');
  assert.deepEqual(await merge(gh, o), { merged: true, mergeSha: `merge-${o.prNumber}` });
});

test('a later attempt on a reopened finding adds its PR to changes and confirms again', async () => {
  const gh = await stage({ finding: verifiedFinding({ status: 'reopened', verification: REOPENED_VERIFICATION('2026-11-20T10:00:00.000Z') }), prs: [900, 901] });
  const first = opened(await openFixLogConfirmation(input(900)));
  await merge(gh, first);
  // The second attempt: PR 901 merged, the finding's links.pr names it, and production now passes.
  gh.push('main', FINDING_PATH, findingText(KEY, { pr: 901 }).replace('2026-11-20T10:00:00.000Z', '2026-11-22T09:00:00.000Z'), 'the second verify');
  const second = opened(await openFixLogConfirmation(input(901)));
  const entry = data(gh.file(second.branch, second.path)?.text);
  assert.equal(entry.status, 'fixed');
  assert.equal(entry.verified, '2026-11-22T09:00:00.000Z');
  assert.deepEqual(entry.changes.map((c: { number: number; merged?: string }) => [c.number, Boolean(c.merged)]), [[900, true], [901, true]]);
  assert.deepEqual(await merge(gh, second), { merged: true, mergeSha: `merge-${second.prNumber}` });
});

test('an entry that is not on master makes the step do nothing', async () => {
  const gh = await stage({ entry: null });
  assert.deepEqual(await openFixLogConfirmation(input()), { state: 'skipped', reason: 'src/content/fixes/mp-950.md is not on master' });
  assert.equal(gh.pulls.length, 1, 'no pull request opened');
});

test('an entry already confirmed for this PR by this verify makes the step do nothing', async () => {
  const gh = await stage();
  await merge(gh, opened(await openFixLogConfirmation(input())));
  const again = await openFixLogConfirmation(input());
  // The merged confirmation is found on its own branch first.
  assert.equal(again.state, 'merged');
  // A new branch name (a person deleted it) still finds the entry confirmed.
  gh.pulls.splice(1);
  const fresh = await openFixLogConfirmation(input());
  assert.deepEqual(fresh, { state: 'skipped', reason: 'the entry is already confirmed for PR 900 by this verify' });
});

test('a finding with no verification on production makes the step do nothing', async () => {
  await stage({ finding: findingText(KEY, { status: 'fixing', verified: false }) });
  assert.deepEqual(await openFixLogConfirmation(input()), { state: 'skipped', reason: 'the finding holds no verification on production' });
});

test('a fix confirmed by its deploy reads confirmedBy deploy', async () => {
  const deployed = findingText(KEY, { verified: false }).replace('status: resolved', 'status: resolved\nresolved_by: deploy')
    + "\n## Verification\n\nSteward confirmed this finding's fix by its deploy at 2026-11-20T10:00:00.000Z. Outcome: confirmed.\n";
  const gh = await stage({ finding: deployed });
  const o = opened(await openFixLogConfirmation(input()));
  assert.equal(data(gh.file(o.branch, o.path)?.text).confirmedBy, 'deploy');
});

test('a retry of the open finds its own pull request', async () => {
  const gh = await stage();
  const first = opened(await openFixLogConfirmation(input()));
  const second = opened(await openFixLogConfirmation(input()));
  assert.equal(second.prNumber, first.prNumber);
  assert.equal(second.reused, true);
  assert.equal(gh.pulls.length, 2, 'one confirmation pull request');
});

test('a diff that changes a writer field is left open for a person', async () => {
  const gh = await stage();
  const o = opened(await openFixLogConfirmation(input()));
  const text = gh.file(o.branch, o.path)!.text.replace(`title: ${GOOD.title}`, 'title: A title someone changed');
  gh.push(o.branch, o.path, text, 'a person edits the title');
  const outcome = await mergeFixLogConfirmation({ repo: o.repo, prNumber: o.prNumber, branch: o.branch, expectedHeadSha: await headOf(gh, o.branch), path: o.path });
  assert.deepEqual(outcome, { merged: false, condition: 'beyond-confirmation', detail: 'fields outside the confirmed ones changed: title' });
  assert.equal(gh.merges.length, 0);
});

test('a diff with another file is left open for a person', async () => {
  const gh = await stage();
  const o = opened(await openFixLogConfirmation(input()));
  gh.push(o.branch, 'src/pages/index.astro', 'something else', 'a second file');
  const outcome = await mergeFixLogConfirmation({ repo: o.repo, prNumber: o.prNumber, branch: o.branch, expectedHeadSha: await headOf(gh, o.branch), path: o.path });
  assert.equal(!outcome.merged && outcome.condition, 'extra-files');
  assert.equal(gh.merges.length, 0);
});

test('failing checks leave it open', async () => {
  const gh = await stage();
  const o = opened(await openFixLogConfirmation(input()));
  gh.checkRuns.set(o.headSha, [...PASSING, { name: 'Build', status: 'completed', conclusion: 'failure' }]);
  const outcome = await mergeFixLogConfirmation({ repo: o.repo, prNumber: o.prNumber, branch: o.branch, expectedHeadSha: o.headSha, path: o.path });
  assert.deepEqual(outcome, { merged: false, condition: 'checks-failed', detail: 'failing: Build' });
});

test('two confirmations opened at the same minute both merge: each touches its own file on its own branch', async () => {
  const other = 'MP-951';
  const otherPath = 'sites/mattpyle-com/findings/synthetic-mp-951.md';
  const gh = await stage({ prs: [900, 902] });
  gh.push('master', entryPath(other), draftEntry(other, 902), 'the other entry');
  gh.push('main', otherPath, verifiedFinding({ key: other, pr: 902 }), 'the other finding');
  const a = opened(await openFixLogConfirmation(input()));
  const b = opened(await openFixLogConfirmation(input(902, otherPath, other)));
  assert.deepEqual(await merge(gh, a), { merged: true, mergeSha: `merge-${a.prNumber}` });
  assert.deepEqual(await merge(gh, b), { merged: true, mergeSha: `merge-${b.prNumber}` });
  assert.ok(data(gh.file('master', entryPath(KEY))?.text).verified);
  assert.ok(data(gh.file('master', entryPath(other))?.text).verified);
});

test('the CLI path runs the open, two passing reads and the merge', async () => {
  const gh = await stage();
  gh.checkRuns.get = () => PASSING;
  const lines: string[] = [];
  const line = await confirmFixLogEntryNow(input(), { pollMs: 1, print: (l) => lines.push(l) });
  assert.match(line, /^src\/content\/fixes\/mp-950\.md confirmed in https:\/\/github\.com\/.+\/pull\/2, merged as merge-2$/);
  assert.match(lines[0], /^Opened /);
});

test('the diff rule: merge times and a new PR pass; a removed PR, a changed story and a changed title do not', () => {
  const base = draftEntry();
  const confirmedText = (edit: (d: Record<string, any>) => void, story = GOOD.story) => {
    const d = data(base);
    edit(d);
    return entryFileText(d, story);
  };
  assert.equal(confirmationDiffRefusal(base, confirmedText((d) => {
    d.verified = '2026-11-20T10:00:00.000Z';
    d.changes[0].merged = '2026-11-27T20:00:00Z';
    d.changes.push({ number: 901, title: 'again', opened: '2026-11-21T00:00:00Z' });
    d.status = 'reopened';
  })), null);
  assert.equal(confirmationDiffRefusal(base, confirmedText((d) => { d.changes = []; })), 'a pull request was removed from changes');
  assert.equal(confirmationDiffRefusal(base, confirmedText(() => undefined, 'Another story.')), 'the story changed');
  assert.equal(confirmationDiffRefusal(base, confirmedText((d) => { d.lead = 'New lead.'; })), 'fields outside the confirmed ones changed: lead');
  assert.equal(confirmationDiffRefusal(base, confirmedText((d) => { d.changes[0].title = 'renamed'; })), 'changes[0] changed beyond its merge time');
});

/** The fake's PR follows its branch: its head is the branch's last commit. */
function headOf(_gh: FakeGitHub, branch: string): Promise<string> {
  return branchSha(branch, SITE_REPO);
}
