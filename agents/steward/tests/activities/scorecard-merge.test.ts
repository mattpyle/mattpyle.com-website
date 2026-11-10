import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { mergeScorecardPr, publishScorecardRun, readScorecardPrChecks } from '../../src/activities/scorecard.js';
import { SCORECARD_RUNS_PATH } from '../../src/config.js';
import { REQUIRED_SCORECARD_CHECK, evaluateScorecardChecks, pullNumberFromUrl } from '../../src/lib/scorecard-merge.js';
import type { ScorecardRunRecord } from '../../src/lib/scorecard-aggregate.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';

/**
 * `mergeScorecardPr` and `readScorecardPrChecks` against a fake GitHub.
 *
 * Every refusal the merge leg has is one test here: the activity decides from
 * GitHub at merge time, so each condition is proved by changing what GitHub says
 * and watching that the merge request is never sent.
 */

const RUN: Omit<ScorecardRunRecord, 'id'> = {
  iso: '2026-11-10',
  timestamp: '2026-11-10T03:30:00-08:00',
  scope: '19 live pages',
  tools: ['Lighthouse 13.4', 'axe-core 4.12'],
  entry: 'Nightly · automated',
  commentary: 'All 19 pages passed all four public metrics.',
  metrics: [],
};

const GREEN = [
  { name: REQUIRED_SCORECARD_CHECK, status: 'completed', conclusion: 'success' },
  { name: 'build', status: 'completed', conclusion: 'success' },
];

let hub: FakeGitHub;
let branch: string;
let sha: string;
let number: number;

beforeEach(async () => {
  hub = installFakeGitHub({ seed: { [SCORECARD_RUNS_PATH]: '[]\n' } });
  const opened = await publishScorecardRun({ record: RUN, perPage: [] });
  branch = opened.branch;
  sha = opened.headSha!;
  number = opened.prNumber!;
  const pull = hub.pulls[0];
  pull.sha = sha;
  pull.files = [SCORECARD_RUNS_PATH];
  hub.checkRuns.set(sha, GREEN);
});

afterEach(() => {
  hub.restore();
});

const attempt = () => mergeScorecardPr({ prNumber: number, branch, expectedHeadSha: sha });

test('publish reports the pull request number, the head commit and that it committed', async () => {
  assert.equal(number, 1);
  assert.ok(sha);
  const again = await publishScorecardRun({ record: RUN, perPage: [] });
  assert.equal(again.committed, true);
  assert.equal(again.prNumber, 1);
});

test('all four conditions hold: a merge commit, with the head sha pinned', async () => {
  const outcome = await attempt();
  assert.deepEqual(outcome, { merged: true, mergeSha: 'merge-1' });
  assert.deepEqual(hub.merges, [{ number: 1, body: { merge_method: 'merge', sha } }]);
});

test('a second file in the diff is refused and nothing is sent', async () => {
  hub.pulls[0].files = [SCORECARD_RUNS_PATH, 'src/pages/index.astro'];
  const outcome = await attempt();
  assert.equal(outcome.merged, false);
  assert.equal(!outcome.merged && outcome.condition, 'extra-files');
  assert.match(!outcome.merged ? outcome.detail : '', /src\/pages\/index\.astro/);
  assert.equal(hub.merges.length, 0);
});

test('an empty diff is refused as well', async () => {
  hub.pulls[0].files = [];
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'extra-files');
});

test('a head that moved off the run commit is refused', async () => {
  hub.pulls[0].sha = 'someone-elses-commit';
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'head-moved');
  assert.equal(hub.merges.length, 0);
});

test('a failed check is refused, naming it', async () => {
  hub.checkRuns.set(sha, [...GREEN, { name: 'axe', status: 'completed', conclusion: 'failure' }]);
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'checks-failed');
  assert.match(!outcome.merged ? outcome.detail : '', /axe/);
  assert.equal(hub.merges.length, 0);
});

test('a check still running is refused as pending', async () => {
  hub.checkRuns.set(sha, [...GREEN, { name: 'Vercel', status: 'in_progress', conclusion: null }]);
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'checks-pending');
  assert.match(!outcome.merged ? outcome.detail : '', /Vercel/);
});

