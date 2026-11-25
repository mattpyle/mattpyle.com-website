import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowUpdateStage, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT } from '../helpers/verdict-measure.js';
import {
  findingStateQuery,
  findingWorkflow,
  measureNowUpdate,
  verdictUpdate,
  type FindingState,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import type { FindingSettings } from '../../src/activities/findings.js';
import type { WatchFindingResult } from '../../src/activities/findings-watch.js';
import type { FindingVerdict } from '../../src/lib/findings.js';
import { MeasureNowRefused, requestMeasureNow } from '../../src/lib/finding-measure-now.js';

/**
 * Stage 4 on the real `findingWorkflow` with mocked activities: a site with no
 * fixer whose settings say `watch` keeps its approved run open at `watching`,
 * and `watchFinding`, on its own queue, ends it.
 *
 * Each test has its own time-skipping server and awaits at most one thing
 * through the time-skipping client (a `result()` or one `env.sleep`), for the
 * reason `finding-lifecycle.test.ts` gives. Everything else goes through the
 * plain `client`, in real time.
 */

const FINDINGS = 'steward-findings';
const WATCH = 'steward-findings-watch';
const SITE = 'temporal-io';
const WATCHES: FindingSettings = { ...STOPS_AT_VERDICT, watch: true };

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

type Handle = WorkflowHandle<typeof findingWorkflow>;

const APPROVE: FindingVerdict = { status: 'approved', reason: 'In the file.', source: 'file', at: '2026-11-25T09:00:00.000Z' };
const REJECT: FindingVerdict = { status: 'rejected', reason: 'Not worth it.', source: 'cli', at: '2026-11-25T10:00:00.000Z' };

/** The failure a still-present finding throws: benign, until the next day. */
const stillPresent = () =>
  ApplicationFailure.create({ type: 'StillPresent', message: 'still present', nextRetryDelay: '1 day', category: ApplicationFailureCategory.BENIGN });

interface Scene {
  settings?: FindingSettings;
  /** What each `watchFinding` attempt does, by attempt across the run; the last repeats. */
  watch: Array<WatchFindingResult | 'still' | 'hold'>;
}

function mocks(scene: Scene) {
  const called: string[] = [];
  const queues: string[] = [];
  let attempts = 0;
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => (release = resolve));
  const activities = {
    readFindingSettings: async () => (called.push('readFindingSettings'), scene.settings ?? WATCHES),
    writeFindingVerdict: async () => (called.push('writeFindingVerdict'), { findingCommitSha: 'f1', indexCommitSha: 'i1', commitSha: 'v1' }),
    watchFinding: async (): Promise<WatchFindingResult> => {
      called.push('watchFinding');
      queues.push(Context.current().info.taskQueue);
      const step = scene.watch[Math.min(attempts, scene.watch.length - 1)];
      attempts++;
      if (step === 'still') throw stillPresent();
      if (step === 'hold') {
        await held;
        return { outcome: 'resolved', commitSha: 'r1', rows: [], at: '2026-11-25T11:00:00.000Z' };
      }
      return step;
    },
  };
  return {
    activities,
    called,
    queues,
    attempts: () => attempts,
    release: () => release?.(),
    count: (name: string) => called.filter((c) => c === name).length,
  };
}

function input(id: string): FindingWorkflowInput {
  return {
    site: SITE,
    key: id,
    repo: 'mattpyle/argus',
    findingPath: `sites/${SITE}/findings/${id}.md`,
    indexPath: `sites/${SITE}/findings/INDEX.md`,
    verdict: APPROVE,
  };
}

async function until(handle: Pick<Handle, 'query'>, ready: (state: FindingState) => boolean, what: string): Promise<FindingState> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = await handle.query(findingStateQuery);
    if (ready(state)) return state;
    if (Date.now() > deadline) assert.fail(`the run never reached ${what}; it is at ${state.step}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`never saw ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The workflow worker on the findings queue and the watch worker on its own, as the hosted worker runs them. */
async function workers(m: ReturnType<typeof mocks>) {
  const { watchFinding, ...rest } = m.activities;
  const findings = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: rest,
    taskQueue: FINDINGS,
  });
  const watch = await Worker.create({ connection: env.nativeConnection, activities: { watchFinding }, taskQueue: WATCH });
  return { findings, watch };
}

