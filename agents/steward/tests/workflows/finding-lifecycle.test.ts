import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';
import proto from '@temporalio/proto';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { settings, skipVerdictMeasure } from '../helpers/verdict-measure.js';
import {
  findingStateQuery,
  findingWorkflow,
  fixSignal,
  OPEN_UNTIL_VERIFIED_PATCH,
  requestFixUpdate,
  resumeUpdate,
  verdictSignal,
  verdictUpdate,
  type FindingState,
  type FindingWorkflowInput,
  type FindingWorkflowResult,
} from '../../src/workflows/finding.js';
import type {
  AwaitFixPrInput,
  AwaitPrPreviewInput,
  AwaitProductionDeployInput,
  FindingSettings,
  FixIssue,
  FixPr,
  FixPrOutcome,
  OpenFixIssueInput,
  PrPreview,
  ProductionDeploy,
  ProductionRead,
  ReadProductionDeployInput,
  ReportPreviewChecksInput,
  ReportPreviewChecksResult,
  CommentOnFixPrInput,
  WriteFindingFixInput,
  WriteFindingReturnedInput,
  WriteFindingVerificationInput,
} from '../../src/activities/findings.js';
import type { RunFindingChecksInput } from '../../src/activities/verify-finding.js';
import {
  compareContains,
  failedChecks,
  liveDeployment,
  setFindingFixAttempt,
  setFrontmatterFix,
  type DeploymentRecord,
  type FindingVerdict,
} from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import type { VerifyCheck } from '../../src/lib/verify-checks.js';
import { DEFECT_FINDING, DEFECT_KEY, FIXING_FINDING, FIX_PR, ORIGIN } from '../helpers/finding-fixtures.js';
import { ResumeRefused, parkedRun, requestResume } from '../../src/lib/finding-resume.js';

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
 *
 * **Each test has its own test server**, started in `beforeEach`. A shared one
 * let a test stall a later one. When a time-skipping `result()` returns, the
 * run's last workflow task completes and the server's time lock touches zero
 * before the client locks again. In that instant the server skips to the next
 * timer anywhere on it, such as an earlier test's parked run reaching its
 * execution timeout. That timer schedules a workflow task just as the test's
 * worker shuts down; the task is never started, and the server keeps a time
 * lock for it from then on, so every later wait on time skipping stalls. On CI
 * on 2026-10-30 that was the 30-day and 24-hour timeout tests. A fresh server
 * per test has no earlier runs to fire, and a task lost at a test's end goes
 * with that test's server.
 *
 * For the same reason each test awaits at most one thing through the
 * time-skipping client: a `result()` through `skipResult`, or one `env.sleep`.
 * Everything else, the starts, the signals and the state polls, goes through the
 * plain `client`, in real time. A test whose run needs a timer to reach a state
 * it asserts on spends its one await on the run's result; a test that must see
 * two time-separated states scripts the run with no timers.
 *
 * **A plain client, not `env.client`.** The time-skipping client unlocks time
 * while it waits on a result, and the test server's default execution timeout
 * is ten years, so a wait on a run idle at a signal jumps the clock past it and
 * the run reads back `TIMED_OUT`. The starts, signals and state polls here go
 * through a plain `Client` on `env.connection`, which never unlocks time.
 */

const FINDINGS = 'steward-findings';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR_1 = `https://github.com/${SITE_REPO}/pull/401`;
const PR_2 = `https://github.com/${SITE_REPO}/pull/402`;
const ISSUE_1 = `https://github.com/${SITE_REPO}/issues/101`;
const ISSUE_2 = `https://github.com/${SITE_REPO}/issues/102`;
const PREVIEW = 'https://mattpyle-com-website-abc123-mattpyles-projects.vercel.app';
const CHECK: VerifyCheck = { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { contains: '1 axe violation (Fail)' } };

let env: TestWorkflowEnvironment;
// A plain client: it never unlocks time skipping. Only `skipResult` does.
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

/** The test's one time-skipping await: the run's result, with the server free to skip its timers. */
function skipResult(handle: { workflowId: string }) {
  return env.client.workflow.getHandle<typeof findingWorkflow>(handle.workflowId).result();
}

/**
 * A scripted "not yet" from a wait stub: retryable, and BENIGN, so the worker
 * logs it at DEBUG rather than WARN with a stack trace. The merge-timeout test
 * alone throws 8,640 of them, which wrote about 285,000 lines into every CI log
 * that ran it (STW-593). A non-retryable or unexpected failure still logs WARN.
 */
function notYet(message: string, type: string): ApplicationFailure {
  return ApplicationFailure.create({ message, type, nonRetryable: false, category: ApplicationFailureCategory.BENIGN });
}

interface Script {
  /** The site config's `auto_fix`. */
  autoFix?: boolean;
  /** What `readFindingSettings` answers, over a site that fixes findings; each read is in `calls`. Absent: the helper's default. */
  settings?: Partial<FindingSettings>;
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
  /** Whether the verify checks pass on production. */
  passes?: boolean;
  /** Whether the verify checks pass on the PR's preview. Default true. */
  previewPasses?: boolean;
  /** How many preview polls answer "not yet" per PR before it is ready. Default 0, so a run with no timer reaches its waits in real time. */
  previewPolls?: number;
  /** The preview is never ready: every poll answers "not yet" until the wait's bound ends it. */
  previewNever?: boolean;
  /** The preview's build failed: the poll fails non-retryably with this type. */
  previewFail?: string;
  /** The worker has no bypass secret: the preview run fails with `PreviewBypassMissing`. */
  noBypass?: boolean;
  /** The finding has no `verify` key. */
  noBlock?: boolean;
  /** What the blockless verify's production read says: contained unless false. */
  liveContains?: boolean;
  /** The production read that first finds the fix contained, counting from 1; earlier ones do not. */
  liveFromRead?: number;
}