test('green checks without the required one are pending, not passing', async () => {
  hub.checkRuns.set(sha, [{ name: 'build', status: 'completed', conclusion: 'success' }]);
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'checks-pending');
  assert.match(!outcome.merged ? outcome.detail : '', new RegExp(REQUIRED_SCORECARD_CHECK));
});

test('no check runs yet is pending', async () => {
  hub.checkRuns.delete(sha);
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'checks-pending');
});

test('GitHub refusing the merge keeps GitHub\'s own message', async () => {
  hub.pulls[0].refuseMerge = { status: 405, message: 'Repository rule violations found: 1 of 1 required status check is expected.' };
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'github-refused');
  assert.match(!outcome.merged ? outcome.detail : '', /405: Repository rule violations found/);
  assert.equal(hub.merges.length, 1, 'the merge was attempted once');
});

test('a 403 refusal is read, not thrown as an auth failure', async () => {
  hub.pulls[0].refuseMerge = { status: 403, message: 'Resource not accessible by integration' };
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'github-refused');
  assert.match(!outcome.merged ? outcome.detail : '', /Resource not accessible by integration/);
});

test('a pull request already merged from the run commit returns its merge commit and sends nothing', async () => {
  Object.assign(hub.pulls[0], { merged: true, state: 'closed' as const, mergeSha: 'merge-lost-reply' });
  const outcome = await attempt();
  assert.deepEqual(outcome, { merged: true, mergeSha: 'merge-lost-reply' });
  assert.equal(hub.merges.length, 0);
});

test('a merge that happened from a different head is not the run\'s success', async () => {
  Object.assign(hub.pulls[0], { merged: true, state: 'closed' as const, mergeSha: 'm', sha: 'other' });
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'head-moved');
});

test('the archive branch is not this run\'s pull request, whatever its name matches', async () => {
  hub.pulls[0].head = 'steward/scorecard-archive';
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'wrong-pr');
  assert.equal(hub.merges.length, 0);
});

test('a pull request into another base is refused', async () => {
  hub.pulls[0].base = 'release';
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'wrong-pr');
});

test('a pull request from a fork is refused', async () => {
  hub.pulls[0].headRepo = 'someone/mattpyle.com-website';
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'wrong-pr');
});

test('a closed, unmerged pull request is refused', async () => {
  hub.pulls[0].state = 'closed';
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'wrong-pr');
  assert.match(!outcome.merged ? outcome.detail : '', /closed/);
});

test('a draft pull request is refused', async () => {
  hub.pulls[0].draft = true;
  const outcome = await attempt();
  assert.equal(!outcome.merged && outcome.condition, 'wrong-pr');
});

test('the check read is for the exact commit', async () => {
  const checks = await readScorecardPrChecks(sha);
  assert.equal(checks.state, 'passing');
  assert.ok(hub.calls.includes(`GET /commits/${sha}/check-runs`));
});

test('the check rules: failure beats pending, skipped is not a failure, the required check must succeed', () => {
  const required = { name: REQUIRED_SCORECARD_CHECK, status: 'completed', conclusion: 'success' };
  assert.equal(evaluateScorecardChecks([required, { name: 'a', status: 'completed', conclusion: 'skipped' }]).state, 'passing');
  assert.equal(evaluateScorecardChecks([required, { name: 'a', status: 'queued', conclusion: null }]).state, 'pending');
  assert.equal(
    evaluateScorecardChecks([required, { name: 'a', status: 'queued', conclusion: null }, { name: 'b', status: 'completed', conclusion: 'cancelled' }]).state,
    'failing',
  );
  assert.equal(evaluateScorecardChecks([{ ...required, conclusion: 'neutral' }]).state, 'pending');
  assert.equal(evaluateScorecardChecks([]).state, 'pending');
});

test('the pull request number is the last segment of its URL', () => {
  assert.equal(pullNumberFromUrl('https://github.com/mattpyle/mattpyle.com-website/pull/812'), 812);
  assert.equal(pullNumberFromUrl('https://github.com/o/r/issues/3'), undefined);
});