async function run<T>(scene: Scene, body: (m: ReturnType<typeof mocks>, start: (id: string) => Promise<Handle>) => Promise<T>) {
  const m = mocks(scene);
  const { findings, watch } = await workers(m);
  const start = (id: string) =>
    client.workflow.start(findingWorkflow, { workflowId: `finding/${SITE}/${id}`, taskQueue: FINDINGS, args: [input(id)] });
  const out = await watch.runUntil(findings.runUntil(bounded(body(m, start))));
  return { ...m, out };
}

function skipResult(handle: { workflowId: string }) {
  return env.client.workflow.getHandle<typeof findingWorkflow>(handle.workflowId).result();
}

test('a watching run fails StillPresent, waits a day for the window, and measures again, with no fix and no write', async () => {
  const { called, queues, out } = await run({ watch: ['still'] }, async (m, start) => {
    const handle = await start('still-present');
    const state = await until(handle, (s) => s.step === 'watching', 'watching');
    await waitFor(() => m.attempts() === 1, 'the first attempt');
    // The one time-skipping await: the server holds the retry for its day.
    await env.sleep('25 hours');
    await waitFor(() => m.attempts() === 2, 'the second attempt, a day later');
    const later = await handle.query(findingStateQuery);
    const pending = (await handle.describe()).raw.pendingActivities ?? [];
    await handle.terminate('test over');
    return { state, later, pending };
  });
  assert.equal(out.state.stopAfter, 'verdict');
  assert.equal(out.state.watchIssues, 1);
  assert.equal(out.later.step, 'watching');
  assert.equal(out.later.watchIssues, 1, 'a retry is not a new issue: the same activity, attempt 2');
  assert.equal(out.pending[0]?.activityType?.name, 'watchFinding');
  assert.ok((out.pending[0]?.attempt ?? 0) >= 2);
  assert.deepEqual([...new Set(queues)], [WATCH]);
  // The settings read, then the watch: no gate, slot, issue or verify, and no write of its own.
  assert.deepEqual([...new Set(called)], ['readFindingSettings', 'watchFinding']);
});

test('the watch resolves the finding: the run ends resolved', async () => {
  const { out } = await run({ watch: [{ outcome: 'resolved', commitSha: 'abcdef1234', rows: [], at: '2026-11-25T11:00:00.000Z' }] }, async (_m, start) => {
    const handle = await start('resolved');
    return await skipResult(handle);
  });
  assert.equal(out.outcome, 'resolved');
  assert.equal(out.note, 'Resolved by its own watch: every check passed on production (commit abcdef1).');
  assert.equal(out.verdict.status, 'approved');
});

test('a file decided elsewhere ends the run closed, a reopened one like any other', async () => {
  const { out } = await run({ watch: [{ outcome: 'decided', status: 'reopened' }] }, async (_m, start) => skipResult(await start('decided')));
  assert.equal(out.outcome, 'closed');
  assert.equal(out.note, 'Closed while it watched production: the finding file says reopened.');
});

test('a site that no longer watches ends the run as a run that stops at the verdict ends', async () => {
  const { out } = await run({ watch: [{ outcome: 'stopped' }] }, async (_m, start) => skipResult(await start('stopped')));
  assert.equal(out.outcome, undefined);
  assert.equal(out.verdict.status, 'approved');
});

test('a site whose settings do not watch ends at the verdict and never schedules the watch', async () => {
  const { called, out } = await run({ settings: STOPS_AT_VERDICT, watch: ['still'] }, async (_m, start) => skipResult(await start('no-watch')));
  assert.equal(out.outcome, undefined);
  assert.deepEqual(called, ['readFindingSettings']);
});

