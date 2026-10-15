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
  AwaitProductionDeployInput,
  FixPrOutcome,
  ProductionDeploy,
  WriteFindingReturnedInput,
  WriteFindingVerificationInput,
} from '../../src/activities/findings.js';
import { readFixChecks, type OpenFixerPrInput, type ReviewFixDiffResult, type RunFixerResult } from '../../src/activities/fixer.js';
import { opensAsDraft } from '../../src/lib/fixer.js';
import type { RunFindingChecksInput } from '../../src/activities/verify-finding.js';
import { compareContains, liveDeployment, type DeploymentRecord, type FindingVerdict } from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import type { VerifyCheck } from '../../src/lib/verify-checks.js';
import { DEFECT_FINDING, DEFECT_HANDOFF, DEFECT_KEY, FIXING_FINDING, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * `findingWorkflow` started with `stopAfter: 'resolved'`, end to end on the
 * time-skipping server: the verdict, the `fix` signal, `fixFindingWorkflow` and
 * `verifyFindingWorkflow` as real children, and the two polling waits. Every
 * activity is mocked. Two workers, one per queue, as in production: the parent
 * and its waits on `steward-findings`, the children on `steward-heavy`.
 *
 * The waits are scripted per attempt, so a test reads as the sequence of polls
 * GitHub would answer. The retry intervals are the real ones (5 minutes, 2
 * minutes); the time-skipping server jumps them.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const FINDINGS = 'steward-findings';
const HEAVY = 'steward-heavy';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR_1 = `https://github.com/${SITE_REPO}/pull/401`;
const PR_2 = `https://github.com/${SITE_REPO}/pull/402`;
const CHECK: VerifyCheck = { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { contains: '1 axe violation (Fail)' } };

let env: TestWorkflowEnvironment;

before(async () => {
  env = await createTestEnv();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

interface Script {
  /** Per PR: how many polls answer "still open", then the outcome. */
  merge: Record<string, { openPolls: number; outcome: FixPrOutcome }>;
  /** What production's deployments list holds at each deploy poll, newest first. The last entry repeats. */
  deploys?: DeploymentRecord[][];
  /** Which merge commit's compare against which live commit contains it: `merge...live` keys. */
  contains?: Record<string, boolean>;
  /** Whether the verify checks pass. */
  passes?: boolean;
}

function lifecycle(script: Script) {
  const calls: string[] = [];
  let finding = DEFECT_FINDING;
  let prCount = 0;
  const mergePolls: Record<string, number> = {};
  let deployPolls = 0;
  const seen: {
    returned: WriteFindingReturnedInput[];
    deploy: AwaitProductionDeployInput[];
    verification?: WriteFindingVerificationInput;
    prs: OpenFixerPrInput[];
  } = {
    returned: [],
    deploy: [],
    prs: [],
  };

  const findings = {
    writeFindingVerdict: async () => {
      calls.push('writeFindingVerdict');
      return { findingCommitSha: 'c-v1', indexCommitSha: 'c-v2', commitSha: 'c-v2' };
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

  const run: RunFixerResult = {
    branch: `fix/finding-${DEFECT_KEY}`,
    base: 'master',
    commitSha: 'c-fix',
    filesChanged: ['src/pages/scorecard.astro'],
    checks: [{ n: 1, status: 'pass', command: 'npm test' }],
    claude: {
      exitCode: 0,
      timedOut: false,
      finalMessage: 'Done.',
      model: 'claude-x',
      sessionId: 's1',
      numTurns: 10,
      costUsd: 1,
      permissionDenials: [],
    },
    npmCi: false,
    timingsMs: { worktree: 1, install: 1, claude: 1, checks: 1, push: 1, total: 5 },
  };

  const heavy = {
    readFinding: async (_repo: string, path: string) => {
      calls.push('readFinding');
      return { path, text: finding, sha: 'sha-1', data: parseFrontmatter(finding).data };
    },
    generateHandoff: async () => {
      calls.push('generateHandoff');
      return {
        handoff: DEFECT_HANDOFF,
        title: 'Fix',
        commitSha: 'c-handoff',
        base: 'master',
        baseSha: 'c-base',
        claude: { model: 'claude-x', costUsd: 0.05, durationMs: 1, numTurns: 1 },
      };
    },
    // The fix child's chooser, pure. The fixture handoff's block is empty, so
    // the child runs neither site test and the lifecycle's calls are unchanged.
    readFixChecks,
    runFixer: async () => {
      calls.push('runFixer');
      return run;
    },
    // A clean review: the lifecycle's PR opens ready, as a real run's would.
    reviewFixDiff: async (): Promise<ReviewFixDiffResult> => {
      calls.push('reviewFixDiff');
      return { problems: [], incomplete: null, diffChars: 100, reply: 'problems: []', claude: null };
    },
    openFixerPr: async (input: OpenFixerPrInput) => {
      calls.push('openFixerPr');
      seen.prs.push(input);
      prCount++;
      return { prUrl: prCount === 1 ? PR_1 : PR_2, draft: opensAsDraft(input) };
    },
    writeFindingFix: async () => {
      calls.push('writeFindingFix');
      finding = FIXING_FINDING;
      return { findingCommitSha: 'c-f1', indexCommitSha: 'c-f2', commitSha: 'c-f2' };
    },
    readFixPr: async (prUrl: string) => {
      calls.push('readFixPr');
      return { prUrl, merged: true, mergedAt: '2026-10-13T20:00:00Z' };
    },
    readVerifyBlock: async () => {
      calls.push('readVerifyBlock');
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

  return { findings, heavy, calls, seen, mergePolls: () => mergePolls, deployPolls: () => deployPolls };
}

async function withWorkers<T>(mocks: ReturnType<typeof lifecycle>, fn: () => Promise<T>): Promise<T> {
  const findingsWorker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities: mocks.findings,
    taskQueue: FINDINGS,
    bundlerOptions: {},
  });
  const heavyWorker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities: mocks.heavy,
    taskQueue: HEAVY,
    bundlerOptions: {},
  });
  return await findingsWorker.runUntil(heavyWorker.runUntil(fn()));
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
  const result = (await withWorkers(mocks, async () => {
    const handle = await startApproved('resolved');
    return handle.result();
  })) as FindingWorkflowResult;

  assert.equal(result.outcome, 'resolved');
  assert.equal(result.prUrl, PR_1);
  assert.equal(result.mergeSha, 'm1');
  assert.equal(result.liveSha, 'm1');
  assert.equal(result.fixAttempts, 1);
  assert.match(result.verifyWorkflowId ?? '', new RegExp(`^verify/mattpyle-com/${DEFECT_KEY}/`));
  assert.equal(mocks.mergePolls()[PR_1], 4, 'three open polls, then the merge');
  assert.equal(mocks.deployPolls(), 2, 'the old deploy, then the merge commit');
  assert.deepEqual(mocks.seen.deploy[0], { repo: SITE_REPO, mergeSha: 'm1', environment: 'Production' });
  // The review ran, found nothing, and the PR opened ready.
  assert.deepEqual(mocks.seen.prs[0].review, { problems: [], incomplete: null });
  assert.equal(opensAsDraft(mocks.seen.prs[0]), false, 'the PR opens ready');
  assert.deepEqual(mocks.calls, [
    'writeFindingVerdict',
    'readFinding',
    'generateHandoff',
    'runFixer',
    'reviewFixDiff',
    'openFixerPr',
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

test('a PR closed unmerged writes approved back, waits, and the next fix runs again through to resolved', async () => {
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
    await handle.signal(fixSignal, { ...FIX, at: '2026-10-13T19:30:00Z' });
    return handle.result();
  });

  assert.equal(result.outcome, 'resolved');
  assert.equal(result.prUrl, PR_2);
  assert.equal(result.fixAttempts, 2);
  assert.equal(mocks.seen.returned[0].prUrl, PR_1);
  assert.equal(mocks.calls.filter((c) => c === 'runFixer').length, 2);
  assert.deepEqual(
    mocks.calls.filter((c) => c.startsWith('await') || c.startsWith('write')),
    [
      'writeFindingVerdict',
      'writeFindingFix',
      'awaitFixPrMerge:closed',
      'writeFindingReturned',
      'writeFindingFix',
      'awaitFixPrMerge:merged',
      'awaitProductionDeploy:m2',
      'writeFindingVerification:resolved',
    ],
  );
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
    assert.ok(!mocks.calls.includes('runFixer'), 'the early fix started nothing');
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
