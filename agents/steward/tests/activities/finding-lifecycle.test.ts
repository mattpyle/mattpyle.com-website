import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { awaitFixPrMerge, awaitProductionDeploy, writeFindingReturned } from '../../src/activities/findings.js';
import { compareContains, liveDeployment, setFindingReturned } from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { DEFECT_KEY, FIXING_FINDING, FIX_PR } from '../helpers/finding-fixtures.js';

/**
 * The lifecycle's activities: the merge wait and the deploy wait against a
 * scripted GitHub, and the closed-PR write back against the fake Contents API.
 * Each wait's "not yet" must be a retryable failure of its named type, since
 * the workflow's retry policy is the polling loop.
 */

const SITE_REPO = 'mattpyle/mattpyle.com-website';
const FINDING = `sites/mattpyle-com/findings/${DEFECT_KEY}.md`;
const INDEX = 'sites/mattpyle-com/findings/INDEX.md';
const AT = '2026-10-13T19:00:00.000Z';

const realFetch = globalThis.fetch;
const previousToken = process.env.GITHUB_TOKEN;
let fake: FakeGitHub | undefined;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousToken;
  fake?.restore();
  fake = undefined;
});

/** Answers GitHub paths from a map; anything else is a loud failure. */
function scriptGitHub(routes: Record<string, unknown>): string[] {
  const calls: string[] = [];
  process.env.GITHUB_TOKEN = 'fake-token-for-tests';
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    const path = `${u.pathname}${u.search}`;
    calls.push(path);
    if (!(path in routes)) throw new Error(`no scripted route for ${path}`);
    return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

async function rejectsWith(promise: Promise<unknown>, type: string, nonRetryable: boolean): Promise<ApplicationFailure> {
  let caught: unknown;
  await promise.catch((err) => {
    caught = err;
  });
  assert.ok(caught instanceof ApplicationFailure, `expected an ApplicationFailure, got ${String(caught)}`);
  assert.equal(caught.type, type);
  assert.equal(caught.nonRetryable, nonRetryable);
  return caught;
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

test('the live deployment is the newest success, skipping newer pending or failed ones', () => {
  assert.equal(
    liveDeployment([
      { id: 3, sha: 'c3', state: 'in_progress' },
      { id: 2, sha: 'c2', state: 'failure' },
      { id: 1, sha: 'c1', state: 'success' },
    ])?.sha,
    'c1',
  );
  assert.equal(liveDeployment([{ id: 1, sha: 'c1', state: 'pending' }]), undefined);
});

test('a compare contains the merge commit when the live commit is identical or ahead', () => {
  assert.equal(compareContains('identical'), true);
  assert.equal(compareContains('ahead'), true);
  assert.equal(compareContains('behind'), false);
  assert.equal(compareContains('diverged'), false);
});

test('the return write sets approved and adds one note per closed PR, idempotently', () => {
  const once = setFindingReturned(FIXING_FINDING, FIX_PR, AT);
  assert.equal(parseFrontmatter(once).data.status, 'approved');
  assert.match(once, /\n## Fix attempts\n\n- 2026-10-13T19:00:00.000Z: https:\/\/github.com\/.+\/pull\/312 closed unmerged\. The finding is approved again\.\n$/);
  assert.equal(setFindingReturned(once, FIX_PR, AT), once, 'a retry adds nothing');

  const second = setFindingReturned(once.replace('status: approved', 'status: fixing'), `${FIX_PR.slice(0, -3)}401`, '2026-10-14T01:00:00.000Z');
  const notes = second.split('\n').filter((line) => line.startsWith('- 2026-'));
  assert.equal(notes.length, 2, 'the earlier attempt stays');
  assert.match(notes[1], /pull\/401 closed unmerged/);
});

// ---------------------------------------------------------------------------
// The merge wait
// ---------------------------------------------------------------------------

test('an open PR is a retryable PrStillOpen', async () => {
  scriptGitHub({ [`/repos/${SITE_REPO}/pulls/312`]: { state: 'open', merged: false } });
  await rejectsWith(awaitFixPrMerge(FIX_PR), 'PrStillOpen', false);
});

test('a merged PR returns its merge commit, and a closed one returns closed with none', async () => {
  scriptGitHub({
    [`/repos/${SITE_REPO}/pulls/312`]: { state: 'closed', merged: true, merge_commit_sha: 'abc123', merged_at: AT },
  });
  assert.deepEqual(await awaitFixPrMerge(FIX_PR), { prUrl: FIX_PR, state: 'merged', mergeSha: 'abc123', at: AT });

  scriptGitHub({ [`/repos/${SITE_REPO}/pulls/312`]: { state: 'closed', merged: false, closed_at: AT } });
  assert.deepEqual(await awaitFixPrMerge(FIX_PR), { prUrl: FIX_PR, state: 'closed', mergeSha: null, at: AT });
});

test('a URL that is not a PR fails at once rather than polling for a month', async () => {
  await rejectsWith(awaitFixPrMerge('https://github.com/mattpyle/argus/issues/3'), 'FindingMalformed', true);
});

// ---------------------------------------------------------------------------
// The deploy wait
// ---------------------------------------------------------------------------

const DEPLOYS = `/repos/${SITE_REPO}/deployments?environment=Production&per_page=10`;
const status = (id: number) => `/repos/${SITE_REPO}/deployments/${id}/statuses?per_page=1`;
const input = { repo: SITE_REPO, mergeSha: 'm1', environment: 'Production' };

test('production serving the merge commit itself ends the wait without a compare', async () => {
  const calls = scriptGitHub({ [DEPLOYS]: [{ id: 7, sha: 'm1' }], [status(7)]: [{ state: 'success' }] });
  assert.deepEqual(await awaitProductionDeploy(input), { liveSha: 'm1', deploymentId: 7 });
  assert.ok(!calls.some((c) => c.includes('/compare/')));
});

test('a later live commit that contains the merge ends the wait: the two-merges case', async () => {
  const calls = scriptGitHub({
    [DEPLOYS]: [{ id: 9, sha: 'm2' }, { id: 8, sha: 'm1' }],
    [status(9)]: [{ state: 'success' }],
    [`/repos/${SITE_REPO}/compare/m1...m2`]: { status: 'ahead' },
  });
  assert.deepEqual(await awaitProductionDeploy(input), { liveSha: 'm2', deploymentId: 9 });
  assert.ok(!calls.includes(status(8)), 'nothing older than the live deployment is read');
});

test('a live commit that predates the merge, or none at all, is a retryable DeployNotLive', async () => {
  scriptGitHub({
    [DEPLOYS]: [{ id: 8, sha: 'm1' }, { id: 6, sha: 'old' }],
    [status(8)]: [{ state: 'in_progress' }],
    [status(6)]: [{ state: 'success' }],
    [`/repos/${SITE_REPO}/compare/m1...old`]: { status: 'behind' },
  });
  const err = await rejectsWith(awaitProductionDeploy(input), 'DeployNotLive', false);
  assert.match(err.message, /serves old, which does not contain m1 \(behind\)/);

  scriptGitHub({ [DEPLOYS]: [] });
  await rejectsWith(awaitProductionDeploy(input), 'DeployNotLive', false);
});

// ---------------------------------------------------------------------------
// The closed-PR write back
// ---------------------------------------------------------------------------

const INDEX_TEXT = [
  '# Findings index',
  '',
  `${DEFECT_KEY} | fixing | defect | defect-hunt | A row reads "100/100 (Fail)" | Approved by Matt.`,
  '',
].join('\n');

const returnInput = {
  repo: 'mattpyle/argus',
  site: 'mattpyle-com',
  key: DEFECT_KEY,
  findingPath: FINDING,
  indexPath: INDEX,
  prUrl: FIX_PR,
  at: AT,
};

test('a closed PR writes approved into the file and the index line, keeping the verdict reason', async () => {
  fake = installFakeGitHub({ defaultBranch: 'main', seed: { [FINDING]: FIXING_FINDING, [INDEX]: INDEX_TEXT } });
  const written = await writeFindingReturned(returnInput);
  assert.ok(written.findingCommitSha && written.indexCommitSha);
  assert.equal(parseFrontmatter(fake.file('main', FINDING)!.text).data.status, 'approved');
  assert.equal(
    fake.file('main', INDEX)!.text.split('\n')[2],
    `${DEFECT_KEY} | approved | defect | defect-hunt | A row reads "100/100 (Fail)" | Approved by Matt.`,
  );

  const again = await writeFindingReturned(returnInput);
  assert.equal(again.commitSha, null, 'a retry makes no commit');
});

test('a finding someone else moved is not overruled', async () => {
  fake = installFakeGitHub({
    defaultBranch: 'main',
    seed: { [FINDING]: FIXING_FINDING.replace('status: fixing', 'status: rejected'), [INDEX]: INDEX_TEXT },
  });
  await rejectsWith(writeFindingReturned(returnInput), 'FindingMoved', true);
});