function lifecycle(script: Script) {
  const calls: string[] = [];
  let finding = DEFECT_FINDING;
  const issues: FixIssue[] = [];
  const prPolls: Record<number, number> = {};
  const mergePolls: Record<string, number> = {};
  let deployPolls = 0;
  let liveReads = 0;
  const seen: {
    issues: OpenFixIssueInput[];
    returned: WriteFindingReturnedInput[];
    deploy: AwaitProductionDeployInput[];
    previews: AwaitPrPreviewInput[];
    previewRuns: RunFindingChecksInput[];
    reports: ReportPreviewChecksInput[];
    verification?: WriteFindingVerificationInput;
    comments: CommentOnFixPrInput[];
    fixes: WriteFindingFixInput[];
  } = {
    issues: [],
    returned: [],
    deploy: [],
    previews: [],
    previewRuns: [],
    reports: [],
    comments: [],
    fixes: [],
  };
  const previewPolls: Record<string, number> = {};

  const findings = {
    writeFindingVerdict: async () => {
      calls.push('writeFindingVerdict');
      return { findingCommitSha: 'c-v1', indexCommitSha: 'c-v2', commitSha: 'c-v2' };
    },
    // A cause with no path: the activity grants, and no dispatcher runs.
    requestFixSlot: async () => ({ paths: [], dispatched: false }),
    readSiteAutoFix: async () => {
      calls.push('readSiteAutoFix');
      return script.autoFix ?? false;
    },
    ...(script.settings
      ? {
          readFindingSettings: async () => {
            calls.push('readFindingSettings');
            return settings(script.settings);
          },
        }
      : {}),
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
        throw notYet(`No open PR from claude/issue-${input.issueNumber}- yet.`, 'FixPrNotOpen');
      }
      calls.push('awaitFixPr');
      return { prUrl: attempt === 0 ? PR_1 : PR_2, branch: `claude/issue-${input.issueNumber}-20261016-0338` };
    },
    writeFindingFix: async (input: WriteFindingFixInput) => {
      calls.push('writeFindingFix');
      seen.fixes.push(input);
      // A new attempt from a park (STW-653) writes the real edit, so a test reads both PRs in the file.
      finding = input.earlier
        ? setFindingFixAttempt(setFrontmatterFix(finding, input.prUrl), input.earlier.at, input.earlier.note)
        : FIXING_FINDING;
      return { findingCommitSha: 'c-f1', indexCommitSha: 'c-f2', commitSha: 'c-f2' };
    },
    commentOnFixPr: async (input: CommentOnFixPrInput) => {
      calls.push('commentOnFixPr');
      seen.comments.push(input);
      return { posted: true };
    },
    awaitPrPreview: async (input: AwaitPrPreviewInput): Promise<PrPreview> => {
      seen.previews.push(input);
      const n = (previewPolls[input.prUrl] = (previewPolls[input.prUrl] ?? 0) + 1);
      if (script.previewFail) throw ApplicationFailure.nonRetryable('The Preview deployment ended failure.', script.previewFail);
      if (script.previewNever || n <= (script.previewPolls ?? 0)) {
        throw notYet('No Preview deployment of the head yet.', 'PreviewNotReady');
      }
      calls.push('awaitPrPreview');
      return { origin: PREVIEW, deploymentId: 7, sha: 'head-sha-1' };
    },
    reportPreviewChecks: async (input: ReportPreviewChecksInput): Promise<ReportPreviewChecksResult> => {
      calls.push('reportPreviewChecks');
      seen.reports.push(input);
      const failed = failedChecks(input.results);
      return { posted: true, failed, draft: failed.length > 0 };
    },
    awaitFixPrMerge: async (prUrl: string): Promise<FixPrOutcome> => {
      const n = (mergePolls[prUrl] = (mergePolls[prUrl] ?? 0) + 1);
      const plan = script.merge[prUrl];
      if (n <= plan.openPolls) throw notYet(`${prUrl} is still open.`, 'PrStillOpen');
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
      if (!live) throw notYet('No production deployment yet.', 'DeployNotLive');
      const compare = script.contains?.[`${input.mergeSha}...${live.sha}`] ? 'ahead' : 'behind';
      if (live.sha !== input.mergeSha && !compareContains(compare)) {
        throw notYet(`${live.sha} does not contain ${input.mergeSha}.`, 'DeployNotLive');
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
      liveReads++;
      const contains = script.liveFromRead !== undefined ? liveReads >= script.liveFromRead : (script.liveContains ?? true);
      // The activity's own rule (STW-653): with `requireLive`, not contained is a retryable failure.
      if (!contains && input.requireLive) throw notYet('Production serves old, which does not contain m1 (behind).', 'FixNotLive');
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
      if (input.previewOrigin) {
        seen.previewRuns.push(input);
        if (script.noBypass) {
          throw ApplicationFailure.nonRetryable('VERCEL_AUTOMATION_BYPASS_SECRET is not set on the worker.', 'PreviewBypassMissing');
        }
      }
      const pass = input.previewOrigin ? (script.previewPasses ?? true) : (script.passes ?? true);
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
    findings: { ...findings, ...verify } as Record<string, (...args: never[]) => Promise<unknown>>,
    calls,
    seen,
    file: () => finding,
    prPolls: () => prPolls,
    mergePolls: () => mergePolls,
    deployPolls: () => deployPolls,
    liveReads: () => liveReads,
  };
}

/** One worker, as on the hosted container: no `steward-heavy` poller, so a child sent there would never run. */
async function withWorkers<T>(mocks: ReturnType<typeof lifecycle>, fn: () => Promise<T>, boundMs?: number): Promise<T> {
  const findingsWorker = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: skipVerdictMeasure(mocks.findings),
    taskQueue: FINDINGS,
  });
  return await findingsWorker.runUntil(bounded(fn(), boundMs));
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
  const handle = await client.workflow.start(findingWorkflow, {
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
    const done = await skipResult(handle);
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
  // The verdict measurement's reads (STW-589) come first; `skipVerdictMeasure` leaves it unmeasured.
  // The `fix` arrived before the fix wait, so the run asks nothing about `auto_fix` (STW-645).
  assert.deepEqual(mocks.calls, [
    'writeFindingVerdict',
    'readFinding',
    'readVerifyBlock',
    'openFixIssue',
    'awaitFixPr',
    'writeFindingFix',
    'readFinding',
    'readVerifyBlock',
    'awaitPrPreview',
    'runFindingChecks',
    'reportPreviewChecks',
    'awaitFixPrMerge:merged',
    'awaitProductionDeploy:m1',
    'readFinding',
    'readFixPr',
    'readVerifyBlock',
    'runFindingChecks',
    'writeFindingVerification:resolved',
  ]);
  assert.deepEqual(mocks.seen.previews, [{ prUrl: PR_1, environment: 'Preview' }]);
  assert.equal(mocks.seen.previewRuns[0].previewOrigin, PREVIEW, 'the checks ran on the preview');
  assert.equal(mocks.seen.reports[0].sha, 'head-sha-1');
  assert.equal(mocks.seen.reports[0].results?.every((row) => row.pass), true);
});

test('auto_fix: the approved verdict goes to the issue with no fix signal, and the run waits on the PR', async () => {
  const mocks = lifecycle({
    autoFix: true,
    prPolls: [3],
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
  });
  const result = await withWorkers(mocks, async () => {
    const handle = await client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-auto-fix',
      taskQueue: FINDINGS,
      args: [input('auto-fix')],
    });
    await handle.signal(verdictSignal, APPROVE);
    const waiting = await untilState(handle, (s) => s.step === 'fixing' && Boolean(s.issueUrl), 'fixing with an issue');
    assert.equal(waiting.issueUrl, ISSUE_1, 'the issue is in the state while the run waits for the PR');
    assert.equal(waiting.prUrl, null);
    return skipResult(handle);
  });

  assert.equal(result.outcome, 'resolved');
  assert.equal(result.prUrl, PR_1);
  assert.equal(result.fixAttempts, 1);
  assert.deepEqual(mocks.calls.slice(0, 7), ['writeFindingVerdict', 'readFinding', 'readVerifyBlock', 'readSiteAutoFix', 'openFixIssue', 'awaitFixPr', 'writeFindingFix']);
});

