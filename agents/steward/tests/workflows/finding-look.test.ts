import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowUpdateFailedError, WorkflowUpdateStage, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT } from '../helpers/verdict-measure.js';
import {
  LOOK_BUSY,
  LOOK_WRITE_FAILED,
  findingStateQuery,
  findingWorkflow,
  lookUpdate,
  measureNowUpdate,
  verdictUpdate,
  type FindingState,
  type FindingWorkflowInput,
  type LookRequest,
} from '../../src/workflows/finding.js';
import type { FindingSettings } from '../../src/activities/findings.js';
import type { WatchFindingResult } from '../../src/activities/findings-watch.js';
import type { WriteFindingLookInput, WriteFindingLookResult } from '../../src/activities/findings-look.js';
import type { FindingVerdict } from '../../src/lib/findings.js';

/**
 * Stage 5's `record-look` on the real `findingWorkflow` with mocked
 * activities: a look accepted at `watching` cancels the pending watch, the
 * run writes it at `recording-look`, answers, and ends `resolved`; every
 * message that would compete with it is refused while it is asked for or
 * written; and each way the write can end settles the Update.
 *
 * Each test has its own time-skipping server and awaits at most one thing
 * through the time-skipping client, for the reason `finding-lifecycle.test.ts`
 * gives. A write held open is released before the run's result is awaited,
 * so skipped time never reaches its one-minute start-to-close.
 */

const FINDINGS = 'steward-findings';
const WATCH = 'steward-findings-watch';
const SITE = 'temporal-io';
const RUN = '2026-11-26T0830Z';
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
const LOOK: LookRequest = { result: 'fixed', run: RUN, at: '2026-11-26T08:45:00.000Z', source: 'argus' };

const stillPresent = () =>
  ApplicationFailure.create({ type: 'StillPresent', message: 'still present', nextRetryDelay: '1 day', category: ApplicationFailureCategory.BENIGN });

type LookStep = WriteFindingLookResult | 'hold' | { fail: string };

interface Scene {
  watch: Array<WatchFindingResult | 'still'>;
  /** What each `writeFindingLook` attempt does; the last repeats. */
  look?: LookStep[];
}

