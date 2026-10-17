import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import proto from '@temporalio/proto';
import {
  applyHandVerifies,
  buildReportRow,
  costFromJobLog,
  countHumanComments,
  median,
  pickIssueRun,
  readRunGitHub,
  readRunHistory,
  readVerifyHistory,
  renderFindingReport,
  reportFooter,
  successAt,
  type GitHubReader,
  type HandVerify,
  type ReportRow,
  type RunFacts,
  type RunGitHub,
} from '../../src/lib/finding-report.js';

/**
 * The report's row builder: a recorded history and canned GitHub answers in,
 * minutes out, no network.
 *
 * `finding-resolved-action.bin` is a real run from Temporal Cloud: the
 * 2026-10-15 approve of `content-every-call-spends-requests-claim--steward`,
 * issue 363, PR 364, a production deploy and a `resolved` verify. The canned
 * answers are GitHub's for those objects, read the same day. Its history
 * completed the merge wait at 05:40:01, seven seconds after GitHub's
 * `merged_at`, which is why the minutes come from GitHub.
 * `finding-child-fix-returned.bin` is the replay suite's custom-fixer run,
 * and `verify-finding-blockless.bin` its verify from before decision 30.
 */

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/histories/${name}`, import.meta.url));
const load = async (name: string) => proto.temporal.api.history.v1.History.decode(await fs.readFile(fixture(name)));

const REPO = 'mattpyle/mattpyle.com-website';
const KEY = 'content-every-call-spends-requests-claim--steward';
const TITLE = '/steward says every accepted audit call spends a dozen requests at the target, but a repeat call in the same hour spends none';
const RESOLVED = 'finding-resolved-action.bin';

const CANNED: Record<string, unknown> = {
  [`/repos/${REPO}/issues/363`]: { created_at: '2026-10-16T05:32:55Z', title: TITLE },
  [`/repos/${REPO}/actions/workflows/claude.yml/runs?event=issues&created=${encodeURIComponent('>=2026-10-16T05:32:55Z')}&per_page=100`]:
    {
      workflow_runs: [
        { id: 38856492518, event: 'issue_comment', display_title: TITLE, created_at: '2026-10-16T05:34:35Z' },
        { id: 38856351134, event: 'issues', display_title: TITLE, created_at: '2026-10-16T05:32:57Z' },
      ],
    },
  [`/repos/${REPO}/actions/runs/38856351134/jobs?per_page=100`]: { jobs: [{ id: 116828574069 }] },
  [`/repos/${REPO}/pulls/364`]: { created_at: '2026-10-16T05:34:26Z', merged_at: '2026-10-16T05:39:54Z' },
  [`/repos/${REPO}/issues/364/comments?per_page=100`]: [{ user: { type: 'Bot', login: 'vercel[bot]' }, body: 'Preview ready' }],
  [`/repos/${REPO}/pulls/364/comments?per_page=100`]: [],
  [`/repos/${REPO}/pulls/364/reviews?per_page=100`]: [],
  [`/repos/${REPO}/deployments/7111872930/statuses?per_page=100`]: [{ state: 'success', created_at: '2026-10-16T05:40:24Z' }],
};

/** The tail of that run's job log: the Action's result block. */
const JOB_LOG = [
  '2026-10-16T05:34:34.2818650Z {',
  '2026-10-16T05:34:34.2818985Z   "type": "result",',
  '2026-10-16T05:34:34.2820223Z   "num_turns": 15,',
  '2026-10-16T05:34:34.2820592Z   "total_cost_usd": 0.12657490000000002,',
  '2026-10-16T05:34:34.2824720Z }',
].join('\n');

function cannedReader(log: string | null = JOB_LOG): GitHubReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async json(pathname) {
      asked.push(pathname);
      if (!(pathname in CANNED)) throw new Error(`no canned answer for ${pathname}`);
      return CANNED[pathname];
    },
    async text(pathname) {
      asked.push(pathname);
      assert.equal(pathname, `/repos/${REPO}/actions/jobs/116828574069/logs`);
      return log;
    },
  };
}

test('a resolved run is read from its history: the verdict, the issue, the PR, the deployment and the verify', async () => {
  const facts = readRunHistory(await load(RESOLVED));
  assert.equal(facts.workflowId, `finding/mattpyle-com/${KEY}`);
  assert.equal(facts.verdict?.status, 'approved');
  assert.equal(facts.verdictAt, '2026-10-16T05:32:51.003Z');
  assert.equal(facts.issueUrl, `https://github.com/${REPO}/issues/363`);
  assert.equal(facts.prUrl, `https://github.com/${REPO}/pull/364`);
  assert.equal(facts.deploymentId, 7111872930);
  assert.equal(facts.ranAt, '2026-10-16T05:42:09.651Z');
  assert.equal(facts.outcome, 'resolved');
});