test('without auto_fix the approved run waits at waiting-fix and opens no issue', async () => {
  const mocks = lifecycle({ autoFix: false, merge: {} });
  await withWorkers(mocks, async () => {
    const handle = await client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-no-auto-fix',
      taskQueue: FINDINGS,
      args: [input('no-auto-fix')],
    });
    await handle.signal(verdictSignal, APPROVE);
    await untilState(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
    await env.sleep('10 minutes');
    assert.equal((await handle.query(findingStateQuery)).step, 'waiting-fix');
    assert.deepEqual(mocks.calls, ['writeFindingVerdict', 'readFinding', 'readVerifyBlock', 'readSiteAutoFix']);
    await handle.terminate('test over');
  });
});

const DIRECTION = { autoFix: true, kind: 'direction', refusal: 'its kind is direction, not defect or opportunity' };

test('auto_fix on, a finding the gate refuses: the approved run parks at waiting-fix with no attempt and no issue', async () => {
  const mocks = lifecycle({ settings: DIRECTION, merge: {} });
  await withWorkers(mocks, async () => {
    const handle = await client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-opportunity-parks',
      taskQueue: FINDINGS,
      args: [input('opportunity-parks')],
    });
    await handle.signal(verdictSignal, APPROVE);
    await untilState(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
    await env.sleep('10 minutes');
    const state = await handle.query(findingStateQuery);
    assert.equal(state.step, 'waiting-fix');
    assert.equal(state.fixAttempts, 0);
    assert.equal(state.lastFixError, `${DEFECT_KEY} does not go to the fixer: its kind is direction, not defect or opportunity.`);
    assert.equal(state.waitsForPerson, true);
    assert.deepEqual(
      mocks.calls,
      ['writeFindingVerdict', 'readFindingSettings', 'readFinding', 'readVerifyBlock', 'readFindingSettings'],
      'no slot was asked for and no openFixIssue was scheduled',
    );
    await handle.terminate('test over');
  });
});

test('a fix signal on the parked finding runs the attempt, and the waiting reason clears', async () => {
  const mocks = lifecycle({ settings: DIRECTION, prPolls: [3], merge: {} });
  await withWorkers(mocks, async () => {
    const handle = await client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-opportunity-fix-signal',
      taskQueue: FINDINGS,
      args: [input('opportunity-fix-signal')],
    });
    await handle.signal(verdictSignal, APPROVE);
    await untilState(handle, (s) => s.step === 'waiting-fix' && s.waitsForPerson === true, 'parked');
    await handle.signal(fixSignal, FIX);
    const fixing = await untilState(handle, (s) => s.step === 'fixing' && Boolean(s.issueUrl), 'fixing with an issue');
    assert.equal(fixing.fixAttempts, 1);
    assert.equal(fixing.waitsForPerson, false);
    assert.deepEqual(mocks.calls.slice(0, 6), ['writeFindingVerdict', 'readFindingSettings', 'readFinding', 'readVerifyBlock', 'readFindingSettings', 'openFixIssue']);
    await handle.terminate('test over');
  });
});

test('a check fails on production: the run parks at verify, says so once on the PR, and a resume that passes ends it resolved', async () => {
  // No timer before the park: one PR poll, an open-free merge and a live deploy, so it runs in real time.
  const script: Script = {
    prPolls: [0],
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
    passes: false,
  };
  const mocks = lifecycle(script);
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('reopened');
    const parked = await untilState(handle, (s) => s.step === 'parked', 'parked');
    assert.equal(parked.parked?.kind, 'checks-failed');
    assert.equal(parked.parked?.stage, 'verify');
    assert.match(parked.parked?.reason ?? '', /^Production at m1 failed check 1 \(text on https:\/\/www\.mattpyle\.com\/scorecard\/\) expected contains "1 axe violation \(Fail\)" and measured 0 occurrences\. The finding is reopened\.$/);
    assert.match(parked.parked?.moves ?? '', /steward finding resume .+ verifies again; `steward finding fix .+` starts a new fix attempt\.$/);
    assert.equal(mocks.seen.verification?.verification.status, 'reopened', 'the child wrote the file reopened');
    const memo = (await handle.describe()).memo as Record<string, unknown> | undefined;
    assert.match(String(memo?.waitsFor), /^parked at verify \(checks failed\): Production at m1 failed/);
    assert.equal(mocks.seen.comments.length, 1, 'one comment on the PR');
    assert.equal(mocks.seen.comments[0].prUrl, PR_1);
    assert.match(mocks.seen.comments[0].body, /^Steward verified this fix on production, and a check failed\./);
    assert.match(mocks.seen.comments[0].marker, /^<!-- steward-finding-park mattpyle-com\/.+ attempt-1 park-checks-failed-verify -->$/);

    // A resume that fails the same way parks again with no second comment.
    const again = await handle.executeUpdate(resumeUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:00:00Z' }] });
    assert.deepEqual(again, { stage: 'verify', attempt: 1 });
    await untilState(handle, (s) => s.step === 'parked' && mocks.calls.filter((c) => c === 'writeFindingVerification:reopened').length === 2, 'parked a second time');
    assert.equal(mocks.seen.comments.length, 1, 'a repeat adds no comment');

    // The check is corrected (or production fixed): the next resume passes.
    script.passes = true;
    // `steward finding resume` and the console's Verify find the parked run and send the same Update.
    const key = handle.workflowId.split('/')[2];
    assert.equal((await parkedRun(client, 'mattpyle-com', key))?.parked?.stage, 'verify');
    const resumed = await requestResume(client, 'mattpyle-com', key, '2026-10-15T09:00:00Z');
    assert.equal(resumed.workflowId, handle.workflowId);
    return (await handle.result()) as FindingWorkflowResult;
  });

  assert.equal(result.outcome, 'resolved');
  assert.equal(mocks.calls.at(-1), 'writeFindingVerification:resolved');
  assert.equal(mocks.calls.filter((c) => c === 'openFixIssue').length, 1, 'no second fix was opened by the run');
});

test('merged and deployed, and the finding has no verify block: confirmed by the deploy, written resolved', async () => {
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
    noBlock: true,
  });
  const result = await withWorkers(mocks, async () => skipResult(await startApproved('confirmed')));

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

test('no verify block, and production does not yet contain the fix: the verify retries in its slow phase until it does, then confirms', async () => {
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
    noBlock: true,
    // Three fast reads and one slow one find the old deploy; the fifth finds the fix.
    liveFromRead: 5,
  });
  const result = await withWorkers(mocks, async () => skipResult(await startApproved('not-contained')));

  assert.equal(result.outcome, 'confirmed');
  assert.equal(mocks.liveReads(), 5);
  assert.equal(mocks.seen.comments.length, 0, 'nobody is told');
  assert.equal(mocks.calls.at(-1), 'writeFindingVerification:resolved');
});

