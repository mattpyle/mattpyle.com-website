import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING, DEFECT_KEY } from '../helpers/finding-fixtures.js';
import { awaitPrPreview, reportPreviewChecks } from '../../src/activities/findings.js';
import {
  FIX_ISSUE_VERIFY_HEADING,
  PREVIEW_CHECKS_MARKER,
  fixIssueBody,
  fixIssueMarker,
  previewChecksComment,
  previewResultLine,
  verifyBlockSource,
  type PreviewCheckRow,
  type PreviewChecksReport,
} from '../../src/lib/findings.js';

/**
 * The pieces of the fix PR's preview test (fix-pr-runs-the-verify-block): the
 * verify block in the fix issue, the PR comment and the status line, the
 * preview wait, and the write that posts the comment once and drafts the PR.
 */

const SITE = 'mattpyle-com';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR_NUMBER = 7;
const PR = `https://github.com/${SITE_REPO}/pull/${PR_NUMBER}`;
const PREVIEW = 'https://mattpyle-com-website-abc123-mattpyles-projects.vercel.app';

let fake: FakeGitHub | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function stage(): FakeGitHub {
  fake = installFakeGitHub({ defaultBranch: 'main' });
  fake.pulls.push({ number: PR_NUMBER, head: 'claude/issue-5-x', base: 'master', title: 'Fix', body: '', draft: false, sha: 'abcdef1234567' });
  return fake;
}

const PASS: PreviewCheckRow = {
  n: 1,
  url: 'https://www.mattpyle.com/a/',
  kind: 'status',
  pass: true,
  expected: 'status 200',
  measured: 'status 200',
};
const FAIL: PreviewCheckRow = {
  n: 2,
  url: ['https://www.mattpyle.com/b/', 'https://www.mattpyle.com/c/'],
  kind: 'text',
  pass: false,
  expected: '0 occurrences of "filter widgets"',
  measured: '1 of 2 URLs failed: /b/ had 1 occurrence',
};

const report = (results: PreviewCheckRow[] | null, note: string | null = null): PreviewChecksReport => ({
  prUrl: PR,
  sha: 'abcdef1234567',
  results,
  note,
});

// ---------------------------------------------------------------------------
// The verify block in the fix issue
// ---------------------------------------------------------------------------

const BLOCK = [
  'verify:',
  '  # the claim, in the past tense',
  '  - url: "https://www.mattpyle.com/writing/a/"',
  '    kind: text',
  '    expect:',
  '      count: 0',
  '      of: "filter widgets — one on <code>/writing</code>"',
  '',
  '  - url:',
  '      - "https://www.mattpyle.com/"',
  '      - "https://www.mattpyle.com/builds/"',
  '    kind: status',
  '    expect: 200',
].join('\n');

function findingWith(frontmatterTail: string): string {
  return DEFECT_FINDING.replace('references: []', ['references: []', frontmatterTail].join('\n'));
}