test('a resolved run becomes a row of minutes, timed by GitHub and the verify, with the Action cost', async () => {
  const history = await load(RESOLVED);
  const answers = await readRunGitHub(readRunHistory(history), cannedReader());
  assert.equal(answers.costNote, null);

  const row = buildReportRow(history, answers) as ReportRow;
  assert.equal(row.key, KEY);
  assert.deepEqual(row.steps, { issue: 0.1, pr: 1.5, merge: 5.5, deploy: 0.5, resolved: 1.8 });
  assert.equal(row.total, 9.3);
  assert.equal(row.outcome, 'resolved');
  assert.equal(row.humanComments, 0);
  assert.equal(row.costUsd, 0.12657490000000002);
  assert.match(renderFindingReport([row], { markdown: false, timeZone: 'America/Vancouver' }), new RegExp(`${KEY} +2026-10-15 22:32 `));
});

test('a custom-fixer attempt whose PR closed unmerged is a row with gaps, not an error', async () => {
  const history = await load('finding-child-fix-returned.bin');
  const facts = readRunHistory(history);
  assert.equal(facts.issueUrl, null);
  assert.equal(facts.prUrl, `https://github.com/${REPO}/pull/501`);
  assert.equal(facts.deploymentId, null);
  assert.equal(facts.ranAt, null);
  assert.equal(facts.outcome, 'open');

  const github: RunGitHub = {
    issueCreatedAt: null,
    prCreatedAt: '2026-10-16T04:00:00Z',
    mergedAt: null,
    deployedAt: null,
    humanComments: 0,
    costUsd: null,
  };
  const row = buildReportRow(history, github) as ReportRow;
  assert.deepEqual(row.steps, { issue: null, pr: null, merge: null, deploy: null, resolved: null });
  assert.equal(row.total, null);
  assert.equal(row.outcome, 'open');
});

test('a run with no verdict has no row', () => {
  const history = { events: [] };
  assert.equal(readRunHistory(history).verdict, null);
  assert.equal(
    buildReportRow(history, {
      issueCreatedAt: null,
      prCreatedAt: null,
      mergedAt: null,
      deployedAt: null,
      humanComments: null,
      costUsd: null,
    }),
    null,
  );
});

test('a job log with no cost line, or one GitHub has expired, leaves the cost a dash and says why', async () => {
  const facts = readRunHistory(await load(RESOLVED));
  for (const log of ['no result block here', null]) {
    const answers = await readRunGitHub(facts, cannedReader(log));
    assert.equal(answers.costUsd, null);
    assert.match(answers.costNote ?? '', /no cost line/);
  }
});

test('human comments are users, not bots, and a review counts only when it says something', () => {
  assert.equal(
    countHumanComments(
      [{ user: { type: 'User' } }, { user: { type: 'Bot' } }],
      [{ user: { type: 'User' } }],
      [{ user: { type: 'User' }, body: '  ' }, { user: { type: 'User' }, body: 'Looks right' }, { user: null, body: 'x' }],
    ),
    3,
  );
});

test('the deploy instant is the success status, and the Action run is the issue-titled one at or after the issue', () => {
  assert.equal(successAt([{ state: 'pending', created_at: '2026-10-16T06:00:00Z' }]), null);
  assert.equal(
    successAt([
      { state: 'success', created_at: '2026-10-16T06:05:00Z' },
      { state: 'success', created_at: '2026-10-16T06:04:00Z' },
    ]),
    '2026-10-16T06:04:00Z',
  );
  const issue = { title: 'T', createdAt: '2026-10-16T05:00:00Z' };
  assert.equal(
    pickIssueRun(
      [
        { id: 1, event: 'issues', display_title: 'T', created_at: '2026-10-16T04:59:00Z' },
        { id: 2, event: 'issue_comment', display_title: 'T', created_at: '2026-10-16T05:01:00Z' },
        { id: 3, event: 'issues', display_title: 'T', created_at: '2026-10-16T05:03:00Z' },
        { id: 4, event: 'issues', display_title: 'T', created_at: '2026-10-16T05:02:00Z' },
      ],
      issue,
    )?.id,
    4,
  );
  assert.equal(costFromJobLog('"total_cost_usd": 0.5\n"total_cost_usd": 1.25'), 1.25);
});

