import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { createTestEnv } from '../helpers/test-env.js';
import {
  findingStateQuery,
  findingWorkflow,
  fixSignal,
  verdictSignal,
  type FindingState,
  type FindingWorkflowInput,
  type FindingWorkflowResult,
} from '../../src/workflows/finding.js';
import type {
  AwaitFixPrInput,
  AwaitProductionDeployInput,
  FixIssue,
  FixPr,
  FixPrOutcome,
  OpenFixIssueInput,
  ProductionDeploy,
  ProductionRead,
  ReadProductionDeployInput,
  WriteFindingReturnedInput,
  WriteFindingVerificationInput,
} from '../../src/activities/findings.js';
import type { RunFindingChecksInput } from '../../src/activities/verify-finding.js';
import { compareContains, liveDeployment, type DeploymentRecord, type FindingVerdict } from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import type { VerifyCheck } from '../../src/lib/verify-checks.js';
import { DEFECT_FINDING, DEFECT_KEY, FIXING_FINDING, FIX_PR, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * `findingWorkflow` started with `stopAfter: 'resolved'`, end to end on the
 * time-skipping server: the verdict, the `fix` signal or `auto_fix`, the fix
 * issue and the PR wait, the merge and deploy waits, and
 * `verifyFindingWorkflow` as a real child. Every activity is mocked. One
 * worker on `steward-findings`, as on the hosted container: the parent, the
 * verify child and every activity of both (design decision 29).
 *
 * The waits are scripted per attempt, so a test reads as the sequence of polls
 * GitHub would answer. The retry intervals are the real ones (1, 5 and 2
 * minutes); the time-skipping server jumps them.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const FINDINGS = 'steward-findings';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR_1 = `https://github.com/${SITE_REPO}/pull/401`;
const PR_2 = `https://github.com/${SITE_REPO}/pull/402`;
const ISSUE_1 = `https://github.com/${SITE_REPO}/issues/101`;
const ISSUE_2 = `https://github.com/${SITE_REPO}/issues/102`;
const CHECK: VerifyCheck = { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { contains: '1 axe violation (Fail)' } };

let env: TestWorkflowEnvironment;

before(async () => {
  env = await createTestEnv();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

interface Script {
  /** The site config's `auto_fix`. */
  autoFix?: boolean;
  /** Per attempt: how many PR polls answer "not yet" before its PR opens. Default 2. */
  prPolls?: number[];
  /** Per attempt: a non-retryable failure type the PR wait throws instead, or null. */
  prFail?: (string | null)[];
  /** Per PR: how many polls answer "still open", then the outcome. */
  merge: Record<string, { openPolls: number; outcome: FixPrOutcome }>;
  /** What production's deployments list holds at each deploy poll, newest first. The last entry repeats. */
  deploys?: DeploymentRecord[][];
  /** Which merge commit's compare against which live commit contains it: `merge...live` keys. */
  contains?: Record<string, boolean>;
  /** Whether the verify checks pass. */
  passes?: boolean;
  /** The finding has no `verify` key. */
  noBlock?: boolean;
  /** What the blockless verify's production read says: contained unless false. */
  liveContains?: boolean;
}

function lifecycle(script: Script) {
  const calls: string[] = [];
  let finding = DEFECT_FINDING;
  const issues: FixIssue[] = [];
  const prPolls: Record<number, number> = {};
  const mergePolls: Record<string, number> = {};
  let deployPolls = 0;
  const seen: {
    issues: OpenFixIssueInput[];
    returned: WriteFindingReturnedInput[];
    deploy: AwaitProductionDeployInput[];
    verification?: WriteFindingVerificationInput;
  } = {
    issues: [],
    returned: [],
    deploy: [],
  };

  const findings = {
    writeFindingVerdict: async () => {
      calls.push('writeFindingVerdict');
      return { findingCommitSha: 'c-v1', indexCommitSha: 'c-v2', commitSha: 'c-v2' };
    },
    readSiteAutoFix: async () => {
      calls.push('readSiteAutoFix');
      return script.autoFix ?? false;
    },
    openFixIssue: async (input: OpenFixIssueInput): Promise<FixIssue> => {
      calls.push('openFixIssue');
      seen.issues.push(input);
      const number = 101 + issues.length;
      const issue = { repo: SITE_REPO, number, url: `https://github.com/${SITE_REPO}/issues/${number}`, reused: false };
      issues.push(issue);
      return issue;
    },
    awaitFixPr: async (input: AwaitFixPrInput): Promise<FixPr> => {
      const attempt = input.issueNumber - 101;
      const n = (prPolls[input.issueNumber] = (prPolls[input.issueNumber] ?? 0) + 1);
      const fail = script.prFail?.[attempt];
      if (fail) throw ApplicationFailure.nonRetryable('GitHub rejected the credential (403).', fail);
      if (n <= (script.prPolls?.[attempt] ?? 2)) {
        throw ApplicationFailure.retryable(`No open PR from claude/issue-${input.issueNumber}- yet.`, 'FixPrNotOpen');
      }
      calls.push('awaitFixPr');
      return { prUrl: attempt === 0 ? PR_1 : PR_2, branch: `claude/issue-${input.issueNumber}-20261016-0338` };
    },
    writeFindingFix: async () => {
      calls.push('writeFindingFix');
      finding = FIXING_FINDING;
      return { findingCommitSha: 'c-f1', indexCommitSha: 'c-f2', commitSha: 'c-f2' };
    },
    awaitFixPrMerge: async (prUrl: string): Promise<FixPrOutcome> => {
      const n = (mergePolls[prUrl] = (mergePolls[prUrl] ?? 0) + 1);
      const plan = script.merge[prUrl];
      if (n <= plan.openPolls) throw ApplicationFailure.retryable(`${prUrl} is still open.`, 'PrStillOpen');
      calls.push(`awaitFixPrMerge:${plan.outcome.state}`);
      return plan.outcome;
    },
    awaitProductionDeploy: async (input: AwaitProductionDeployInput): Promise<ProductionDeploy> => {
      seen.deploy.push(input);
      const timeline = script.deploys ?? [];
      const list = timeline[Math.min(deployPolls, timeline.length - 1)] ?? [];
      deployPolls++;
      // The activity's own decision, over the scripted GitHub answers.
      const live = liveDeployment(list);
      if (!live) throw ApplicationFailure.retryable('No production deployment yet.', 'DeployNotLive');
      const compare = script.contains?.[`${input.mergeSha}...${live.sha}`] ? 'ahead' : 'behind';
      if (live.sha !== input.mergeSha && !compareContains(compare)) {
        throw ApplicationFailure.retryable(`${live.sha} does not contain ${input.mergeSha}.`, 'DeployNotLive');
      }
      calls.push(`awaitProductionDeploy:${live.sha}`);
      return { liveSha: live.sha, deploymentId: live.id };
    },
    writeFindingReturned: async (input: WriteFindingReturnedInput) => {
      calls.push('writeFindingReturned');
      seen.returned.push(input);
      finding = DEFECT_FINDING;
      return { findingCommitSha: 'c-r1', indexCommitSha: 'c-r2', commitSha: 'c-r2' };
    },
  };

  // The verify child's activities, on the same queue since decision 29.
  const verify = {
    readFinding: async (_repo: string, path: string) => {
      calls.push('readFinding');
      return { path, text: finding, sha: 'sha-1', data: parseFrontmatter(finding).data };
    },
    readFixPr: async (prUrl: string) => {
      calls.push('readFixPr');
      return { prUrl, merged: true, mergedAt: '2026-10-13T20:00:00Z' };
    },
    readProductionDeploy: async (input: ReadProductionDeployInput): Promise<ProductionRead> => {
      calls.push('readProductionDeploy');
      const contains = script.liveContains ?? true;
      return {
        prUrl: input.prUrl,
        mergeSha: 'm1',
        liveSha: contains ? 'm1' : 'old',
        deploymentId: 2,
        contains,
        why: contains ? '' : 'Production serves old, which does not contain m1 (behind).',
        readAt: '2026-10-13T21:00:00.000Z',
      };
    },
    readVerifyBlock: async () => {
      calls.push('readVerifyBlock');
      if (script.noBlock) return { handoff: null, hasBlock: false, checks: [], source: 'finding' as const };
      return { handoff: null, hasBlock: true, checks: [CHECK], source: 'finding' as const };
    },
    runFindingChecks: async (input: RunFindingChecksInput) => {
      calls.push('runFindingChecks');
      const pass = script.passes ?? true;
      return {
        ranAt: '2026-10-13T21:00:00.000Z',
        passed: pass,
        results: input.checks.map((c, i) => ({
          n: i + 1,
          url: c.url,
          kind: c.kind,
          pass,
          expected: 'contains "1 axe violation (Fail)"',
          measured: pass ? '1 occurrence' : '0 occurrences',
        })),
      };
    },
    writeFindingVerification: async (input: WriteFindingVerificationInput) => {
      calls.push(`writeFindingVerification:${input.verification.status}`);
      seen.verification = input;
      return { findingCommitSha: 'c-w1', indexCommitSha: 'c-w2', commitSha: 'c-w2' };
    },
  };

  return {
    findings: { ...findings, ...verify },
    calls,
    seen,
    prPolls: () => prPolls,
    mergePolls: () => mergePolls,
    deployPolls: () => deployPolls,
  };
}

/** One worker, as on the hosted container: no `steward-heavy` poller, so a child sent there would never run. */
async function withWorkers<T>(mocks: ReturnType<typeof lifecycle>, fn: () => Promise<T>): Promise<T> {
  const findingsWorker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities: mocks.findings,
    taskQueue: FINDINGS,
    bundlerOptions: {},
  });
  return await findingsWorker.runUntil(fn());
}

function input(id: string): FindingWorkflowInput {
  return {
    site: 'mattpyle-com',
    key: DEFECT_KEY,
    repo: 'mattpyle/argus',
    findingPath: `sites/mattpyle-com/findings/${DEFECT_KEY}.md`,
    indexPath: 'sites/mattpyle-com/findings/INDEX.md',
    stopAfter: 'resolved',
    handoffPath: `sites/mattpyle-com/handoffs/${DEFECT_KEY}.md`,
    branch: `fix/finding-${DEFECT_KEY}-${id}`,
    origin: ORIGIN,
  };
}

const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'cli', at: '2026-10-13T18:00:00Z' };
const FIX = { source: 'cli' as const, at: '2026-10-13T18:05:00Z' };