test('measure-now cancels the pending attempt and issues the watch again at once; elsewhere it is refused', async () => {
  const { out } = await run({ watch: ['still'] }, async (m, start) => {
    // A run that is not watching refuses it.
    let refused: unknown;
    try {
      await requestMeasureNow(client, SITE, 'nobody', '2026-11-25T10:00:00.000Z');
    } catch (err) {
      refused = err;
    }
    assert.ok(refused instanceof MeasureNowRefused);
    const handle = await start('measure-now');
    await until(handle, (s) => s.step === 'watching', 'watching');
    await waitFor(() => m.attempts() === 1, 'the first attempt');
    const accepted = await requestMeasureNow(client, SITE, 'measure-now', '2026-11-25T10:00:00.000Z');
    await waitFor(() => m.attempts() === 2, 'the attempt measure-now asked for');
    const state = await until(handle, (s) => (s.watchIssues ?? 0) === 2, 'the second issue');
    // A malformed one is refused by the validator.
    let malformed: unknown;
    try {
      await handle.executeUpdate(measureNowUpdate, { args: [{ source: 'nobody', at: 'x' } as never] });
    } catch (err) {
      malformed = err;
    }
    await handle.terminate('test over');
    return { accepted, state, malformed };
  });
  assert.deepEqual(out.accepted, { workflowId: `finding/${SITE}/measure-now`, issued: 'again' });
  assert.equal(out.state.step, 'watching');
  assert.ok(out.malformed instanceof Error && /malformed/.test(String((out.malformed as Error & { cause?: Error }).cause?.message)));
});

test('a rejected verdict while it watches is written, answered, and ends the run rejected', async () => {
  const { called, out } = await run({ watch: ['still'] }, async (m, start) => {
    const handle = await start('rejected');
    await until(handle, (s) => s.step === 'watching', 'watching');
    await waitFor(() => m.attempts() === 1, 'the first attempt');
    const answer = await handle.executeUpdate(verdictUpdate, { args: [REJECT] });
    return { answer, result: await skipResult(handle) };
  });
  assert.equal(out.answer.verdict.status, 'rejected');
  assert.equal(out.answer.commitSha, 'v1');
  assert.equal(out.result.outcome, 'rejected');
  assert.equal(out.result.verdict.status, 'rejected');
  assert.ok(called.includes('writeFindingVerdict'));
});

test('the 30-day bound ends a watch held by its daily delay, and the run issues it again instead of failing', async () => {
  const { out } = await run({ watch: ['still'] }, async (m, start) => {
    const handle = await start('bound');
    await until(handle, (s) => s.step === 'watching', 'watching');
    await waitFor(() => m.attempts() === 1, 'the first attempt');
    // The one time-skipping await: past the 30-day schedule-to-close bound.
    await env.sleep('32 days');
    const state = await until(handle, (s) => (s.watchIssues ?? 0) >= 2, 'the second issue');
    // The second watch's first attempt runs at once and fails, so its pending attempt is 2.
    const deadline = Date.now() + 30_000;
    let pending = (await handle.describe()).raw.pendingActivities ?? [];
    while (!((pending[0]?.attempt ?? 0) >= 2)) {
      if (Date.now() > deadline) assert.fail('the second watch never ran an attempt');
      await new Promise((r) => setTimeout(r, 50));
      pending = (await handle.describe()).raw.pendingActivities ?? [];
    }
    const status = (await handle.describe()).status.name;
    const history = await handle.fetchHistory();
    await handle.terminate('test over');
    return { state, status, pending, history };
  });
  assert.equal(out.status, 'RUNNING', 'the run did not fail on the bound');
  assert.equal(out.state.step, 'watching');
  assert.equal(out.state.watchIssues, 2);
  assert.equal(out.pending[0]?.activityType?.name, 'watchFinding');
  const events = out.history.events ?? [];
  assert.equal(events.filter((e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'watchFinding').length, 2);
  // The shape the server gives the bound when a delay would cross it: the last
  // attempt's own failure with retry state TIMEOUT, not a TimeoutFailure.
  // `isTimeout` in finding.ts reads the retry state, so both shapes re-issue.
  // Probe (2026-11-25): an `isTimeout` that read only a TimeoutFailure cause left the
  // run failing its first watch, and this test failed at the second issue; reverted.
  const close = events.find((e) => e.activityTaskFailedEventAttributes || e.activityTaskTimedOutEventAttributes);
  assert.ok(close?.activityTaskFailedEventAttributes, 'the first watch closed as ActivityTaskFailed');
  assert.equal(close.activityTaskFailedEventAttributes.retryState, 3, 'RETRY_STATE_TIMEOUT');
  assert.equal(close.activityTaskFailedEventAttributes.failure?.applicationFailureInfo?.type, 'StillPresent');
});