function mocks(scene: Scene) {
  const called: string[] = [];
  const lookQueues: string[] = [];
  const lookInputs: WriteFindingLookInput[] = [];
  let watchAttempts = 0;
  let lookAttempts = 0;
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => (release = resolve));
  const activities = {
    readFindingSettings: async () => (called.push('readFindingSettings'), WATCHES),
    writeFindingVerdict: async () => (called.push('writeFindingVerdict'), { findingCommitSha: 'f1', indexCommitSha: 'i1', commitSha: 'v1' }),
    writeFindingLook: async (input: WriteFindingLookInput): Promise<WriteFindingLookResult> => {
      called.push('writeFindingLook');
      lookQueues.push(Context.current().info.taskQueue);
      lookInputs.push(input);
      const steps = scene.look ?? [{ by: 'look', resolvedRun: RUN, commitSha: 'abcdef1234' }];
      const step = steps[Math.min(lookAttempts, steps.length - 1)];
      lookAttempts++;
      if (step === 'hold') {
        await held;
        return { by: 'look', resolvedRun: RUN, commitSha: 'abcdef1234' };
      }
      if ('fail' in step) throw ApplicationFailure.nonRetryable(`refused: ${step.fail}`, step.fail);
      return step;
    },
    watchFinding: async (): Promise<WatchFindingResult> => {
      called.push('watchFinding');
      const step = scene.watch[Math.min(watchAttempts, scene.watch.length - 1)];
      watchAttempts++;
      if (step === 'still') throw stillPresent();
      return step;
    },
  };
  return {
    activities,
    called,
    lookQueues,
    lookInputs,
    watchAttempts: () => watchAttempts,
    lookAttempts: () => lookAttempts,
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

async function run<T>(scene: Scene, body: (m: ReturnType<typeof mocks>, start: (id: string) => Promise<Handle>) => Promise<T>) {
  const m = mocks(scene);
  const { watchFinding, ...rest } = m.activities;
  const findings = await Worker.create({ connection: env.nativeConnection, workflowBundle: await workflowBundle(), activities: rest, taskQueue: FINDINGS });
  const watch = await Worker.create({ connection: env.nativeConnection, activities: { watchFinding }, taskQueue: WATCH });
  const start = (id: string) => client.workflow.start(findingWorkflow, { workflowId: `finding/${SITE}/${id}`, taskQueue: FINDINGS, args: [input(id)] });
  try {
    const out = await watch.runUntil(findings.runUntil(bounded(body(m, start))));
    return { ...m, out };
  } finally {
    m.release();
  }
}

function skipResult(handle: { workflowId: string }) {
  return env.client.workflow.getHandle<typeof findingWorkflow>(handle.workflowId).result();
}

/** A watching run, its first attempt failed and the retry pending. */
async function watchingRun(m: ReturnType<typeof mocks>, start: (id: string) => Promise<Handle>, id: string): Promise<Handle> {
  const handle = await start(id);
  await until(handle, (s) => s.step === 'watching', 'watching');
  await waitFor(() => m.watchAttempts() === 1, 'the first attempt');
  return handle;
}

/** The refusal a validator gave, as the client sees it. */
async function refused(send: Promise<unknown>): Promise<string> {
  try {
    await send;
  } catch (err) {
    assert.ok(err instanceof WorkflowUpdateFailedError, `expected a refusal, got ${String(err)}`);
    return String((err as Error & { cause?: Error }).cause?.message);
  }
  assert.fail('the Update was accepted');
}

test('a look closes a watching run: the watch is cancelled, the write runs on steward-findings, and the run ends resolved naming the run', async () => {
  const { out, lookQueues, lookInputs, called } = await run({ watch: ['still'] }, async (m, start) => {
    const handle = await watchingRun(m, start, 'look');
    const answer = await handle.executeUpdate(lookUpdate, { args: [LOOK] });
    const result = await skipResult(handle);
    const history = await handle.fetchHistory();
    return { answer, result, history };
  });
  assert.deepEqual(out.answer, { workflowId: `finding/${SITE}/look`, by: 'look', resolvedRun: RUN, commitSha: 'abcdef1234' });
  assert.equal(out.result.outcome, 'resolved');
  assert.equal(out.result.note, `Resolved by Argus's look ${RUN} (commit abcdef1).`);
  assert.deepEqual(lookQueues, [FINDINGS]);
  assert.equal(lookInputs[0].run, RUN);
  assert.equal(lookInputs[0].by, `finding/${SITE}/look`);
  assert.equal(called.filter((c) => c === 'watchFinding').length, 1, 'no watch issued after the look');
  const events = out.history.events ?? [];
  assert.ok(events.some((e) => e.activityTaskCancelRequestedEventAttributes), 'the pending watch was cancelled');
});

test('while the look is written, a rejection, measure-now and a second look are refused, and the run completes', async () => {
  const { out } = await run({ watch: ['still'], look: ['hold'] }, async (m, start) => {
    const handle = await watchingRun(m, start, 'blocked');
    const update = await handle.startUpdate(lookUpdate, { args: [LOOK], waitForStage: WorkflowUpdateStage.ACCEPTED });
    await waitFor(() => m.lookAttempts() === 1, 'the held write');
    const state = await until(handle, (s) => s.step === 'recording-look', 'recording-look');
    const rejection = await refused(handle.executeUpdate(verdictUpdate, { args: [REJECT] }));
    const measure = await refused(handle.executeUpdate(measureNowUpdate, { args: [{ source: 'cli', at: '2026-11-26T09:00:00.000Z' }] }));
    const second = await refused(handle.executeUpdate(lookUpdate, { args: [{ ...LOOK, run: '2026-11-26T0900Z' }] }));
    m.release();
    const answer = await update.result();
    return { state, rejection, measure, second, answer, result: await skipResult(handle) };
  });
  assert.equal(out.state.lookRun, RUN);
  assert.equal(out.rejection, LOOK_BUSY);
  assert.equal(out.measure, LOOK_BUSY);
  assert.match(out.second, /already being recorded/);
  assert.equal(out.answer.by, 'look');
  assert.equal(out.result.outcome, 'resolved');
});

test('a look that meets a file the watch already resolved answers success by watch', async () => {
  const { out } = await run({ watch: ['still'], look: [{ by: 'watch', resolvedRun: '2026-11-26T1320Z', commitSha: null }] }, async (m, start) => {
    const handle = await watchingRun(m, start, 'already');
    const answer = await handle.executeUpdate(lookUpdate, { args: [LOOK] });
    return { answer, result: await skipResult(handle) };
  });
  assert.equal(out.answer.by, 'watch');
  assert.equal(out.answer.resolvedRun, '2026-11-26T1320Z');
  assert.equal(out.result.outcome, 'resolved');
  assert.equal(out.result.note, `Resolved by its own watch before Argus's look ${RUN} was written.`);
});

test('a run cancelled during the write answers its handler with LookWriteFailed before it closes', async () => {
  const { out } = await run({ watch: ['still'], look: ['hold'] }, async (m, start) => {
    const handle = await watchingRun(m, start, 'cancelled');
    const update = await handle.startUpdate(lookUpdate, { args: [LOOK], waitForStage: WorkflowUpdateStage.ACCEPTED });
    await waitFor(() => m.lookAttempts() === 1, 'the held write');
    await handle.cancel();
    let answer: unknown;
    try {
      answer = await update.result();
    } catch (err) {
      answer = err;
    }
    const deadline = Date.now() + 30_000;
    let status = (await handle.describe()).status.name;
    while (status === 'RUNNING' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      status = (await handle.describe()).status.name;
    }
    // The held write ignores the cancel, as a GitHub commit in flight does; the worker drains once it returns.
    m.release();
    return { answer, status };
  });
  assert.ok(out.answer instanceof WorkflowUpdateFailedError, `the handler answered ${String(out.answer)}, not NOT_FOUND`);
  const cause = (out.answer as Error & { cause?: ApplicationFailure }).cause;
  assert.equal(cause?.type, LOOK_WRITE_FAILED);
  assert.match(String(cause?.message), /cancelled before the look was recorded/);
  assert.equal(out.status, 'CANCELLED');
});

test('a look whose body is missing fails LookBodyMissing, and the run goes back to watching and issues the watch again', async () => {
  const { out, called } = await run({ watch: ['still'], look: [{ fail: 'LookBodyMissing' }] }, async (m, start) => {
    const handle = await watchingRun(m, start, 'no-body');
    let answer: unknown;
    try {
      answer = await handle.executeUpdate(lookUpdate, { args: [LOOK] });
    } catch (err) {
      answer = err;
    }
    await waitFor(() => m.watchAttempts() === 2, 'the watch issued again');
    const state = await until(handle, (s) => s.step === 'watching' && (s.watchIssues ?? 0) === 2, 'watching again');
    // The run takes a look again: the failure cleared the flag.
    const again = await refused(handle.executeUpdate(lookUpdate, { args: [{ ...LOOK, run: 'not-a-run' }] }));
    await handle.terminate('test over');
    return { answer, state, again };
  });
  assert.ok(out.answer instanceof WorkflowUpdateFailedError);
  assert.equal((out.answer as Error & { cause?: ApplicationFailure }).cause?.type, 'LookBodyMissing');
  assert.equal(out.state.lookRun, null);
  assert.match(out.again, /not an Argus run identifier/, 'the validator sees no look in flight');
  assert.equal(called.filter((c) => c === 'watchFinding').length, 2);
});

test('a file that moved fails the look and ends the run closed', async () => {
  const { out } = await run({ watch: ['still'], look: [{ fail: 'FindingMoved' }] }, async (m, start) => {
    const handle = await watchingRun(m, start, 'moved');
    let answer: unknown;
    try {
      answer = await handle.executeUpdate(lookUpdate, { args: [LOOK] });
    } catch (err) {
      answer = err;
    }
    return { answer, result: await skipResult(handle) };
  });
  assert.equal((out.answer as Error & { cause?: ApplicationFailure }).cause?.type, 'FindingMoved');
  assert.equal(out.result.outcome, 'closed');
  assert.match(String(out.result.note), new RegExp(`Closed while it recorded Argus's look ${RUN}`));
});

test('the validator refuses a malformed look, another result, a run that is not an Argus identifier, and a run not watching', async () => {
  const { out } = await run({ watch: ['still'] }, async (m, start) => {
    const handle = await watchingRun(m, start, 'refusals');
    const send = (look: unknown) => refused(handle.executeUpdate(lookUpdate, { args: [look as LookRequest] }));
    const malformed = await send({ result: 'fixed', run: RUN, at: 'x', source: 'cli' });
    const live = await send({ ...LOOK, result: 'live' });
    const injected = await send({ ...LOOK, run: `${RUN}\nstatus: rejected` });
    const state = await handle.query(findingStateQuery);
    await handle.terminate('test over');
    // A run at its verdict wait, not watching.
    const waiting = await client.workflow.start(findingWorkflow, {
      workflowId: `finding/${SITE}/waiting`,
      taskQueue: FINDINGS,
      args: [{ ...input('waiting'), verdict: undefined }],
    });
    await until(waiting, (s) => s.step === 'waiting-verdict', 'waiting-verdict');
    const notWatching = await refused(waiting.executeUpdate(lookUpdate, { args: [LOOK] }));
    await waiting.terminate('test over');
    return { malformed, live, injected, state, notWatching };
  });
  assert.equal(out.malformed, 'The look is malformed.');
  assert.match(out.live, /result "live" is not one this run takes/);
  assert.match(out.injected, /not an Argus run identifier/);
  assert.equal(out.state.step, 'watching', 'a refused look changes nothing');
  assert.match(out.notWatching, /not watching production: it is at waiting-verdict/);
});

test("looked_fixed read by the watch with no message: the run ends resolved, naming Argus's run", async () => {
  const { out } = await run(
    { watch: ['still', { outcome: 'resolved', commitSha: 'feed1234', rows: [], at: null, look: RUN }] },
    async (m, start) => {
      const handle = await watchingRun(m, start, 'by-file');
      // The next daily attempt, asked for now: it reads the field.
      await handle.executeUpdate(measureNowUpdate, { args: [{ source: 'cli', at: '2026-11-26T09:00:00.000Z' }] });
      return await skipResult(handle);
    },
  );
  assert.equal(out.outcome, 'resolved');
  assert.equal(out.note, `Resolved by Argus's look ${RUN}, read from the finding file (commit feed123).`);
});