/** Starts a lifecycle, approves it and sends the first `fix`. */
async function startApproved(id: string) {
  const handle = await env.client.workflow.start(findingWorkflow, {
    workflowId: `finding/mattpyle-com/lifecycle-${id}`,
    taskQueue: FINDINGS,
    args: [input(id)],
  });
  await handle.signal(verdictSignal, APPROVE);
  await handle.signal(fixSignal, FIX);
  return handle;
}

const merged = (prUrl: string, mergeSha: string): FixPrOutcome => ({ prUrl, state: 'merged', mergeSha, at: '2026-10-13T20:00:00Z' });

test('merged, deployed and every check passes: resolved, with one execution carrying the whole path', async () => {
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: 3, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 1, sha: 'old', state: 'success' }], [{ id: 2, sha: 'm1', state: 'success' }]],
  });
  let childQueues: (string | null | undefined)[] = [];
  const result = (await withWorkers(mocks, async () => {
    const handle = await startApproved('resolved');
    const done = await handle.result();
    const history = await handle.fetchHistory();
    childQueues = (history.events ?? [])
      .map((e) => e.startChildWorkflowExecutionInitiatedEventAttributes)
      .filter(Boolean)
      .map((child) => child?.taskQueue?.name);
    return done;
  })) as FindingWorkflowResult;

  assert.deepEqual(childQueues, [FINDINGS], 'the verify child starts on steward-findings');
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.prUrl, PR_1);
  assert.equal(result.mergeSha, 'm1');
  assert.equal(result.liveSha, 'm1');
  assert.equal(result.fixAttempts, 1);
  assert.match(result.verifyWorkflowId ?? '', new RegExp(`^verify/mattpyle-com/${DEFECT_KEY}/`));
  assert.equal(mocks.prPolls()[101], 3, 'two "not yet" polls, then the PR');
  assert.equal(mocks.mergePolls()[PR_1], 4, 'three open polls, then the merge');
  assert.equal(mocks.deployPolls(), 2, 'the old deploy, then the merge commit');
  assert.deepEqual(mocks.seen.deploy[0], { repo: SITE_REPO, mergeSha: 'm1', environment: 'Production' });
  assert.deepEqual(mocks.seen.issues[0], {
    repo: 'mattpyle/argus',
    site: 'mattpyle-com',
    key: DEFECT_KEY,
    findingPath: `sites/mattpyle-com/findings/${DEFECT_KEY}.md`,
    supersedes: null,
  });
  assert.deepEqual(mocks.calls, [
    'writeFindingVerdict',
    'readSiteAutoFix',
    'openFixIssue',
    'awaitFixPr',
    'writeFindingFix',
    'awaitFixPrMerge:merged',
    'awaitProductionDeploy:m1',
    'readFinding',
    'readFixPr',
    'readVerifyBlock',
    'runFindingChecks',
    'writeFindingVerification:resolved',
  ]);
});