test('the fix issue carries the finding\'s verify block verbatim, under a heading that says when it runs', () => {
  const body = fixIssueBody(SITE, DEFECT_KEY, findingWith(BLOCK), 'Approved.');
  assert.equal(verifyBlockSource(findingWith(BLOCK)), BLOCK, 'the block as written, comments and quoting included');
  assert.ok(body.includes(`\n${FIX_ISSUE_VERIFY_HEADING}\n`), 'the heading');
  assert.ok(body.includes(['```yaml', BLOCK, '```'].join('\n')), 'the block in a fence, byte for byte');
  assert.match(body, /on this PR's Vercel preview before the merge, and on production after it/);
  assert.match(body, /Search your tree for every needle/);
  // The marker is still last, and the Verdict line is where it was.
  assert.ok(body.trimEnd().endsWith(fixIssueMarker(SITE, DEFECT_KEY)));
  const lines = body.split('\n');
  assert.equal(lines[8], 'Verdict: approved.');
  assert.ok(body.indexOf(FIX_ISSUE_VERIFY_HEADING) > body.indexOf('## How to measure'), 'after the finding\'s own sections');
});

test('the block ends at the next top-level key of the frontmatter', () => {
  const text = findingWith([BLOCK, 'links:', '  comment: https://example.com/c/1'].join('\n'));
  assert.equal(verifyBlockSource(text), BLOCK);
  // A sequence at the key's own indent belongs to it.
  const flat = findingWith(['verify:', '- url: "https://www.mattpyle.com/"', '  kind: status', '  expect: 200', 'priority: low'].join('\n'));
  assert.equal(verifyBlockSource(flat), ['verify:', '- url: "https://www.mattpyle.com/"', '  kind: status', '  expect: 200'].join('\n'));
});

test('a finding with no verify block, or an empty one, gets the issue it always got', () => {
  const plain = fixIssueBody(SITE, DEFECT_KEY, DEFECT_FINDING, 'Approved.');
  assert.ok(!plain.includes(FIX_ISSUE_VERIFY_HEADING));
  assert.equal(verifyBlockSource(DEFECT_FINDING), null);
  assert.equal(fixIssueBody(SITE, DEFECT_KEY, findingWith('verify: []'), 'Approved.'), plain);
  assert.equal(fixIssueBody(SITE, DEFECT_KEY, findingWith('verify: [] # unmeasurable'), 'Approved.'), plain);
});

// ---------------------------------------------------------------------------
// The comment and the status line
// ---------------------------------------------------------------------------

test('the comment lists each check with its expected and measured value, and says a failure drafts the PR', () => {
  const comment = previewChecksComment(report([PASS, FAIL]));
  assert.ok(comment.startsWith(`${PREVIEW_CHECKS_MARKER}\n`));
  assert.match(comment, /for commit `abcdef1`/);
  assert.match(comment, /\*\*Check 2 fails on the preview\.\*\* Steward marks this PR a draft\./);
  assert.match(comment, /1\. `status` https:\/\/www\.mattpyle\.com\/a\/\n {3}- Expects: status 200\n {3}- Measured: status 200\n {3}- Pass\./);
  assert.match(comment, /2\. `text` 2 URLs \(.*\/b\/, .*\/c\/\)\n {3}- Expects: 0 occurrences of "filter widgets"\n {3}- Measured: 1 of 2 URLs failed/);
  assert.match(comment, /- Fail\.\n$/);
});

test('the comment for a clean run says so and names no draft; an unmeasured one gives the reason', () => {
  const clean = previewChecksComment(report([PASS]));
  assert.match(clean, /\*\*All 1 check passes on the preview\.\*\*/);
  assert.ok(!clean.includes('draft'));
  const unmeasured = previewChecksComment({ ...report(null, 'No Preview deployment of the PR head was ready within 30 minutes.'), sha: null });
  assert.match(unmeasured, /\*\*The preview was not measured\.\*\* No Preview deployment .* The same checks run on production after the merge\./);
  assert.ok(!unmeasured.includes('commit `'));
});

test('the status line is one line for each outcome', () => {
  assert.equal(previewResultLine(report([PASS, PASS])), '2 of 2 checks pass on the preview');
  assert.equal(previewResultLine(report([PASS])), '1 of 1 check passes on the preview');
  assert.equal(previewResultLine(report([PASS, FAIL])), 'check 2 of 2 fails on the preview; PR marked draft');
  assert.equal(
    previewResultLine(report([{ ...PASS, pass: false }, { ...PASS, n: 2 }, { ...FAIL, n: 3 }])),
    'checks 1 and 3 of 3 fail on the preview; PR marked draft',
  );
  assert.equal(previewResultLine(report(null, 'the build failed')), 'unmeasured: the build failed');
});

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

test('a failing check posts one comment and drafts the PR; a retry posts nothing more and leaves the draft', async () => {
  const gh = stage();
  const first = await reportPreviewChecks({ ...report([PASS, FAIL]), key: DEFECT_KEY });
  assert.deepEqual(first, { posted: true, failed: [2], draft: true });
  assert.equal(gh.pulls[0].comments?.length, 1);
  assert.equal(gh.pulls[0].draft, true);

  const again = await reportPreviewChecks({ ...report([PASS, FAIL]), key: DEFECT_KEY });
  assert.deepEqual(again, { posted: false, failed: [2], draft: true });
  assert.equal(gh.pulls[0].comments?.length, 1, 'the marker stops a second comment');
  assert.equal(gh.calls.filter((c) => c === 'POST /graphql').length, 1, 'a draft is not converted twice');
});

test('a clean run posts its comment and leaves the PR ready', async () => {
  const gh = stage();
  const result = await reportPreviewChecks({ ...report([PASS]), key: DEFECT_KEY });
  assert.deepEqual(result, { posted: true, failed: [], draft: false });
  assert.equal(gh.pulls[0].draft, false);
  assert.ok(!gh.calls.includes('POST /graphql'));
});

test('an unmeasured preview posts the reason and drafts nothing', async () => {
  const gh = stage();
  const result = await reportPreviewChecks({ ...report(null, 'the build failed'), key: DEFECT_KEY });
  assert.deepEqual(result, { posted: true, failed: [], draft: false });
  assert.match(gh.pulls[0].comments?.[0] ?? '', /not measured\.\*\* the build failed/);
  assert.equal(gh.pulls[0].draft, false);
});

test('a PR a person already merged or closed is commented on but not drafted', async () => {
  const gh = stage();
  gh.pulls[0].state = 'closed';
  const result = await reportPreviewChecks({ ...report([FAIL]), key: DEFECT_KEY });
  assert.deepEqual(result, { posted: true, failed: [2], draft: false });
  assert.ok(!gh.calls.includes('POST /graphql'), 'GitHub refuses the mutation on a closed PR');
});

test('a PR already a draft is left a draft and the call still succeeds', async () => {
  const gh = stage();
  gh.pulls[0].draft = true;
  const result = await reportPreviewChecks({ ...report([FAIL]), key: DEFECT_KEY });
  assert.equal(result.draft, true);
  assert.ok(!gh.calls.includes('POST /graphql'));
});

// ---------------------------------------------------------------------------
// The preview wait
// ---------------------------------------------------------------------------

async function rejectsWith(promise: Promise<unknown>, type: string, nonRetryable: boolean): Promise<void> {
  let caught: unknown;
  await promise.catch((err) => {
    caught = err;
  });
  assert.ok(caught instanceof ApplicationFailure, `expected an ApplicationFailure, got ${String(caught)}`);
  assert.equal(caught.type, type);
  assert.equal(caught.nonRetryable, nonRetryable);
}

const wait = () => awaitPrPreview({ prUrl: PR, environment: 'Preview' });

test('the preview wait reads the PR head and answers not-yet until Vercel reports the preview ready', async () => {
  const gh = stage();
  await rejectsWith(wait(), 'PreviewNotReady', false);
  gh.deployments.push({ id: 1, sha: 'abcdef1234567', environment: 'Preview', statuses: [{ state: 'pending' }] });
  await rejectsWith(wait(), 'PreviewNotReady', false);
  gh.deployments[0].statuses.unshift({ state: 'success', environment_url: `${PREVIEW}/` });
  assert.deepEqual(await wait(), { origin: PREVIEW, deploymentId: 1, sha: 'abcdef1234567' });
});

test('a push after the PR opened moves the wait to the new head', async () => {
  const gh = stage();
  gh.deployments.push({ id: 1, sha: 'abcdef1234567', environment: 'Preview', statuses: [{ state: 'success', environment_url: PREVIEW }] });
  gh.pulls[0].sha = 'fedcba7654321';
  await rejectsWith(wait(), 'PreviewNotReady', false);
  gh.deployments.unshift({ id: 2, sha: 'fedcba7654321', environment: 'Preview', statuses: [{ state: 'success', environment_url: 'https://second.vercel.app' }] });
  assert.deepEqual(await wait(), { origin: 'https://second.vercel.app', deploymentId: 2, sha: 'fedcba7654321' });
});

test('a preview build that failed is a permanent answer', async () => {
  const gh = stage();
  gh.deployments.push({ id: 1, sha: 'abcdef1234567', environment: 'Preview', statuses: [{ state: 'failure' }] });
  await rejectsWith(wait(), 'PreviewFailed', true);
});