test('a broken check parks the run, and a fix Update starts a second attempt in the same run that records the first', async () => {
  const script: Script = {
    prPolls: [0, 0],
    merge: {
      [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') },
      [PR_2]: { openPolls: 0, outcome: merged(PR_2, 'm2') },
    },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }], [{ id: 3, sha: 'm2', state: 'success' }]],
  };
  const mocks = lifecycle(script);
  const checks = mocks.findings.runFindingChecks as unknown as (input: RunFindingChecksInput) => Promise<unknown>;
  let broken = true;
  mocks.findings.runFindingChecks = async (input: RunFindingChecksInput) => {
    if (!input.previewOrigin && broken) {
      throw ApplicationFailure.nonRetryable('check 1: the selector does not parse', 'VerifyCheckBroken');
    }
    return checks(input);
  };
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('broken');
    const parked = await untilState(handle, (s) => s.step === 'parked', 'parked');
    assert.equal(parked.parked?.kind, 'checks-broken');
    assert.match(mocks.seen.comments[0].body, /^Steward could not verify this fix: a check of the finding is broken or invalid\./);

    broken = false;
    const accepted = await handle.executeUpdate(requestFixUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:00:00Z' }] });
    assert.deepEqual(accepted, { attempt: 2 });
    return (await handle.result()) as FindingWorkflowResult;
  });

  assert.equal(result.outcome, 'resolved');
  assert.equal(result.fixAttempts, 2);
  assert.equal(result.prUrl, PR_2);
  assert.equal(mocks.calls.filter((c) => c === 'openFixIssue').length, 2);
  assert.equal(mocks.seen.issues[1].afterPr, PR_1, 'the gate reads the earlier PR\'s file as approved');
  assert.equal(mocks.seen.issues[1].supersedes?.url, ISSUE_1);
  assert.match(mocks.seen.issues[1].supersedes?.reason ?? '', /^https:\/\/github\.com\/.+\/pull\/401 merged at m1, and The verify verify\/.+ failed: check 1: the selector does not parse\.$/);
  assert.equal(mocks.seen.fixes[1].earlier?.prUrl, PR_1);
  // The file holds both attempts: the new PR in links, the earlier one under `## Fix attempts`.
  const file = mocks.file();
  assert.match(file, new RegExp(`^  pr: ${PR_2}$`, 'm'));
  assert.match(file, /^## Fix attempts$/m);
  assert.match(file, new RegExp(`^- .+: ${PR_1} merged at m1, and The verify .+ A new fix was asked for\\.$`, 'm'));
});