test('auto_fix: the approved verdict goes to the issue with no fix signal, and the run waits on the PR', async () => {
  const mocks = lifecycle({
    autoFix: true,
    prPolls: [3],
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
  });
  const result = await withWorkers(mocks, async () => {
    const handle = await env.client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-auto-fix',
      taskQueue: FINDINGS,
      args: [input('auto-fix')],
    });
    await handle.signal(verdictSignal, APPROVE);
    const waiting = await untilState(handle, (s) => s.step === 'fixing' && Boolean(s.issueUrl), 'fixing with an issue');
    assert.equal(waiting.issueUrl, ISSUE_1, 'the issue is in the state while the run waits for the PR');
    assert.equal(waiting.prUrl, null);
    return handle.result();
  });

  assert.equal(result.outcome, 'resolved');
  assert.equal(result.prUrl, PR_1);
  assert.equal(result.fixAttempts, 1);
  assert.deepEqual(mocks.calls.slice(0, 5), ['writeFindingVerdict', 'readSiteAutoFix', 'openFixIssue', 'awaitFixPr', 'writeFindingFix']);
});

test('without auto_fix the approved run waits at waiting-fix and opens no issue', async () => {
  const mocks = lifecycle({ autoFix: false, merge: {} });
  await withWorkers(mocks, async () => {
    const handle = await env.client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-no-auto-fix',
      taskQueue: FINDINGS,
      args: [input('no-auto-fix')],
    });
    await handle.signal(verdictSignal, APPROVE);
    await untilState(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
    await env.sleep('10 minutes');
    assert.equal((await handle.query(findingStateQuery)).step, 'waiting-fix');
    assert.deepEqual(mocks.calls, ['writeFindingVerdict', 'readSiteAutoFix']);
    await handle.terminate('test over');
  });
});

