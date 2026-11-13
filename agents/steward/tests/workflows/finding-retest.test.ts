import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, type WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import proto from '@temporalio/proto';
import { tsToMs } from '@temporalio/common/lib/time.js';
import { bounded, createLocalEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { skipVerdictMeasure } from '../helpers/verdict-measure.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';
import {
  findingStateQuery,
  findingWorkflow,
  fixSignal,
  verdictSignal,
  type FindingState,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import {
  awaitPrPreview,
  readFinding,
  readVerifyBlock,
  reportPreviewChecks,
  type AwaitFixPrMergeOptions,
  type FixIssue,
  type FixPrOutcome,
} from '../../src/activities/findings.js';
import { BYPASS_SECRET_ENV, runFindingChecks } from '../../src/activities/verify-finding.js';
import { RetestRefused, requestRetest } from '../../src/lib/finding-retest.js';
import { PREVIEW_CHECKS_MARKER, findingWorkflowId, type FindingVerdict } from '../../src/lib/findings.js';
import { VERCEL_BYPASS_HEADER } from '../../src/lib/verify-checks.js';
import { FAKE_APP_SLUG } from '../helpers/fake-github-app.js';

/**
 * The retest end to end (STW-587): the real `findingWorkflow` with the real
 * preview test activities against the fake GitHub, as in
 * `finding-preview-test.test.ts`. The merge wait is a mock that reads the fake
 * PR every 50 ms: merged, closed, a new head (when the run passed
 * `retestAfter`), or still open. It never heartbeats, like the real one, so a
 * cancelled poll keeps reading until the PR closes and its result is dropped.
 *
 * A server per test, for the reason `finding-lifecycle.test.ts` gives. No test
 * waits on a timer, so none needs time skipping; results are read with a plain
 * `Client` and the `state` query.
 *
 * The server is a real dev server (`createLocalEnv`), not the time-skipping
 * test server (STW-593). In CI run 43354788359 the test server refused one
 * workflow task completion in the merge-and-retest test with
 * `ACTIVITY_UNKNOWN for scheduledEventId=128`, recorded no failure, and held
 * the task until its timeout. One reading, not proven: the Update won its
 * race and the refused command was the cancel of the merge poll.
 *
 * No test here depends on skipped time: the `requestFixSlot` mock answers `dispatched: false`, so the 6-hour
 * slot resend is never reached, and the merge mock's 5-minute retry backoff
 * starts only after 20 s of polling, longer than any `until` deadline.
 */

const FINDINGS = 'steward-findings';
const SITE = 'mattpyle-com';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR_NUMBER = 501;
const PR = `https://github.com/${SITE_REPO}/pull/${PR_NUMBER}`;
const PREVIEW = 'https://mattpyle-com-website-abc123-mattpyles-projects.vercel.app';
const FINDING_PATH = `sites/${SITE}/findings/${DEFECT_KEY}.md`;
const FIRST = 'aaaaaaa1111';
const SECOND = 'bbbbbbb2222';
const FAILING = 'Accessibility: 100/100 (Fail)';
const PASSING = 'Accessibility: 1 axe violation (Fail)';

/** Two checks: the page answers 200, and the label the finding wants gone is gone. */
const WITH_BLOCK = DEFECT_FINDING.replace(
  'references: []',
  [
    'references: []',
    'verify:',
    `  - url: "${ORIGIN}/scorecard/"`,
    '    kind: status',
    '    expect: 200',
    `  - url: "${ORIGIN}/scorecard/"`,
    '    kind: text',
    '    expect:',
    '      count: 0',
    '      of: "100/100 (Fail)"',
  ].join('\n'),
);

let env: TestWorkflowEnvironment;
let client: Client;
let github: FakeGitHub | undefined;
const page = { text: FAILING };
const previous = { fetch: globalThis.fetch, secret: process.env[BYPASS_SECRET_ENV] };

beforeEach(async () => {
  env = await createLocalEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  github?.restore();
  github = undefined;
  globalThis.fetch = previous.fetch;
  if (previous.secret === undefined) delete process.env[BYPASS_SECRET_ENV];
  else process.env[BYPASS_SECRET_ENV] = previous.secret;
  await env?.teardown();
});

/** The fake GitHub with the PR at {@link FIRST} and its preview, and a preview origin that serves {@link page}. */
function stage(finding = WITH_BLOCK): FakeGitHub {
  const secret = ['bypass', Math.random().toString(36).slice(2)].join('-');
  process.env[BYPASS_SECRET_ENV] = secret;
  page.text = FAILING;
  const gh = installFakeGitHub({ defaultBranch: 'main', seed: { [FINDING_PATH]: finding } });
  gh.pulls.push({ number: PR_NUMBER, head: 'claude/issue-101-x', base: 'master', title: 'Fix', body: '', draft: false, sha: FIRST });
  deploy(gh, FIRST, 7);
  const fakeGitHub = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== PREVIEW) return fakeGitHub(input, init);
    if (new Headers(init?.headers).get(VERCEL_BYPASS_HEADER) !== secret) return new Response('Authentication Required', { status: 401 });
    return new Response(`<html><body>${page.text}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  github = gh;
  return gh;
}

/** A succeeded Preview deployment of `sha`, newest first as GitHub lists them. */
function deploy(gh: FakeGitHub, sha: string, id: number): void {
  gh.deployments.unshift({ id, sha, environment: 'Preview', statuses: [{ state: 'success', environment_url: `${PREVIEW}/` }] });
}

/** A new commit on the PR, with its preview, serving `text`. */
function push(gh: FakeGitHub, sha: string, text: string): void {
  page.text = text;
  deploy(gh, sha, gh.deployments.length + 10);
  gh.pulls[0].sha = sha;
}

const none = { findingCommitSha: null, indexCommitSha: null, commitSha: null };
const mergeCalls: AwaitFixPrMergeOptions[] = [];

/**
 * The merge wait's options once the poll matching `ready` has started. The run
 * reports `waiting-merge` when it schedules the poll; on a real server the
 * worker may not have started it yet when the state query answers.
 */
async function mergeCall(ready: (o: AwaitFixPrMergeOptions) => boolean, limitMs = 5_000): Promise<AwaitFixPrMergeOptions[]> {
  const deadline = Date.now() + limitMs;
  while (!mergeCalls.some(ready)) {
    if (Date.now() > deadline) assert.fail(`no merge poll matched within ${limitMs / 1000} s; calls: ${JSON.stringify(mergeCalls)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return mergeCalls;
}

/** The merge wait as the fake PR answers it, polled every 50 ms for up to 20 seconds. */
async function awaitFixPrMerge(prUrl: string, options: AwaitFixPrMergeOptions = {}): Promise<FixPrOutcome> {
  mergeCalls.push(options);
  for (let i = 0; i < 400; i++) {
    const pull = github?.pulls[0];
    if (!pull) break;
    if (pull.merged) return { prUrl, state: 'merged', mergeSha: pull.mergeSha ?? 'merge-501', at: '2026-11-10T20:00:00Z' };
    if (pull.state === 'closed') return { prUrl, state: 'closed', mergeSha: null, at: '2026-11-10T20:00:00Z' };
    const head = pull.sha ?? '';
    if (options.retestAfter && head && head !== options.retestAfter) {
      return { prUrl, state: 'pushed', mergeSha: null, at: null, headSha: head };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw ApplicationFailure.retryable(`${prUrl} is still open.`, 'PrStillOpen');
}

const activities = {
  readFinding,
  readVerifyBlock,
  awaitPrPreview,
  runFindingChecks,
  reportPreviewChecks,
  readSiteAutoFix: async () => false,
  requestFixSlot: async () => ({ paths: [], dispatched: false }),
  openFixIssue: async (): Promise<FixIssue> => ({ repo: SITE_REPO, number: 101, url: `https://github.com/${SITE_REPO}/issues/101`, reused: false }),
  awaitFixPr: async () => ({ prUrl: PR, branch: 'claude/issue-101-x' }),
  writeFindingFix: async () => none,
  writeFindingVerdict: async () => none,
  writeFindingReturned: async () => none,
  awaitFixPrMerge,
  awaitProductionDeploy: async () => ({ liveSha: 'live-1', deploymentId: 1 }),
  readFixPr: async () => ({ prUrl: PR, merged: true, mergedAt: '2026-11-10T20:00:00Z' }),
};

const input: FindingWorkflowInput = {
  site: SITE,
  key: DEFECT_KEY,
  repo: 'mattpyle/argus',
  findingPath: FINDING_PATH,
  indexPath: `sites/${SITE}/findings/INDEX.md`,
  stopAfter: 'resolved',
  handoffPath: `sites/${SITE}/handoffs/${DEFECT_KEY}.md`,
  branch: `fix/finding-${DEFECT_KEY}`,
  origin: ORIGIN,
};

const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'file', at: '2026-11-10T18:00:00Z' };
const WORKFLOW_ID = findingWorkflowId(SITE, DEFECT_KEY);

const EventType = proto.temporal.api.enums.v1.EventType;
const TaskState = proto.temporal.api.enums.v1.PendingWorkflowTaskState;
const ActivityState = proto.temporal.api.enums.v1.PendingActivityState;
const STALLED = Symbol('stalled');

/** `promise`, or {@link STALLED} once `deadline` (epoch ms) passes. The abandoned promise's rejection is swallowed. */
function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | typeof STALLED> {
  promise.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof STALLED>((resolve) => {
    timer = setTimeout(() => resolve(STALLED), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * What the server holds for a stalled run, for the failure message: the
 * pending workflow task, the pending activities, and the run's whole history
 * with each event's offset from the first. An activity event names its
 * activity type through its scheduled event, so a refused command such as
 * "ACTIVITY_UNKNOWN for scheduledEventId=128" can be read against the list.
 * Read through the plain client, which needs no worker; bounded at 5 s so a
 * dead server cannot hang it.
 *
 * The pending workflow task is read from the history: the time-skipping
 * test server leaves `pendingWorkflowTask` empty in `describe`.
 *
 * Why: on CI on 2026-11-11 and 2026-11-13 the merge-and-retest test stalled
 * with nothing in its log but Core's "Error while completing workflow
 * activation". The next stall says where the run stood.
 */
async function stallReport(handle: WorkflowHandle): Promise<string> {
  const read = async () => {
    const [history, described] = await Promise.all([handle.fetchHistory(), handle.describe()]);
    const events = history.events ?? [];
    const t0 = events[0]?.eventTime ? tsToMs(events[0].eventTime) : Date.now();
    const at = (ts: Parameters<typeof tsToMs>[0]) => (ts ? `+${tsToMs(ts) - t0} ms` : '');
    const typeOf = new Map<string, string>();
    for (const e of events) {
      const name = e.activityTaskScheduledEventAttributes?.activityType?.name;
      if (name) typeOf.set(String(e.eventId), name);
    }
    const scheduledOf = (e: (typeof events)[number]) =>
      (
        e.activityTaskCompletedEventAttributes ??
        e.activityTaskFailedEventAttributes ??
        e.activityTaskTimedOutEventAttributes ??
        e.activityTaskCanceledEventAttributes ??
        e.activityTaskCancelRequestedEventAttributes
      )?.scheduledEventId;
    const lines = events.map((e) => {
      const name = EventType[e.eventType ?? 0]?.replace('EVENT_TYPE_', '') ?? String(e.eventType);
      const scheduled = scheduledOf(e);
      const extra = [
        e.workflowTaskStartedEventAttributes?.identity,
        e.workflowTaskTimedOutEventAttributes ? `timeout ${e.workflowTaskTimedOutEventAttributes.timeoutType}` : null,
        e.workflowTaskFailedEventAttributes ? `cause ${e.workflowTaskFailedEventAttributes.cause}` : null,
        e.activityTaskScheduledEventAttributes?.activityType?.name,
        scheduled != null ? `${typeOf.get(String(scheduled)) ?? '?'} scheduled at ${scheduled}` : null,
        e.workflowExecutionUpdateAcceptedEventAttributes?.acceptedRequest?.input?.name,
        e.workflowExecutionUpdateAdmittedEventAttributes?.request?.input?.name,
        e.workflowExecutionSignaledEventAttributes?.signalName,
      ].filter(Boolean);
      return `  ${e.eventId} ${name} ${at(e.eventTime)}${extra.length ? ` (${extra.join(', ')})` : ''}`;
    });
    // The last workflow task event says whether one is open: SCHEDULED or
    // STARTED with no COMPLETED, FAILED or TIMED_OUT after it.
    const T = EventType;
    const lastTask = events.findLast((e) =>
      [
        T.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED,
        T.EVENT_TYPE_WORKFLOW_TASK_STARTED,
        T.EVENT_TYPE_WORKFLOW_TASK_COMPLETED,
        T.EVENT_TYPE_WORKFLOW_TASK_FAILED,
        T.EVENT_TYPE_WORKFLOW_TASK_TIMED_OUT,
      ].includes(e.eventType as number),
    );
    const open =
      lastTask?.eventType === T.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED || lastTask?.eventType === T.EVENT_TYPE_WORKFLOW_TASK_STARTED;
    const task = described.raw.pendingWorkflowTask;
    const pending = task
      ? `pending workflow task (describe): ${TaskState[task.state ?? 0]}, attempt ${task.attempt}`
      : open
        ? `pending workflow task (history): ${EventType[lastTask?.eventType ?? 0]?.replace('EVENT_TYPE_', '')} at event ${lastTask?.eventId}, ${at(lastTask?.eventTime)}`
        : 'pending workflow task: none';
    const activities = (described.raw.pendingActivities ?? []).map(
      (a) => `pending activity: ${a.activityType?.name}, attempt ${a.attempt}, ${ActivityState[a.state ?? 0]}`,
    );
    return [`server state at +${Date.now() - t0} ms (wall clock):`, pending, ...activities, 'history:', ...lines].join('\n');
  };
  const report = await beforeDeadline(read().catch((err: unknown) => `the history could not be read: ${err}`), Date.now() + 5_000);
  return report === STALLED ? 'the history read did not answer within 5 s' : report;
}

/**
 * Polls the run's state until `done` holds. Each query races the deadline:
 * a query waits for a worker to answer it and has no deadline of its own, so
 * a run whose workflow task never completes would otherwise hold this loop,
 * and the test, forever.
 */
async function until(handle: WorkflowHandle, what: string, done: (s: FindingState) => boolean, limitMs = 15_000): Promise<FindingState> {
  const deadline = Date.now() + limitMs;
  let last = 'no state read';
  while (Date.now() < deadline) {
    const state = await beforeDeadline(handle.query(findingStateQuery) as Promise<FindingState>, deadline);
    if (state === STALLED) {
      last = `${last}; the last query had no answer`;
      break;
    }
    if (done(state)) return state;
    last = `step ${state.step}, ${state.previewTests} preview tests`;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the run did not reach: ${what} within ${limitMs / 1000} s (${last})\n${await stallReport(handle)}`);
}

/**
 * One phase of a test that runs its own workflow worker: `body` under a bound,
 * so the worker drains when the phase stalls, with the server's state on the
 * failure. A worker whose `runUntil` promise never settles outlives the test,
 * holds the connection open, and keeps the file's process alive.
 */
async function phase<T>(handle: WorkflowHandle, what: string, ms: number, body: Promise<T>): Promise<T> {
  try {
    return await bounded(body, ms);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("The test's workflows did not finish")) {
      throw new Error(`${what}: ${err.message}\n${await stallReport(handle)}`);
    }
    throw err;
  }
}

const merging = (n: number) => (s: FindingState) => s.step === 'waiting-merge' && s.previewTests === n;

/** Runs `body` against a started, approved and fixed run, then terminates it. */
async function scenario(body: (handle: WorkflowHandle) => Promise<void>, start = true): Promise<void> {
  mergeCalls.length = 0;
  const worker = await Worker.create({ connection: env.nativeConnection, workflowBundle: await workflowBundle(), activities: skipVerdictMeasure(activities), taskQueue: FINDINGS });
  await worker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(findingWorkflow, { workflowId: WORKFLOW_ID, taskQueue: FINDINGS, args: [input] });
        await handle.signal(verdictSignal, APPROVE);
        if (start) await handle.signal(fixSignal, { source: 'cli', at: '2026-11-10T18:05:00Z' });
        try {
          await body(handle);
        } finally {
          // Close the PR so a cancelled poll still reading it returns, then end the run.
          if (github?.pulls[0]) github.pulls[0].state = 'closed';
          await handle.terminate('test over').catch(() => undefined);
        }
      })(),
    ),
  );
}

test('a new head commit after a failed test is tested again, and a pass clears the draft Steward set', async () => {
  const gh = stage();
  await scenario(async (handle) => {
    const first = await until(handle, 'the first test', merging(1));
    assert.equal(first.previewResult, 'check 2 of 2 fails on the preview; PR marked draft');
    assert.equal(first.previewSha, FIRST);
    assert.equal(gh.pulls[0].draft, true, 'the failure made the PR a draft');
    await mergeCall((o) => o.retestAfter === FIRST);
    assert.deepEqual(mergeCalls.at(-1), { reportConflict: true, retestAfter: FIRST }, 'the merge wait names the commit it tested');

    push(gh, SECOND, PASSING);
    const second = await until(handle, 'the second test', merging(2));
    assert.equal(second.previewResult, '2 of 2 checks pass on the preview');
    assert.equal(second.previewSha, SECOND);
    assert.equal(gh.pulls[0].draft, false, 'Steward cleared its own draft');
    assert.deepEqual(
      gh.pulls[0].timeline?.map((e) => `${e.event}/${e.actor?.login}`),
      [`convert_to_draft/${FAKE_APP_SLUG}[bot]`, `ready_for_review/${FAKE_APP_SLUG}[bot]`],
    );
    const comments = gh.pulls[0].comments ?? [];
    assert.equal(comments.length, 1, 'one comment, rewritten in place');
    assert.ok(comments[0].includes(PREVIEW_CHECKS_MARKER));
    assert.match(comments[0], /for commit `bbbbbbb`/);
    assert.match(comments[0], /has marked it ready for review again/);
    assert.match(comments[0], /Earlier tests of this PR, oldest first:\n\n- `aaaaaaa`: check 2 of 2 fails on the preview; PR marked draft/);
    await mergeCall((o) => o.retestAfter === SECOND);
    assert.deepEqual(mergeCalls.at(-1), { reportConflict: true, retestAfter: SECOND });
  });
});

test('steward finding retest tests the same head again, and the failure comment names the three routes', async () => {
  const gh = stage();
  await scenario(async (handle) => {
    await until(handle, 'the first test', merging(1));
    const failure = gh.pulls[0].comments?.[0] ?? '';
    assert.match(failure, /Steward made this PR a draft, so that it does not merge by accident\./);
    assert.match(failure, /1\. The fix is wrong: comment `@claude` on this PR/);
    assert.match(failure, new RegExp(`2\\. The check or Steward is wrong: correct it, then run \`steward finding retest ${DEFECT_KEY}\``));
    assert.match(failure, /3\. Judge it yourself: mark this PR ready and merge it\./);

    // The check was wrong, and was corrected: the same commit now passes.
    page.text = PASSING;
    const accepted = await requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z');
    assert.deepEqual(accepted, { prUrl: PR, testedSha: FIRST, test: 2, workflowId: WORKFLOW_ID });

    const second = await until(handle, 'the retest', merging(2));
    assert.equal(second.previewResult, '2 of 2 checks pass on the preview');
    assert.equal(second.previewSha, FIRST, 'the same head');
    assert.equal(second.retestRequested, false);
    assert.equal(gh.pulls[0].draft, false);
    assert.match(gh.pulls[0].comments?.[0] ?? '', /- `aaaaaaa`: check 2 of 2 fails/);
  });
});

test('a retest is refused, read-only, with no run and with no open fix PR', async () => {
  stage();
  await assert.rejects(requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z'), (err: unknown) => {
    assert.ok(err instanceof RetestRefused);
    assert.match((err as Error).message, /^No run finding\/mattpyle-com\/.* has no open fix PR to test\.$/);
    return true;
  });
  await scenario(async (handle) => {
    await until(handle, 'the fix wait', (s) => s.step === 'waiting-fix');
    await assert.rejects(requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z'), (err: unknown) => {
      assert.ok(err instanceof RetestRefused);
      assert.match((err as Error).message, /The finding has no open fix PR: the run is at waiting-fix\./);
      return true;
    });
    const history = await handle.fetchHistory();
    assert.ok(
      !history.events?.some((e) => e.workflowExecutionUpdateAcceptedEventAttributes),
      'a refused Update leaves no trace in the history',
    );
  }, false);
});

test('a finding with no checks refuses a retest', async () => {
  stage(DEFECT_FINDING);
  await scenario(async (handle) => {
    await until(handle, 'the merge wait', (s) => s.step === 'waiting-merge');
    await assert.rejects(requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z'), /no checks, so there is nothing to test/);
    assert.deepEqual(await mergeCall(() => true), [{ reportConflict: true }], 'the merge wait as before the retest: no retestAfter');
  });
});

test('a pass leaves a draft a person set, and the comment names who set it', async () => {
  const gh = stage();
  await scenario(async (handle) => {
    await until(handle, 'the first test', merging(1));
    // Matt marks it ready, then makes it a draft again for his own reason.
    gh.pulls[0].timeline?.push({ event: 'ready_for_review', actor: { login: 'mattpyle' } });
    gh.pulls[0].timeline?.push({ event: 'convert_to_draft', actor: { login: 'mattpyle' } });
    push(gh, SECOND, PASSING);
    const second = await until(handle, 'the second test', merging(2));
    assert.equal(second.previewResult, '2 of 2 checks pass on the preview');
    assert.equal(gh.pulls[0].draft, true, "a person's draft stays");
    assert.match(gh.pulls[0].comments?.[0] ?? '', /This PR is still a draft: mattpyle made it one, not Steward, so Steward leaves it\./);
  });
});

test('a PR merged over a failed last test hands that result to the verify child', async () => {
  const gh = stage();
  await scenario(async (handle) => {
    await until(handle, 'the first test', merging(1));
    gh.pulls[0].merged = true;
    gh.pulls[0].mergeSha = 'merge-501';
    await until(handle, 'the end', (s) => s.step === 'done');
    const history = await handle.fetchHistory();
    const start = history.events?.find((e) => e.startChildWorkflowExecutionInitiatedEventAttributes)
      ?.startChildWorkflowExecutionInitiatedEventAttributes;
    const args = defaultPayloadConverter.fromPayload<{ previewAtMerge?: string }>(start?.input?.payloads?.[0] as any);
    assert.equal(args.previewAtMerge, 'check 2 of 2 fails on the preview; PR marked draft, at aaaaaaa');
  });
});

test('a merge and a retest in the same workflow task: the merge wins', async () => {
  const gh = stage();
  mergeCalls.length = 0;
  // A worker for the activities alone, so the workflow worker can stop while
  // the merge poll and the Update both land, and its successor reads them in
  // one workflow task.
  const activityWorker = await Worker.create({ connection: env.nativeConnection, activities: skipVerdictMeasure(activities), taskQueue: FINDINGS });
  const bundle = await workflowBundle();
  // No cache, so no sticky queue: the successor gets the task from the normal queue at once.
  const workflowWorker = () =>
    Worker.create({ connection: env.nativeConnection, workflowBundle: bundle, taskQueue: FINDINGS, maxCachedWorkflows: 0 });
  await activityWorker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(findingWorkflow, { workflowId: WORKFLOW_ID, taskQueue: FINDINGS, args: [input] });
        try {
          // Each workflow worker's phase is bounded on its own: the outer bound
          // stops only the activity worker, and an unbounded inner worker would
          // outlive the test (STW-593). 18 s + 1 s + 25 s stays under the outer 50 s.
          const first = await workflowWorker();
          await first.runUntil(
            phase(
              handle,
              'the first worker',
              18_000,
              (async () => {
                await handle.signal(verdictSignal, APPROVE);
                await handle.signal(fixSignal, { source: 'cli', at: '2026-11-10T18:05:00Z' });
                await until(handle, 'the first test', merging(1));
              })(),
            ),
          );
          // No workflow worker now. The Update waits for one; the merge lands meanwhile.
          const update = requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z');
          update.catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 500));
          gh.pulls[0].merged = true;
          gh.pulls[0].mergeSha = 'merge-501';
          await new Promise((resolve) => setTimeout(resolve, 500));
          const second = await workflowWorker();
          await second.runUntil(
            phase(
              handle,
              'the second worker',
              25_000,
              (async () => {
                const end = await until(handle, 'the end', (s) => s.step === 'done');
                assert.equal(end.previewTests, 1, 'no second test ran');
                const history = await handle.fetchHistory();
                const types = (history.events ?? [])
                  .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
                  .filter(Boolean);
                // One at the verdict (STW-589), one preview test.
                assert.equal(types.filter((t) => t === 'runFindingChecks').length, 2, 'the checks ran at the verdict and on one preview');
                assert.ok(types.includes('awaitProductionDeploy'), 'the run went on to the deploy');
                // The merge's completion and the Update are in one workflow task:
                // the task right after the poll completed accepts the Update.
                const events = history.events ?? [];
                const T = proto.temporal.api.enums.v1.EventType;
                const mergeDone = events.findIndex(
                  (e, i) => e.eventType === T.EVENT_TYPE_ACTIVITY_TASK_COMPLETED && i > events.findLastIndex((x) => x.activityTaskScheduledEventAttributes?.activityType?.name === 'awaitFixPrMerge'),
                );
                assert.deepEqual(
                  events.slice(mergeDone + 1, mergeDone + 4).map((e) => e.eventType),
                  [T.EVENT_TYPE_WORKFLOW_TASK_STARTED, T.EVENT_TYPE_WORKFLOW_TASK_COMPLETED, T.EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED],
                  'one task holds the merge result and the Update',
                );
                // Accepted before the merge settled the race, so it returns a test number no test takes.
                assert.equal((await update).test, 2);
              })(),
            ),
          );
        } finally {
          gh.pulls[0].state = 'closed';
          await handle.terminate('test over').catch(() => undefined);
        }
      })(),
    ),
  );
});
