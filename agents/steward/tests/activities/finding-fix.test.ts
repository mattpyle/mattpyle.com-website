import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { writeFindingFix, type WriteFindingFixInput } from '../../src/activities/findings.js';
import { openFixerPr, type OpenFixerPrInput } from '../../src/activities/fixer.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { DEFECT_FINDING, DEFECT_HANDOFF, DEFECT_KEY } from '../helpers/finding-fixtures.js';

/**
 * The fixer's two GitHub activities against the fake: the write back to the
 * finding (the same two-writer contract as the verdict write, design decision
 * 19) and the PR, a draft when the run was incomplete.
 */

const REPO = 'mattpyle/argus';
const FINDING = `sites/mattpyle-com/findings/${DEFECT_KEY}.md`;
const INDEX = 'sites/mattpyle-com/findings/INDEX.md';
const PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/312';

const INDEX_TEXT = [
  '# Findings index',
  '',
  'One line per finding, maintained by Argus: `key | status | kind | scenario | title | verdict reason`.',
  '',
  `${DEFECT_KEY} | approved | defect | defect-hunt | A row reads "100/100 (Fail)" | Approved by Matt.`,
  '',
].join('\n');

let fake: FakeGitHub | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function seed(finding: string = DEFECT_FINDING): FakeGitHub {
  fake = installFakeGitHub({ defaultBranch: 'main', seed: { [FINDING]: finding, [INDEX]: INDEX_TEXT } });
  return fake;
}

function input(overrides: Partial<WriteFindingFixInput> = {}): WriteFindingFixInput {
  return { repo: REPO, site: 'mattpyle-com', key: DEFECT_KEY, findingPath: FINDING, indexPath: INDEX, prUrl: PR, ...overrides };
}

test('the write back sets status fixing and links.pr in the file, and fixing in the index line', async () => {
  const gh = seed();
  const result = await writeFindingFix(input());

  const { data, content } = parseFrontmatter(gh.file('main', FINDING)!.text);
  assert.equal(data.status, 'fixing');
  assert.deepEqual(data.links, { pr: PR });
  assert.equal(data.verdict_source, 'cli', 'the verdict fields are untouched');
  assert.equal(content, parseFrontmatter(DEFECT_FINDING).content, 'the body is untouched');

  assert.equal(
    gh.file('main', INDEX)!.text.split('\n')[4],
    `${DEFECT_KEY} | fixing | defect | defect-hunt | A row reads "100/100 (Fail)" | Approved by Matt.`,
  );
  assert.ok(result.findingCommitSha && result.indexCommitSha);
  assert.equal(result.commitSha, result.indexCommitSha);
  assert.ok(gh.repos.every((repo) => repo === REPO), 'every call addressed the findings repository');
});

test('a second write back makes no commit', async () => {
  const gh = seed();
  await writeFindingFix(input());
  const puts = () => gh.calls.filter((c) => c.startsWith('PUT')).length;
  const afterFirst = puts();
  const again = await writeFindingFix(input());
  assert.equal(puts(), afterFirst);
  assert.equal(again.commitSha, null);
});

test('a concurrent push between read and write is retryable, and the retry lands on top of it', async () => {
  const gh = seed();
  const realFetch = globalThis.fetch;
  const pushed = DEFECT_FINDING.replace('last_run: 2026-09-28T0730Z', 'last_run: 2026-10-10T0830Z');
  let pushedOnce = false;
  // Argus pushes to the finding right after the activity reads it, once.
  globalThis.fetch = (async (req: any, init?: RequestInit) => {
    const res = await realFetch(req, init);
    const url = String(typeof req === 'string' ? req : req.url);
    if (!pushedOnce && (init?.method ?? 'GET') === 'GET' && url.includes(encodeURI(FINDING))) {
      pushedOnce = true;
      gh.branches.get('main')!.set(FINDING, { text: pushed, sha: 'sha-argus-push' });
    }
    return res;
  }) as typeof fetch;

  await assert.rejects(writeFindingFix(input()), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err instanceof ApplicationFailure && err.nonRetryable, false, 'a sha mismatch is retried from a fresh read');
    assert.match(err.message, /409/);
    return true;
  });

  await writeFindingFix(input());
  const text = gh.file('main', FINDING)!.text;
  assert.match(text, /last_run: 2026-10-10T0830Z/, "Argus's change survived");
  assert.match(text, /^status: fixing$/m);
});