test('merged and deployed, but a check fails on production: reopened with both values', async () => {
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
    passes: false,
  });
  const result = await withWorkers(mocks, async () => (await startApproved('reopened')).result());

  assert.equal(result.outcome, 'reopened');
  assert.equal(mocks.seen.verification?.verification.status, 'reopened');
  const row = mocks.seen.verification?.verification.rows[0];
  assert.equal(row?.expected, 'contains "1 axe violation (Fail)"');
  assert.equal(row?.measured, '0 occurrences');
});

test('merged and deployed, and the finding has no verify block: confirmed by the deploy, written resolved', async () => {
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
    noBlock: true,
  });
  const result = await withWorkers(mocks, async () => (await startApproved('confirmed')).result());

  assert.equal(result.outcome, 'confirmed');
  assert.match(result.note ?? '', /^Confirmed by its deploy: production serves m1, which contains m1\. No check could measure the fix\.$/);
  assert.equal(result.liveSha, 'm1');
  assert.ok(!mocks.calls.includes('runFindingChecks'));
  assert.deepEqual(mocks.calls.slice(-5), [
    'readFinding',
    'readFixPr',
    'readVerifyBlock',
    'readProductionDeploy',
    'writeFindingVerification:resolved',
  ]);
  assert.equal(mocks.seen.verification?.verification.deploy?.prUrl, FIX_PR, 'the PR the finding names');
  assert.deepEqual(mocks.seen.verification?.verification.rows, []);
});