const row = (over: Partial<ReportRow>): ReportRow => ({
  key: 'k',
  workflowId: 'finding/mattpyle-com/k',
  approveAt: '2026-10-16T05:32:00Z',
  steps: { issue: 0.1, pr: 1.5, merge: 5.5, deploy: 0.5, resolved: 1.8 },
  total: 9.4,
  outcome: 'resolved',
  humanComments: 0,
  costUsd: 0.1266,
  ...over,
});

test('the footer counts rows, and takes medians over the rows that reached each step', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  const footer = reportFooter([
    row({ total: 9.4, humanComments: 0 }),
    row({ total: 17.2, humanComments: 1 }),
    row({ total: null, steps: { issue: null, pr: null, merge: null, deploy: null, resolved: null }, humanComments: null }),
  ]);
  assert.deepEqual(footer, { rows: 3, medianTotal: 13.3, totalRows: 2, medianHumanActions: 2.5, mergedRows: 2 });
});

test('the table prints local time, dashes for gaps, and the same rows as markdown', () => {
  const rows = [
    row({}),
    row({ key: 'rejected-one', outcome: 'rejected', total: null, humanComments: null, costUsd: null, steps: { issue: null, pr: null, merge: null, deploy: null, resolved: null } }),
  ];
  const text = renderFindingReport(rows, { markdown: false, timeZone: 'America/Vancouver' });
  assert.match(text, /^Key +Approve +Issue/);
  assert.match(text, /k +2026-10-15 22:32 +0\.1 +1\.5 +5\.5 +0\.5 +1\.8 +9\.4 +resolved +0 +0\.13/);
  assert.match(text, /rejected-one +2026-10-15 22:32 +- +- +- +- +- +- +rejected +- +-/);
  assert.match(text, /2 rows\. Median total 9\.4 min \(1 verified\)\. Median human actions 2 \(1 merged/);

  const md = renderFindingReport(rows, { markdown: true, timeZone: 'America/Vancouver' }).split('\n');
  assert.equal(md[0], '| Key | Approve | Issue | PR | Merge | Deploy | Resolved | Total | Outcome | Comments | Cost |');
  assert.equal(md[1], '| --- | --- | --: | --: | --: | --: | --: | --: | --- | --: | --: |');
  assert.equal(md[2], '| k | 2026-10-15 22:32 | 0.1 | 1.5 | 5.5 | 0.5 | 1.8 | 9.4 | resolved | 0 | 0.13 |');
  assert.equal(md[3], '| rejected-one | 2026-10-15 22:32 | - | - | - | - | - | - | rejected | - | - |');
});

// ---------------------------------------------------------------------------
// Hand verifies (design decision 30)
// ---------------------------------------------------------------------------

const facts = (over: Partial<RunFacts>): RunFacts => ({
  workflowId: 'finding/mattpyle-com/k',
  site: 'mattpyle-com',
  key: 'k',
  verdict: { status: 'approved', reason: 'Real.', source: 'cli', at: '2026-10-11T06:26:32Z' },
  verdictAt: '2026-10-11T06:26:32.301Z',
  issueUrl: null,
  prUrl: null,
  deploymentId: null,
  ranAt: null,
  outcome: 'verdict',
  closedAt: '2026-10-11T06:26:40.000Z',
  ...over,
});

const hand = (over: Partial<HandVerify>): HandVerify => ({
  site: 'mattpyle-com',
  key: 'k',
  outcome: 'confirmed',
  ranAt: '2026-10-17T05:00:00.000Z',
  prUrl: `https://github.com/${REPO}/pull/312`,
  deploymentId: 7200,
  ...over,
});

test('a run records when it closed, and an open run has no close', async () => {
  assert.match(readRunHistory(await load(RESOLVED)).closedAt ?? '', /^2026-10-16T05:42:\d\d\.\d{3}Z$/);
  assert.equal(readRunHistory(await load('finding-child-fix-returned.bin')).closedAt, null);
});

test('a hand verify is read from its history, and a lifecycle child or an unfinished verify is not one', async () => {
  const blockless = readVerifyHistory(await load('verify-finding-blockless.bin'));
  assert.deepEqual(blockless, {
    site: 'mattpyle-com',
    key: 'content-perfect-score-labelled-fail--scorecard',
    outcome: 'unverifiable',
    ranAt: null,
    prUrl: null,
    deploymentId: null,
  });
  const child = { events: [{ workflowExecutionStartedEventAttributes: { parentWorkflowExecution: { workflowId: 'finding/mattpyle-com/k' } } }] };
  assert.equal(readVerifyHistory(child as never), null);
  assert.equal(readVerifyHistory({ events: [{ workflowExecutionStartedEventAttributes: {} }] } as never), null);
});

test('a verdict-only run and a cancelled parked run take the confirmed verify that finished them, with its PR and deployment', () => {
  const verdictOnly = facts({});
  const parked = facts({
    key: 'parked',
    workflowId: 'finding/mattpyle-com/parked',
    outcome: 'canceled',
    verdictAt: '2026-10-14T05:00:00.000Z',
    closedAt: '2026-10-17T05:00:30.000Z',
  });
  const [one, two] = applyHandVerifies([verdictOnly, parked], [hand({}), hand({ key: 'parked', ranAt: '2026-10-17T05:00:10.000Z' })]);
  assert.equal(one.outcome, 'confirmed');
  assert.equal(one.ranAt, '2026-10-17T05:00:00.000Z');
  assert.equal(one.prUrl, `https://github.com/${REPO}/pull/312`);
  assert.equal(one.deploymentId, 7200);
  assert.equal(two.outcome, 'confirmed');
  assert.equal(two.ranAt, '2026-10-17T05:00:10.000Z');
});

test('a hand verify leaves alone a run that ended on its own verify, a rejected one, and a run cancelled before it', () => {
  const resolved = facts({ outcome: 'resolved', ranAt: '2026-10-12T00:00:00.000Z' });
  const rejected = facts({ verdict: { status: 'rejected', reason: 'No.', source: 'cli', at: 'x' }, outcome: 'rejected' });
  const cancelledEarly = facts({ outcome: 'canceled', closedAt: '2026-10-12T00:00:00.000Z' });
  for (const run of [resolved, rejected, cancelledEarly]) {
    assert.deepEqual(applyHandVerifies([run], [hand({})]), [run]);
  }
  // A run still at fixing is finished by a reopened hand verify too, and an unverifiable one is no ending.
  const stranded = facts({ outcome: 'unverifiable', prUrl: `https://github.com/${REPO}/pull/401`, deploymentId: 5 });
  assert.equal(applyHandVerifies([stranded], [hand({ outcome: 'unverifiable' })])[0].outcome, 'unverifiable');
  const reopened = applyHandVerifies([stranded], [hand({ outcome: 'reopened', prUrl: null, deploymentId: null })])[0];
  assert.equal(reopened.outcome, 'reopened');
  assert.equal(reopened.prUrl, `https://github.com/${REPO}/pull/401`, 'the run keeps its own PR');
  assert.equal(reopened.deploymentId, 5);
});

test('a hand verify belongs to one run: the newest approved run of its finding before it', () => {
  const older = facts({});
  const newer = facts({ verdictAt: '2026-10-15T00:00:00.000Z', outcome: 'unverifiable', closedAt: '2026-10-15T01:00:00.000Z' });
  const [a, b] = applyHandVerifies([older, newer], [hand({})]);
  assert.equal(a.outcome, 'verdict');
  assert.equal(b.outcome, 'confirmed');
  // Of two later verifies, a run that ended earlier takes the first.
  const [first] = applyHandVerifies([older], [hand({ ranAt: '2026-10-18T00:00:00.000Z', outcome: 'reopened' }), hand({})]);
  assert.equal(first.ranAt, '2026-10-17T05:00:00.000Z');
});

test('confirmed prints as its own outcome and counts as verified in the footer', () => {
  const text = renderFindingReport([row({ outcome: 'confirmed', total: 9000.5 })], { markdown: false, timeZone: 'America/Vancouver' });
  assert.match(text, / confirmed /);
  assert.match(text, /1 row\. Median total 9000\.5 min \(1 verified\)/);
});