test('a PR closed unmerged writes approved back, and the next fix closes the first issue naming the PR and opens a second', async () => {
  // No timer anywhere: the run reaches both of its waiting-fix states in real
  // time, so the test needs no time skipping and the plain client finishes it.
  const mocks = lifecycle({
    prPolls: [0, 0],
    merge: {
      [PR_1]: { openPolls: 0, outcome: { prUrl: PR_1, state: 'closed', mergeSha: null, at: '2026-10-13T19:00:00Z' } },
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
      'awaitPrPreview',
      'awaitFixPrMerge:closed',
      'writeFindingReturned',
      'openFixIssue',
      'awaitFixPr',
      'writeFindingFix',
      'awaitPrPreview',
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
    const done = skipResult(handle).catch(() => undefined);
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

test('a deploy that never serves the merge commit: after 24 hours the run says so once and keeps waiting, every 15 minutes', async () => {
  const mocks = lifecycle({
    prPolls: [0],
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 1, sha: 'old', state: 'success' }]],
  });
  await withWorkers(mocks, async () => {
    const handle = await startApproved('deploy-timeout');
    await untilState(handle, (s) => s.step === 'waiting-deploy', 'waiting-deploy');
    // The test's one time-skipping await: a day and a half.
    await env.sleep('36 hours');
    const state = await handle.query(findingStateQuery);
    assert.equal(state.step, 'waiting-deploy');
    assert.match(state.waitNote ?? '', /^Production did not serve m1 within 24 hours of the merge\. Waiting on since /);
    assert.equal((await handle.describe()).status.name, 'RUNNING');
    const memo = (await handle.describe()).memo as Record<string, unknown> | undefined;
    assert.match(String(memo?.waitsFor), /^waiting on the deploy past its first bound/);
    await handle.terminate('test over');
  });
  // Every 2 minutes for 24 hours, then every 15 for the next 12: about 720 and 48.
  const polls = mocks.deployPolls();
  assert.ok(polls >= 740 && polls <= 775, `polled ${polls} times`);
  assert.equal(mocks.seen.comments.length, 1, 'said once on the PR');
  assert.match(mocks.seen.comments[0].body, /^Production did not serve m1 within 24 hours of the merge\.\n\nThe run keeps waiting, now every 15 minutes/);
  assert.ok(!mocks.calls.some((c) => c.startsWith('writeFindingVerification')), 'nothing was verified');
});

test('a PR nobody merges or closes: after 30 days the run says so once and keeps waiting on the merge', { timeout: 300_000 }, async () => {
  const mocks = lifecycle({
    prPolls: [0],
    merge: { [PR_1]: { openPolls: Number.POSITIVE_INFINITY, outcome: merged(PR_1, 'never') } },
  });
  await withWorkers(
    mocks,
    async () => {
      const handle = await startApproved('merge-timeout');
      await untilState(handle, (s) => s.step === 'waiting-merge', 'waiting-merge');
      // The one time-skipping await. 31 days of 5-minute polls take tens of seconds on CI.
      await env.sleep('31 days');
      const state = await handle.query(findingStateQuery);
      assert.equal(state.step, 'waiting-merge');
      assert.match(state.waitNote ?? '', /pull\/401 was not merged or closed within 30 days\. Waiting on since /);
      assert.equal((await handle.describe()).status.name, 'RUNNING');
      await handle.terminate('test over');
    },
    240_000,
  );
  // Every 5 minutes: 8,640 polls in the first 30 days, and the wait went on past them.
  const polls = mocks.mergePolls()[PR_1];
  assert.ok(polls > 8641, `polled ${polls} times`);
  assert.equal(mocks.seen.comments.length, 1);
  assert.match(mocks.seen.comments[0].body, /was not merged or closed within 30 days\.\n\nThe run keeps waiting: it goes on when this PR is merged or closed\./);
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
  const result = await withWorkers(mocks, async () => skipResult(await startApproved('two-merges')));

  assert.equal(result.outcome, 'resolved');
  assert.equal(result.mergeSha, 'm1');
  assert.equal(result.liveSha, 'm2');
  assert.equal(mocks.deployPolls(), 3);
});

/**
 * Polls the run's state with the plain client until `ready` holds, in real
 * time, and fails after `limitMs` rather than spinning until CI kills the job.
 */
async function untilState(
  handle: Pick<WorkflowHandle<typeof findingWorkflow>, 'query'>,
  ready: (state: FindingState) => boolean,
  what: string,
  everyMs = 100,
  limitMs = 30_000,
) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const state = await handle.query(findingStateQuery);
    if (ready(state)) return state;
    if (Date.now() > deadline) assert.fail(`the run never reached ${what}; it is at ${state.step}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

test('a fix sent before the verdict is dropped', async () => {
  const mocks = lifecycle({ merge: {} });
  await withWorkers(mocks, async () => {
    const handle = await client.workflow.start(findingWorkflow, {
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
  });
});

test('a rejected verdict ends a resolved run at the gate', async () => {
  const mocks = lifecycle({ merge: {} });
  const result = await withWorkers(mocks, async () => {
    const handle = await client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-rejected',
      taskQueue: FINDINGS,
      args: [input('rejected')],
    });
    await handle.signal(verdictSignal, { ...APPROVE, status: 'rejected', reason: 'By design.' });
    return skipResult(handle);
  });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(mocks.calls, ['writeFindingVerdict']);
});

// ---------------------------------------------------------------------------
// The preview test (fix-pr-runs-the-verify-block)
// ---------------------------------------------------------------------------

/** A resolved run's final state, read after its result. */
async function finalState(handle: { workflowId: string }): Promise<FindingState> {
  return await client.workflow.getHandle(handle.workflowId).query(findingStateQuery);
}

const mergedAtOnce = { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } };
const liveAtOnce = [[{ id: 2, sha: 'm1', state: 'success' as const }]];

test('the preview test: a failing check is reported with its measured value, and the run waits on the merge as before', async () => {
  const mocks = lifecycle({ merge: mergedAtOnce, deploys: liveAtOnce, previewPasses: false, previewPolls: 2 });
  let state!: FindingState;
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('preview-fails');
    const done = await skipResult(handle);
    state = await finalState(handle);
    return done;
  });

  assert.equal(mocks.seen.previews.length, 3, 'two "not yet" polls, then the preview');
  assert.equal(mocks.seen.reports.length, 1);
  const report = mocks.seen.reports[0];
  assert.equal(report.prUrl, PR_1);
  assert.equal(report.sha, 'head-sha-1');
  assert.equal(report.results?.[0].pass, false);
  assert.equal(report.results?.[0].expected, 'contains "1 axe violation (Fail)"');
  assert.equal(report.results?.[0].measured, '0 occurrences');
  assert.equal(state.previewResult, 'check 1 of 1 fails on the preview; PR marked draft');
  // The finding itself is judged on production, and production passed.
  assert.equal(result.outcome, 'resolved');
  assert.ok(mocks.calls.indexOf('reportPreviewChecks') < mocks.calls.indexOf('awaitFixPrMerge:merged'), 'the preview test comes first');
});

test('the preview test: every check passing is reported, and the line says so', async () => {
  const mocks = lifecycle({ merge: mergedAtOnce, deploys: liveAtOnce });
  let state!: FindingState;
  await withWorkers(mocks, async () => {
    const handle = await startApproved('preview-passes');
    const done = await skipResult(handle);
    state = await finalState(handle);
    return done;
  });
  assert.equal(mocks.seen.reports.length, 1);
  assert.equal(mocks.seen.reports[0].results?.[0].pass, true);
  assert.equal(state.previewResult, '1 of 1 check passes on the preview');
});

test('the preview test: a finding with no checks skips the step, waits for no preview and posts nothing', async () => {
  const mocks = lifecycle({ merge: mergedAtOnce, deploys: liveAtOnce, noBlock: true });
  let state!: FindingState;
  await withWorkers(mocks, async () => {
    const handle = await startApproved('preview-skipped');
    const done = await skipResult(handle);
    state = await finalState(handle);
    return done;
  });
  assert.deepEqual(mocks.seen.previews, []);
  assert.deepEqual(mocks.seen.reports, []);
  assert.equal(state.previewResult, 'skipped: the finding has no checks');
});

test('the preview test: a preview that never comes is unmeasured after 30 minutes, and the merge wait goes on', async () => {
  const mocks = lifecycle({ merge: mergedAtOnce, deploys: liveAtOnce, previewNever: true });
  let state!: FindingState;
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('preview-never');
    const done = await skipResult(handle);
    state = await finalState(handle);
    return done;
  });
  assert.equal(state.previewResult, 'unmeasured: No Preview deployment of the PR head was ready within 30 minutes.');
  assert.equal(mocks.seen.reports[0].results, null);
  assert.equal(mocks.seen.reports[0].note, 'No Preview deployment of the PR head was ready within 30 minutes.');
  assert.deepEqual(mocks.seen.previewRuns, [], 'no check ran');
  assert.equal(result.outcome, 'resolved');
});

test('the preview test: a build that failed is unmeasured with the reason, not a failed fix', async () => {
  const mocks = lifecycle({ merge: mergedAtOnce, deploys: liveAtOnce, previewFail: 'PreviewFailed' });
  let state!: FindingState;
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('preview-build-failed');
    const done = await skipResult(handle);
    state = await finalState(handle);
    return done;
  });
  assert.match(state.previewResult ?? '', /^unmeasured: .*ended failure/);
  assert.equal(mocks.seen.reports[0].results, null);
  assert.equal(result.outcome, 'resolved');
});

test('the preview test: a worker without the bypass secret records the step as unmeasured, and the fix goes on', async () => {
  const mocks = lifecycle({ merge: mergedAtOnce, deploys: liveAtOnce, noBypass: true });
  let state!: FindingState;
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('preview-no-bypass');
    const done = await skipResult(handle);
    state = await finalState(handle);
    return done;
  });
  assert.match(state.previewResult ?? '', /^unmeasured: The checks did not run on .*VERCEL_AUTOMATION_BYPASS_SECRET is not set/);
  assert.equal(mocks.seen.previewRuns.length, 1, 'a non-retryable failure is tried once');
  assert.equal(mocks.seen.reports[0].results, null);
  assert.equal(mocks.seen.reports[0].sha, 'head-sha-1');
  assert.equal(result.outcome, 'resolved');
});

test('a returned write that fails non-retryably parks the run, where SDK 1.25.0 would have failed it', async () => {
  // A rethrown ActivityFailure is a TemporalFailure, and the SDK fails the
  // Workflow Execution on one (`handleWorkflowFailure` in
  // `@temporalio/workflow/src/internals.ts`). On the code before STW-653 this
  // test read FAILED; the history of that is commit 6c00ebc.
  const mocks = lifecycle({
    prPolls: [0],
    merge: { [PR_1]: { openPolls: 0, outcome: { prUrl: PR_1, state: 'closed', mergeSha: null, at: '2026-10-13T19:00:00Z' } } },
  });
  mocks.findings.writeFindingReturned = async () => {
    throw ApplicationFailure.nonRetryable('sites/mattpyle-com/findings/x.md has no index line.', 'FindingMissing');
  };
  await withWorkers(mocks, async () => {
    const handle = await startApproved('returned-fails');
    const parked = await untilState(handle, (s) => s.step === 'parked', 'parked');
    assert.equal(parked.parked?.kind, 'error');
    assert.equal(parked.parked?.stage, 'returned');
    assert.match(parked.parked?.reason ?? '', /closed unmerged, and the finding was not written back to approved: .+has no index line\.\.?$/);
    assert.equal((await handle.describe()).status.name, 'RUNNING');
    await handle.terminate('test over');
  });
});

test('a returned write refused because the file was decided elsewhere ends the run closed', async () => {
  const mocks = lifecycle({
    prPolls: [0],
    merge: { [PR_1]: { openPolls: 0, outcome: { prUrl: PR_1, state: 'closed', mergeSha: null, at: '2026-10-13T19:00:00Z' } } },
  });
  let decided = false;
  mocks.findings.writeFindingReturned = async () => {
    decided = true;
    throw ApplicationFailure.nonRetryable('the finding is resolved, not fixing.', 'FindingMoved');
  };
  mocks.findings.readFindingSettings = async () => settings({ status: decided ? 'resolved' : 'approved' });
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('returned-moved');
    return (await handle.result()) as FindingWorkflowResult;
  });
  assert.equal(result.outcome, 'closed');
  assert.match(result.note ?? '', /the finding file says resolved\.$/);
});

test('a returned write that uses up its fast retries goes on in the slow phase and tells nobody', async () => {
  const mocks = lifecycle({
    prPolls: [0],
    merge: { [PR_1]: { openPolls: 0, outcome: { prUrl: PR_1, state: 'closed', mergeSha: null, at: '2026-10-13T19:00:00Z' } } },
  });
  const attempts: { retryAuth?: boolean }[] = [];
  mocks.findings.writeFindingReturned = async (input: WriteFindingReturnedInput) => {
    attempts.push({ retryAuth: input.retryAuth });
    // GitHub answers 502 for the five fast attempts and the first slow one.
    if (attempts.length <= 6) throw notYet('GitHub answered 502.', 'GitHubUnavailable');
    return { findingCommitSha: 'c-r1', indexCommitSha: 'c-r2', commitSha: 'c-r2' };
  };
  await withWorkers(mocks, async () => {
    const handle = await startApproved('returned-slow');
    await untilState(handle, (s) => s.step === 'waiting-merge', 'waiting-merge');
    // The one time-skipping await: the fast backoff and two slow intervals.
    await env.sleep('40 minutes');
    const state = await handle.query(findingStateQuery);
    assert.equal(state.step, 'waiting-fix', 'written back, so the run waits for the next fix as before');
    await handle.terminate('test over');
  });
  assert.equal(attempts.length, 7);
  assert.deepEqual(attempts.slice(0, 5).map((a) => a.retryAuth), [undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(attempts.slice(5).map((a) => a.retryAuth), [true, true], 'the slow phase retries a rejected credential too');
  assert.equal(mocks.seen.comments.length, 0, 'nobody is told');
});

test('a merge wait that fails for good parks at merge: a fix is refused with the reason, and resume waits on the merge again', async () => {
  const mocks = lifecycle({
    prPolls: [0],
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
  });
  const merge = mocks.findings.awaitFixPrMerge as unknown as (prUrl: string) => Promise<FixPrOutcome>;
  let gone = true;
  mocks.findings.awaitFixPrMerge = async (prUrl: string) => {
    if (gone) throw ApplicationFailure.nonRetryable(`${prUrl} answered 404.`, 'NotFound');
    return merge(prUrl);
  };
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('merge-fails');
    const parked = await untilState(handle, (s) => s.step === 'parked', 'parked');
    assert.equal(parked.parked?.stage, 'merge');
    assert.match(parked.parked?.moves ?? '', /waits on the merge again\.$/);
    await assert.rejects(
      handle.executeUpdate(requestFixUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:00:00Z' }] }),
      (err: Error) => /is not merged and may still be open: close it, then send resume/.test(String((err as { cause?: Error }).cause?.message ?? err.message)),
    );
    gone = false;
    await handle.executeUpdate(resumeUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:05:00Z' }] });
    return (await handle.result()) as FindingWorkflowResult;
  });
  assert.equal(result.outcome, 'resolved');
});

test('the Updates refuse a run that is not parked, each with its reason', async () => {
  const mocks = lifecycle({ merge: {} });
  await withWorkers(mocks, async () => {
    const handle = await client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/lifecycle-not-parked',
      taskQueue: FINDINGS,
      args: [input('not-parked')],
    });
    const why = (err: unknown) => String((err as { cause?: Error }).cause?.message ?? (err as Error).message);
    await assert.rejects(handle.executeUpdate(resumeUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:00:00Z' }] }), (err) =>
      /^The run is not parked: it is at waiting-verdict\.$/.test(why(err)),
    );
    await assert.rejects(handle.executeUpdate(requestFixUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:00:00Z' }] }), (err) =>
      /^The run has no verdict yet: approve the finding first\.$/.test(why(err)),
    );
    assert.equal(await parkedRun(client, 'mattpyle-com', 'lifecycle-not-parked'), null);
    await assert.rejects(
      requestResume(client, 'mattpyle-com', 'lifecycle-not-parked', '2026-10-14T09:00:00Z'),
      (err) => err instanceof ResumeRefused && err.message === 'Steward did not resume lifecycle-not-parked: The run is not parked: it is at waiting-verdict.',
    );
    await handle.terminate('test over');
  });
});

test('the open-until-verified marker is the exported constant', () => {
  assert.equal(OPEN_UNTIL_VERIFIED_PATCH, 'open-until-verified');
});

test('the verifier cannot reach production or GitHub: its slow phase retries until it can, nobody is told, and the run ends resolved', async () => {
  const mocks = lifecycle({
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }]],
  });
  const checks = mocks.findings.runFindingChecks as unknown as (input: RunFindingChecksInput) => Promise<unknown>;
  const readPr = mocks.findings.readFixPr as unknown as (prUrl: string) => Promise<unknown>;
  let checkRuns = 0;
  const prReads: unknown[] = [];
  mocks.findings.readFixPr = async (prUrl: string, options?: { retryAuth?: boolean }) => {
    prReads.push(options);
    // A token rotation: the GitHub client's AuthError is non-retryable unless the call asks otherwise.
    if (!options?.retryAuth) throw ApplicationFailure.nonRetryable('GitHub rejected the credential (401).', 'AuthError');
    return readPr(prUrl);
  };
  mocks.findings.runFindingChecks = async (input: RunFindingChecksInput) => {
    if (!input.previewOrigin) {
      checkRuns++;
      // Production answers 503 for the three fast attempts and the first slow one.
      if (checkRuns <= 4) throw notYet('https://www.mattpyle.com/scorecard/ answered 503', 'CheckUnavailable');
    }
    return checks(input);
  };
  const result = await withWorkers(mocks, async () => skipResult(await startApproved('slow-verify')));

  assert.equal(result.outcome, 'resolved');
  assert.equal(checkRuns, 5);
  assert.deepEqual(prReads, [undefined, { retryAuth: true }], 'the fast read, then the slow one that retries the credential');
  assert.equal(mocks.seen.comments.length, 0, 'nobody is told');
});

/** The script of a run that merges, deploys and parks at its verify on a failed check, with no timer on the way. */
function parksAtVerify(): Script {
  return {
    prPolls: [0, 0],
    merge: { [PR_1]: { openPolls: 0, outcome: merged(PR_1, 'm1') }, [PR_2]: { openPolls: 0, outcome: merged(PR_2, 'm2') } },
    deploys: [[{ id: 2, sha: 'm1', state: 'success' }], [{ id: 3, sha: 'm2', state: 'success' }]],
    passes: false,
  };
}

const EventType = proto.temporal.api.enums.v1.EventType;
const TASK_EVENTS: number[] = [
  EventType.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED,
  EventType.EVENT_TYPE_WORKFLOW_TASK_STARTED,
  EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED,
  EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED,
  EventType.EVENT_TYPE_WORKFLOW_TASK_TIMED_OUT,
];

/**
 * Waits until the history holds no open workflow task and no activity without
 * its result, so a worker stopped now holds nothing (STW-659). A `state` query
 * says `parked` before the park's comment activity runs: `park()` sets the step
 * first. The time-skipping server leaves `pendingWorkflowTask` empty in
 * `describe`, so both are read from the history.
 *
 * Probe: the history read at the moment the query first answered `parked`
 * ended in WORKFLOW_TASK_STARTED in 6 runs of 12, so the first worker would
 * have stopped holding an open task. A worker that stops with its task poll in
 * flight loses the task until its timeout; `finding-retest.test.ts`,
 * `pollSettled`, records that probe.
 */
async function idle(handle: WorkflowHandle, limitMs = 5_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  let last = 'no history read';
  while (Date.now() < deadline) {
    const events = (await handle.fetchHistory()).events ?? [];
    const lastTask = events.findLast((e) => TASK_EVENTS.includes(e.eventType as number));
    const taskOpen =
      lastTask?.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED || lastTask?.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_STARTED;
    const closed = new Set(
      events
        .map(
          (e) =>
            (
              e.activityTaskCompletedEventAttributes ??
              e.activityTaskFailedEventAttributes ??
              e.activityTaskTimedOutEventAttributes ??
              e.activityTaskCanceledEventAttributes
            )?.scheduledEventId,
        )
        .filter((n) => n != null)
        .map(String),
    );
    const open = events.filter((e) => e.activityTaskScheduledEventAttributes && !closed.has(String(e.eventId)));
    if (!taskOpen && open.length === 0) return;
    last = `${taskOpen ? `workflow task open at event ${lastTask?.eventId}` : 'no open workflow task'}; activities without a result: ${open.map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name).join(', ') || 'none'}`;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`the run did not settle within ${limitMs / 1000} s: ${last}`);
}

/**
 * Waits until the server has admitted each Update in `updateIds` (STW-659):
 * `PollWorkflowExecutionUpdate` at the ADMITTED stage answers once the server
 * holds it and fails with NotFound before. Each poll has a 1-second deadline,
 * so an Update the server never takes ends the wait at `limitMs`.
 *
 * Why not the 1500 ms sleep it replaces. Probe, on the time-skipping server:
 * with the request-fix send delayed 1.6 s, the sleep started the second worker
 * before that Update was sent, and the test still passed, so it could not see
 * the two Updates reach different workflow tasks. This wait started the second
 * worker 27 ms after the delayed send. An Update ID never sent stayed
 * unadmitted for the whole 2-second limit given.
 */
async function admitted(workflowId: string, updateIds: string[], limitMs = 10_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  const waiting = new Set(updateIds);
  while (waiting.size > 0 && Date.now() < deadline) {
    for (const updateId of [...waiting]) {
      try {
        await client.connection.withDeadline(Date.now() + 1_000, () =>
          client.workflowService.pollWorkflowExecutionUpdate({
            namespace: client.options.namespace,
            updateRef: { workflowExecution: { workflowId }, updateId },
            identity: 'finding-lifecycle test',
            waitPolicy: { lifecycleStage: proto.temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ADMITTED },
          }),
        );
        waiting.delete(updateId);
      } catch {
        // Not admitted yet.
      }
    }
    if (waiting.size > 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (waiting.size > 0) assert.fail(`the server did not admit ${[...waiting].join(', ')} within ${limitMs / 1000} s`);
}

/** The sentence an Update's refusal carries to its sender. */
const refusalOf = (err: unknown) => String((err as { cause?: Error }).cause?.message ?? (err as Error).message);

test('a parked run takes a rejected verdict: it writes it and ends rejected, and a repeated approval changes nothing', async () => {
  const mocks = lifecycle(parksAtVerify());
  const written: string[] = [];
  mocks.findings.writeFindingVerdict = async (input: { status: string }) => {
    written.push(input.status);
    return { findingCommitSha: 'c-v1', indexCommitSha: `c-${input.status}`, commitSha: `c-${input.status}` };
  };
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('reject-parked');
    await untilState(handle, (s) => s.step === 'parked', 'parked');
    const again = await handle.executeUpdate(verdictUpdate, { args: [APPROVE] });
    assert.equal(again.first, false, 'a repeated approval is answered with the first');
    assert.equal((await handle.query(findingStateQuery)).step, 'parked', 'and the run stays parked');
    const rejected = await handle.executeUpdate(verdictUpdate, {
      args: [{ status: 'rejected', reason: 'Not worth a second fix.', source: 'cli', at: '2026-10-14T09:00:00Z' }],
    });
    assert.equal(rejected.first, true);
    assert.equal(rejected.verdict.status, 'rejected');
    assert.equal(rejected.commitSha, 'c-rejected', 'the Update answers after the write');
    return (await handle.result()) as FindingWorkflowResult;
  });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.verdict.status, 'rejected');
  assert.deepEqual(written, ['approved', 'rejected']);
  assert.equal(mocks.calls.filter((c) => c === 'openFixIssue').length, 1);
});

test('the other verdict is still refused away from a park', async () => {
  const mocks = lifecycle({ merge: {} });
  await withWorkers(mocks, async () => {
    const handle = await startApproved('reject-not-parked');
    await untilState(handle, (s) => s.step === 'waiting-merge' || s.step === 'fixing' || s.step === 'waiting-slot', 'past the verdict');
    await assert.rejects(
      handle.executeUpdate(verdictUpdate, { args: [{ status: 'rejected', reason: 'No.', source: 'cli', at: '2026-10-14T09:00:00Z' }] }),
      (err) => /^A verdict is already recorded: approved \(source cli\)\.$/.test(refusalOf(err)),
    );
    await handle.terminate('test over');
  });
});

test('a run cancelled while parked ends cancelled, with its slot already given back', async () => {
  const mocks = lifecycle(parksAtVerify());
  const status = await withWorkers(mocks, async () => {
    const handle = await startApproved('cancel-parked');
    await untilState(handle, (s) => s.step === 'parked', 'parked');
    await handle.cancel();
    await assert.rejects(handle.result());
    return (await handle.describe()).status.name;
  });
  assert.equal(status, 'CANCELLED');
});

test('request-fix is refused while the run measures at its verdict, and accepted once it waits for a fix', async () => {
  const mocks = lifecycle({ merge: {} });
  let release!: () => void;
  const measured = new Promise<void>((resolve) => (release = resolve));
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: {
      ...skipVerdictMeasure(mocks.findings),
      // The measurement at the verdict holds until the test lets it go, then reads as broken.
      runFindingChecks: async () => {
        await measured;
        throw ApplicationFailure.nonRetryable('not measured in this test', 'VerifyCheckBroken');
      },
    },
    taskQueue: FINDINGS,
  });
  await worker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(findingWorkflow, {
          workflowId: 'finding/mattpyle-com/lifecycle-fix-while-measuring',
          taskQueue: FINDINGS,
          args: [input('fix-while-measuring')],
        });
        await handle.signal(verdictSignal, APPROVE);
        await untilState(handle, (s) => s.step === 'measuring', 'measuring');
        await assert.rejects(handle.executeUpdate(requestFixUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:00:00Z' }] }), (err) =>
          /^The run is measuring the checks at its verdict: ask again once it waits for a fix\.$/.test(refusalOf(err)),
        );
        release();
        await untilState(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
        assert.deepEqual(await handle.executeUpdate(requestFixUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:01:00Z' }] }), { attempt: 1 });
        await untilState(handle, (s) => (s.fixAttempts ?? 0) === 1, 'the attempt started');
        await handle.terminate('test over');
      })(),
    ),
  );
});

test('a park comment that failed is posted at the next park of its kind, and one that was posted is not repeated', async () => {
  const mocks = lifecycle(parksAtVerify());
  let comments = 0;
  mocks.findings.commentOnFixPr = async (input: CommentOnFixPrInput) => {
    comments++;
    if (comments === 1) throw ApplicationFailure.nonRetryable('GitHub rejected the credential (401).', 'AuthError');
    mocks.seen.comments.push(input);
    return { posted: true };
  };
  await withWorkers(mocks, async () => {
    const handle = await startApproved('comment-retry');
    // The run sets step `parked` before its comment activity runs, and `commentError` after it returns.
    const first = await untilState(handle, (s) => s.step === 'parked' && Boolean(s.parked?.commentError), 'parked, the comment failed');
    assert.match(first.parked?.commentError ?? '', /401/);
    await handle.executeUpdate(resumeUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:00:00Z' }] });
    await untilState(handle, (s) => s.step === 'parked' && comments === 2, 'parked again, the comment posted');
    await handle.executeUpdate(resumeUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:05:00Z' }] });
    await untilState(
      handle,
      (s) => s.step === 'parked' && mocks.calls.filter((c) => c === 'writeFindingVerification:reopened').length === 3,
      'parked a third time',
    );
    await handle.terminate('test over');
  });
  assert.equal(comments, 2, 'tried twice, posted once');
  assert.equal(mocks.seen.comments.length, 1);
});

test('a deploy wait that ran out and then failed for good parks; a new attempt leaves no wait note or memo line behind', async () => {
  const script = parksAtVerify();
  script.deploys = [[{ id: 1, sha: 'old', state: 'success' }]];
  script.passes = true;
  const mocks = lifecycle(script);
  const deploy = mocks.findings.awaitProductionDeploy as unknown as (input: AwaitProductionDeployInput) => Promise<ProductionDeploy>;
  mocks.findings.awaitProductionDeploy = async (input: AwaitProductionDeployInput) => {
    if (input.mergeSha === 'm2') return { liveSha: 'm2', deploymentId: 3 };
    // The re-wait's first poll (a new activity, so attempt 1 again) answers 404: the PR's repository moved.
    if (Context.current().info.attempt === 1 && mocks.deployPolls() > 0) throw ApplicationFailure.nonRetryable('GitHub answered 404.', 'NotFound');
    return deploy(input);
  };
  const result = await withWorkers(mocks, async () => {
    const handle = await startApproved('wait-note');
    await untilState(handle, (s) => s.step === 'waiting-deploy', 'waiting-deploy');
    await env.sleep('25 hours');
    const parked = await untilState(handle, (s) => s.step === 'parked', 'parked');
    assert.equal(parked.parked?.stage, 'deploy');
    assert.match(parked.waitNote ?? '', /within 24 hours of the merge/, 'the wait it parked in is still past its bound');
    await handle.executeUpdate(requestFixUpdate, { args: [{ source: 'cli', at: '2026-10-15T09:00:00Z' }] });
    const next = await untilState(handle, (s) => (s.fixAttempts ?? 0) === 2, 'the second attempt');
    assert.equal(next.waitNote ?? null, null, 'no wait note in the new attempt');
    assert.equal(((await handle.describe()).memo as Record<string, unknown> | undefined)?.waitsFor, undefined, 'nor a memo line');
    return (await handle.result()) as FindingWorkflowResult;
  });
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.fixAttempts, 2);
});

test('resume and request-fix sent to one park in the same workflow task: one is accepted, the other refused with why', async () => {
  const mocks = lifecycle(parksAtVerify());
  const bundle = await workflowBundle();
  // No cache, so no sticky queue: a new worker takes the run's next task from the normal queue at once.
  const worker = () =>
    Worker.create({ connection: env.nativeConnection, workflowBundle: bundle, activities: skipVerdictMeasure(mocks.findings), taskQueue: FINDINGS, maxCachedWorkflows: 0 });
  const id = 'finding/mattpyle-com/lifecycle-two-updates';
  const handle = client.workflow.getHandle(id);
  await (await worker()).runUntil(
    bounded(
      (async () => {
        await client.workflow.start(findingWorkflow, { workflowId: id, taskQueue: FINDINGS, args: [input('two-updates')] });
        await handle.signal(verdictSignal, APPROVE);
        await handle.signal(fixSignal, FIX);
        await untilState(handle, (s) => s.step === 'parked', 'parked');
        await idle(handle);
      })(),
    ),
  );
  // No worker now: both Updates wait at the server, and the next worker reads them in one task.
  const sent = [
    handle.executeUpdate(resumeUpdate, { args: [{ source: 'console', at: '2026-10-14T09:00:00Z' }], updateId: 'two-updates-resume' }),
    handle.executeUpdate(requestFixUpdate, { args: [{ source: 'cli', at: '2026-10-14T09:00:00Z' }], updateId: 'two-updates-fix' }),
  ];
  for (const one of sent) one.catch(() => undefined);
  await admitted(id, ['two-updates-resume', 'two-updates-fix']);
  const settled = await (await worker()).runUntil(
    bounded(
      (async () => {
        const out = await Promise.allSettled(sent);
        await handle.terminate('test over');
        return out;
      })(),
    ),
  );
  const accepted = settled.filter((s) => s.status === 'fulfilled');
  const refused = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  assert.equal(accepted.length, 1, 'one accepted');
  assert.equal(refused.length, 1, 'one refused');
  assert.match(refusalOf(refused[0].reason), /^(A resume is already asked for: the run runs its stage again first\.|A new fix attempt is already asked for\.)$/);
});