test('no verify block, and production does not contain the fix: verify-failed, the finding still fixing', async () => {
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
    noBlock: true,
    liveContains: false,
  });
  const result = await withWorkers(mocks, async () => (await startApproved('not-contained')).result());

  assert.equal(result.outcome, 'verify-failed');
  assert.match(result.note ?? '', /could not be confirmed by the deploy: Production serves old.+The finding is still fixing\./);
  assert.ok(!mocks.calls.some((c) => c.startsWith('writeFindingVerification')), 'nothing is written');
});

test('a PR closed unmerged writes approved back, and the next fix closes the first issue naming the PR and opens a second', async () => {
  const mocks = lifecycle({
    merge: {
      [PR_1]: { openPolls: 1, outcome: { prUrl: PR_1, state: 'closed', mergeSha: null, at: '2026-10-13T19:00:00Z' } },
      [PR_2]: { openPolls: 0, outcome: merged(PR_2, 'm2') },
    },
    deploys: [[{ id: 3, sha: 'm2', state: 'success' }]],
  });
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('closed');
    // Wait for the return to approved, then ask again.
    await untilState(
      handle,
      (state) => state.step === 'waiting-fix' && mocks.seen.returned.length === 1,
      'waiting-fix after one returned PR',
      '10 seconds',
    );
    const waiting = await handle.query(findingStateQuery);
    assert.equal(waiting.prUrl, PR_1, 'the closed PR is still the last one');
    assert.equal(waiting.issueUrl, ISSUE_1);
    await handle.signal(fixSignal, { ...FIX, at: '2026-10-13T19:30:00Z' });
    return handle.result();
  });

  assert.equal(result.outcome, 'resolved');
  assert.equal(result.prUrl, PR_2);
  assert.equal(result.fixAttempts, 2);
  assert.equal(mocks.seen.returned[0].prUrl, PR_1);
  assert.deepEqual(
    mocks.seen.issues.map((i) => i.supersedes),
    [null, { url: ISSUE_1, reason: `${PR_1} closed unmerged` }],
  );
  assert.deepEqual(
    mocks.calls.filter((c) => c.startsWith('await') || c.startsWith('write') || c === 'openFixIssue'),
    [
      'writeFindingVerdict',
      'openFixIssue',
      'awaitFixPr',
      'writeFindingFix',
      'awaitFixPrMerge:closed',
      'writeFindingReturned',
      'openFixIssue',
      'awaitFixPr',
      'writeFindingFix',
      'awaitFixPrMerge:merged',
      'awaitProductionDeploy:m2',
      'writeFindingVerification:resolved',
    ],
  );
});