test('a finding somebody else moved is not overruled', async () => {
  const gh = seed(DEFECT_FINDING.replace('status: approved', 'status: resolved'));
  await assert.rejects(writeFindingFix(input()), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure && err.nonRetryable);
    assert.equal(err.type, 'FindingMoved');
    assert.match(err.message, /is resolved, not approved/);
    assert.ok(err.message.includes(PR), 'the refusal names the PR, which stays open');
    return true;
  });
  assert.equal(gh.calls.filter((c) => c.startsWith('PUT')).length, 0);
});

test('a missing finding file is a non-retryable failure', async () => {
  seed();
  await assert.rejects(writeFindingFix(input({ findingPath: 'sites/mattpyle-com/findings/gone.md' })), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure && err.nonRetryable);
    assert.equal(err.type, 'FindingMissing');
    return true;
  });
});

// --- openFixerPr -------------------------------------------------------------

function prInput(overrides: Partial<OpenFixerPrInput> = {}): OpenFixerPrInput {
  return {
    key: DEFECT_KEY,
    findingText: DEFECT_FINDING,
    handoff: DEFECT_HANDOFF,
    branch: `fix/finding-${DEFECT_KEY}`,
    base: 'master',
    filesChanged: ['agents/steward/src/workflows/scorecard-audit.ts'],
    checks: [{ n: 1, status: 'pass', command: 'npm test -w @mattpyle/steward' }],
    exitCode: 0,
    timedOut: false,
    ...overrides,
  };
}

test('a finished run opens a ready PR titled from the handoff, with the body from the finding', async () => {
  fake = installFakeGitHub();
  const result = await openFixerPr(prInput());
  assert.equal(result.draft, false);
  assert.equal(fake.pulls.length, 1);
  const pull = fake.pulls[0];
  assert.equal(pull.head, `fix/finding-${DEFECT_KEY}`);
  assert.equal(pull.base, 'master');
  assert.equal(pull.draft, false);
  assert.equal(pull.title, 'Name the failing reason in scorecard commentary');
  assert.match(pull.body, /^Fixes one finding from Argus/);
  assert.match(pull.body, /- Result: pass\n   - Command: `npm test -w @mattpyle\/steward`/);
});

test('a non-zero exit with changes present opens a draft PR marked incomplete', async () => {
  fake = installFakeGitHub();
  const result = await openFixerPr(prInput({ exitCode: 1, checks: [] }));
  assert.equal(result.draft, true);
  assert.equal(fake.pulls[0].draft, true);
  assert.match(fake.pulls[0].body, /^> \*\*Incomplete run\.\*\* Claude Code exited 1\./);
  assert.match(fake.pulls[0].body, /- Result: not reported/);
});

test('a run killed at its time limit opens a draft PR that says so', async () => {
  fake = installFakeGitHub();
  const result = await openFixerPr(prInput({ exitCode: -1, timedOut: true }));
  assert.equal(result.draft, true);
  assert.match(fake.pulls[0].body, /^> \*\*Incomplete run\.\*\* Claude Code was stopped at its time limit\./);
});

test('a re-run updates the PR already open on the branch', async () => {
  fake = installFakeGitHub();
  const first = await openFixerPr(prInput());
  const second = await openFixerPr(prInput({ filesChanged: ['a.ts', 'b.ts'] }));
  assert.equal(fake.pulls.length, 1);
  assert.equal(second.prUrl, first.prUrl);
  assert.match(fake.pulls[0].body, /- `b\.ts`/);
});