test('no PR within 60 minutes: the reason lands in lastFixError and the run goes back to waiting-fix', async () => {
  const mocks = lifecycle({ prPolls: [Number.POSITIVE_INFINITY], merge: {} });
  await withWorkers(mocks, async () => {
    const handle = await startApproved('pr-timeout');
    // A pending result() lets the server skip the hour of polls. Once the run
    // idles at waiting-fix it skips on to the test server's own execution
    // timeout, so the state is read on the way and the run is left there.
    const done = handle.result().catch(() => undefined);
    let waiting: FindingState;
    const deadline = Date.now() + 60_000;
    for (;;) {
      waiting = await handle.query(findingStateQuery);
      if (waiting.step === 'waiting-fix' && waiting.lastFixError) break;
      if (Date.now() > deadline) assert.fail(`the PR wait never gave up; the run is at ${waiting.step}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(waiting.lastFixError, `No PR from ${ISSUE_1} within 60 minutes.`);
    assert.equal(waiting.issueUrl, ISSUE_1);
    assert.equal(waiting.prUrl, null);
    // Every minute for an hour.
    const polls = mocks.prPolls()[101];
    assert.ok(polls >= 55 && polls <= 61, `polled ${polls} times`);
    assert.ok(!mocks.calls.includes('writeFindingFix'), 'the finding is marked fixing only when a PR exists');
    // Settle the pending result, or time skipping stays unlocked for the next test.
    await handle.terminate('test over').catch(() => undefined);
    await done;
  });
});

test('a failed attempt is retried by fix: the next issue supersedes the first with the failure, then runs to resolved', async () => {
  const mocks = lifecycle({
    prFail: ['AuthError'],
    prPolls: [0, 0],
    merge: { [PR_2]: { openPolls: 0, outcome: merged(PR_2, 'm2') } },
    deploys: [[{ id: 3, sha: 'm2', state: 'success' }]],
  });
  // Asserted through the state query, not result(): result() never returns
  // on this run in the test harness, though the run reaches `done`.
  const state = await withWorkers(mocks, async () => {
    const handle = await startApproved('pr-failed');
    const waiting = await untilState(handle, (s) => s.step === 'waiting-fix' && Boolean(s.lastFixError), 'waiting-fix after the failure');
    assert.equal(waiting.lastFixError, 'GitHub rejected the credential (403).');
    await handle.signal(fixSignal, { ...FIX, at: '2026-10-13T20:00:00Z' });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const s = await handle.query(findingStateQuery);
      if (s.step === 'done') return s;
      if (Date.now() > deadline) assert.fail(`the retry never finished; the run is at ${s.step}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  assert.equal(state.prUrl, PR_2);
  assert.equal(state.fixAttempts, 2);
  assert.equal(state.issueUrl, ISSUE_2);
  assert.equal(state.lastFixError, null);
  assert.deepEqual(mocks.seen.issues[1].supersedes, { url: ISSUE_1, reason: 'GitHub rejected the credential (403).' });
  assert.equal(mocks.calls.filter((c) => c === 'writeFindingFix').length, 1);
  assert.equal(mocks.calls.at(-1), 'writeFindingVerification:resolved');
});

test('a deploy that never serves the merge commit times out after 24 hours: still fixing, no verify', async () => {
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 1, sha: 'old', state: 'success' }]],
  });
  const result = await withWorkers(mocks, async () => (await startApproved('deploy-timeout')).result());

  assert.equal(result.outcome, 'deploy-timeout');
  assert.equal(result.mergeSha, 'm1');
  assert.match(result.note ?? '', /still fixing/);
  // Every 2 minutes for 24 hours is 720 polls; the bound, not a count, ends it.
  assert.ok(mocks.deployPolls() >= 700 && mocks.deployPolls() <= 721, `polled ${mocks.deployPolls()} times`);
  assert.ok(!mocks.calls.some((c) => c.startsWith('writeFindingVerification')), 'nothing was verified');
});

test('a PR nobody merges or closes times out after 30 days: still fixing, no deploy wait', { timeout: 300_000 }, async () => {
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: Number.POSITIVE_INFINITY, outcome: merged(PR_1, 'never') } },
  });
  const result = await withWorkers(mocks, async () => (await startApproved('merge-timeout')).result());

  assert.equal(result.outcome, 'merge-timeout');
  assert.equal(result.prUrl, PR_1);
  // Every 5 minutes for 30 days is 8640 polls.
  const polls = mocks.mergePolls()[PR_1];
  assert.ok(polls >= 8600 && polls <= 8641, `polled ${polls} times`);
  assert.equal(mocks.deployPolls(), 0);
});

test('two merges close together: production skips the first one\'s deploy, and the later commit that contains it ends the wait', async () => {
  // m1 is this PR's merge. m2, merged a minute later, deploys first and
  // supersedes m1's deploy, which never succeeds. m2 contains m1.
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [
      [{ id: 1, sha: 'old', state: 'success' }],
      [{ id: 2, sha: 'm1', state: 'in_progress' }, { id: 1, sha: 'old', state: 'success' }],
      [{ id: 3, sha: 'm2', state: 'success' }, { id: 2, sha: 'm1', state: 'inactive' }, { id: 1, sha: 'old', state: 'inactive' }],
    ],
    contains: { 'm1...m2': true, 'm1...old': false },
  });
  const result = await withWorkers(mocks, async () => (await startApproved('two-merges')).result());

  assert.equal(result.outcome, 'resolved');
  assert.equal(result.mergeSha, 'm1');
  assert.equal(result.liveSha, 'm2');
  assert.equal(mocks.deployPolls(), 3);
});

/**
 * Polls the run's state until `ready` holds, and fails after `limitMs` of
 * wall-clock time rather than spinning until CI kills the job.
 */
async function untilState(
  handle: { query: (q: typeof findingStateQuery) => Promise<FindingState> },
  ready: (state: FindingState) => boolean,
  what: string,
  every: Parameters<typeof env.sleep>[0] = '1 second',
  limitMs = 30_000,
) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const state = await handle.query(findingStateQuery);
    if (ready(state)) return state;
    if (Date.now() > deadline) assert.fail(`the run never reached ${what}; it is at ${state.step}`);
    await env.sleep(every);
  }
}

test('a fix sent before the verdict is dropped, and a verdict-only run ignores fix entirely', async () => {
  const mocks = lifecycle({ merge: {} });
  await withWorkers(mocks, async () => {
    const handle = await env.client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-early-fix',
      taskQueue: FINDINGS,
      args: [input('early-fix')],
    });
    // The run must be waiting for its verdict before the fix arrives. Two
    // signals that reach a run before its first task are delivered in handler
    // order, verdict first, and the fix would then count.
    await untilState(handle, (state) => state.step === 'waiting-verdict', 'waiting-verdict');
    await handle.signal(fixSignal, FIX);
    await handle.signal(verdictSignal, APPROVE);
    await untilState(handle, (state) => state.step === 'waiting-fix', 'waiting-fix');
    assert.ok(!mocks.calls.includes('openFixIssue'), 'the early fix started nothing');
    await handle.terminate('test over');

    const verdictOnly = await env.client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-verdict-only',
      taskQueue: FINDINGS,
      args: [{ ...input('verdict-only'), stopAfter: 'verdict' }],
    });
    await verdictOnly.signal(verdictSignal, APPROVE);
    await verdictOnly.signal(fixSignal, FIX);
    const result = await verdictOnly.result();
    assert.equal(result.outcome, undefined, 'a verdict-only result keeps its old shape');
    assert.equal(result.verdict.status, 'approved');
  });
});

test('a rejected verdict ends a resolved run at the gate', async () => {
  const mocks = lifecycle({ merge: {} });
  const result = await withWorkers(mocks, async () => {
    const handle = await env.client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-rejected',
      taskQueue: FINDINGS,
      args: [input('rejected')],
    });
    await handle.signal(verdictSignal, { ...APPROVE, status: 'rejected', reason: 'By design.' });
    return handle.result();
  });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(mocks.calls, ['writeFindingVerdict']);
});
