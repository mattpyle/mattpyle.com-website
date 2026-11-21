import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowFailedError, WorkflowUpdateFailedError, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { bounded, createLocalEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT, settings, skipVerdictMeasure } from '../helpers/verdict-measure.js';
import {
  VERDICT_WRITE_FAILED,
  findingStateQuery,
  findingWorkflow,
  verdictSignal,
  verdictUpdate,
  type FindingState,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import type { FindingVerdict } from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * The `record-verdict` Update on the real `findingWorkflow` (STW-636), with
 * mocked activities: what it returns and when, what its validator refuses, a
 * second verdict by either path in either order, a write that fails, and a
 * run cancelled during the write. The last test compares the history of a
 * verdict by Signal with one by Update.
 *
 * The write mock can be held, so a test can send a second verdict while the
 * first is in flight.
 *
 * A server per test, and a real dev server (`createLocalEnv`): no test here
 * waits on a timer. The failing write is non-retryable, so it has no backoff.
 */

const QUEUE = 'steward-findings';
const SITE = 'mattpyle-com';

const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'cli', at: '2026-11-20T18:00:00.000Z' };
const APPROVE_AGAIN: FindingVerdict = { ...APPROVE, reason: 'Still real.', at: '2026-11-20T18:01:00.000Z' };
const REJECT: FindingVerdict = { status: 'rejected', reason: 'By design.', source: 'cli', at: '2026-11-20T18:02:00.000Z' };
const FILE_APPROVE: FindingVerdict = { status: 'approved', reason: 'In the file.', source: 'file', at: '2026-11-20T17:00:00.000Z' };

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createLocalEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

interface Mocks {
  activities: Record<string, unknown>;
  /** One entry per `writeFindingVerdict` call that started. */
  writes: string[];
  /** Lets a held write return. */
  release: () => void;
}

/** The write, held until `release` when `hold` is set, or failing when `fail` is. */
function mocks(options: { hold?: boolean; fail?: boolean } = {}): Mocks {
  const writes: string[] = [];
  let release: () => void = () => undefined;
  const held = options.hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  const activities = skipVerdictMeasure({
    writeFindingVerdict: async (input: { status: string }) => {
      writes.push(input.status);
      await held;
      if (options.fail) throw ApplicationFailure.nonRetryable('The finding file is gone.', 'FindingMissing');
      return { findingCommitSha: 'c-file', indexCommitSha: 'c-index', commitSha: 'c-index' };
    },
    readFinding: async (_repo: string, path: string) => ({ path, text: DEFECT_FINDING, sha: 'sha-1', data: parseFrontmatter(DEFECT_FINDING).data }),
    readVerifyBlock: async () => ({ handoff: null, hasBlock: false, checks: [], source: 'finding' as const }),
    readSiteAutoFix: async () => false,
    // The stop point each run was started with (STW-645): the site still says the same.
    readFindingSettings: async () =>
      stops.get(Context.current().info.workflowExecution?.workflowId ?? '') === 'resolved' ? settings() : STOPS_AT_VERDICT,
    requestFixSlot: async () => ({ paths: [], dispatched: false }),
  });
  return { activities, writes, release: () => release() };
}

async function withWorker<T>(m: Mocks, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    workflowBundle: await workflowBundle(),
    activities: m.activities,
    taskQueue: QUEUE,
  });
  // A held write is let go whatever the test did, so a failed test's worker can drain.
  return await worker.runUntil(bounded(fn()).finally(() => m.release()));
}

function input(id: string, stopAfter: 'verdict' | 'resolved' = 'verdict'): FindingWorkflowInput {
  const base = {
    site: SITE,
    key: DEFECT_KEY,
    repo: 'mattpyle/argus',
    findingPath: `sites/${SITE}/findings/${DEFECT_KEY}.md`,
    indexPath: `sites/${SITE}/findings/INDEX.md`,
  };
  if (stopAfter === 'verdict') return { ...base, stopAfter };
  return { ...base, stopAfter, handoffPath: `sites/${SITE}/handoffs/${DEFECT_KEY}.md`, branch: `fix/finding-${id}`, origin: ORIGIN };
}

/** The stop point of each started run, by workflow ID, for the settings mock. */
const stops = new Map<string, 'verdict' | 'resolved'>();

function start(id: string, stopAfter: 'verdict' | 'resolved' = 'verdict') {
  stops.set(`finding/${SITE}/update-${id}`, stopAfter);
  return client.workflow.start(findingWorkflow, {
    workflowId: `finding/${SITE}/update-${id}`,
    taskQueue: QUEUE,
    args: [input(id, stopAfter)],
  });
}

type Handle = WorkflowHandle<typeof findingWorkflow>;

const record = (handle: Handle, verdict: FindingVerdict) => handle.executeUpdate(verdictUpdate, { args: [verdict] });

async function until(handle: Handle, ready: (state: FindingState) => boolean, what: string): Promise<FindingState> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const state = await handle.query(findingStateQuery);
    if (ready(state)) return state;
    if (Date.now() > deadline) assert.fail(`the run never reached ${what}; it is ${state.status} at ${state.step}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The refusal's own sentence. */
async function refusalOf(update: Promise<unknown>): Promise<{ message: string; type: string | null | undefined }> {
  try {
    await update;
  } catch (err) {
    assert.ok(err instanceof WorkflowUpdateFailedError, `expected an Update failure, got ${String(err)}`);
    const cause = err.cause as Error & { type?: string | null };
    return { message: cause.message, type: cause.type };
  }
  return assert.fail('the Update was accepted and completed');
}

async function eventTypes(handle: Handle): Promise<string[]> {
  const history = await handle.fetchHistory();
  return (history.events ?? []).map((event) => Object.keys(event).find((k) => k.endsWith('EventAttributes')) as string);
}

test('a verdict-only run: the Update returns the verdict and the commit after the write, and the run completes', async () => {
  const m = mocks();
  await withWorker(m, async () => {
    const handle = await start('verdict-only');
    const recorded = await record(handle, APPROVE);
    assert.deepEqual(recorded, { verdict: APPROVE, commitSha: 'c-index', first: true, stopAfter: 'verdict' });
    const result = await handle.result();
    assert.deepEqual(result.verdict, APPROVE);
    assert.equal(result.commitSha, 'c-index');
    assert.deepEqual(m.writes, ['approved']);
  });
});

test('a lifecycle run: the Update returns after the write while the run goes on', async () => {
  const m = mocks();
  await withWorker(m, async () => {
    const handle = await start('lifecycle', 'resolved');
    const recorded = await record(handle, APPROVE);
    assert.deepEqual(recorded, { verdict: APPROVE, commitSha: 'c-index', first: true, stopAfter: 'resolved' });
    const state = await until(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
    assert.equal(state.status, 'done');
    assert.equal((await handle.describe()).status.name, 'RUNNING');
    await handle.terminate('test over');
  });
});

test('the Update does not return while the write is in flight', async () => {
  const m = mocks({ hold: true });
  await withWorker(m, async () => {
    const handle = await start('in-flight');
    const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: 'ACCEPTED' });
    await until(handle, (s) => s.status === 'writing', 'writing');
    const early = await Promise.race([update.result().then(() => 'returned'), new Promise((r) => setTimeout(() => r('waiting'), 1500))]);
    assert.equal(early, 'waiting');
    m.release();
    assert.equal((await update.result()).commitSha, 'c-index');
    await handle.result();
  });
});

test('the validator refuses a malformed verdict, and the run keeps waiting', async () => {
  const m = mocks();
  await withWorker(m, async () => {
    const handle = await start('malformed');
    const refusal = await refusalOf(record(handle, { status: 'maybe', source: 'cli', reason: '', at: '' } as never));
    assert.equal(refusal.message, 'The verdict is malformed.');
    const state = await handle.query(findingStateQuery);
    assert.equal(state.status, 'waiting');
    assert.equal(state.verdict, null);
    // A refused Update leaves nothing in the history.
    assert.ok(!(await eventTypes(handle)).some((type) => /Update/.test(type)));
    await handle.terminate('test over');
  });
});

test('Signal then Update: the same status is answered with the first, a different status is refused', async () => {
  const m = mocks();
  await withWorker(m, async () => {
    const handle = await start('signal-then-update', 'resolved');
    await handle.signal(verdictSignal, FILE_APPROVE);
    await until(handle, (s) => s.status === 'done', 'done');

    const same = await record(handle, APPROVE);
    assert.deepEqual(same, { verdict: FILE_APPROVE, commitSha: null, first: false, stopAfter: 'resolved' });

    const refusal = await refusalOf(record(handle, REJECT));
    assert.equal(refusal.message, 'A verdict is already recorded: approved (source file).');

    assert.deepEqual(m.writes, [], 'a file verdict writes nothing, and neither Update wrote');
    assert.deepEqual((await handle.query(findingStateQuery)).verdict, FILE_APPROVE);
    await handle.terminate('test over');
  });
});

test('Signal then Update while the write is in flight: the same status waits for the first write, a different one is refused at once', async () => {
  const m = mocks({ hold: true });
  await withWorker(m, async () => {
    const handle = await start('signal-in-flight');
    await handle.signal(verdictSignal, APPROVE);
    await until(handle, (s) => s.status === 'writing', 'writing');

    const refusal = await refusalOf(record(handle, REJECT));
    assert.equal(refusal.message, 'A verdict is already recorded: approved (source cli).');

    const same = await handle.startUpdate(verdictUpdate, { args: [APPROVE_AGAIN], waitForStage: 'ACCEPTED' });
    m.release();
    assert.deepEqual(await same.result(), { verdict: APPROVE, commitSha: 'c-index', first: false, stopAfter: 'verdict' });
    assert.deepEqual((await handle.result()).verdict, APPROVE);
    assert.deepEqual(m.writes, ['approved']);
  });
});

test('Update then Signal: the Signal is dropped, whatever its status', async () => {
  const m = mocks({ hold: true });
  await withWorker(m, async () => {
    const handle = await start('update-then-signal');
    const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: 'ACCEPTED' });
    await until(handle, (s) => s.status === 'writing', 'writing');
    await handle.signal(verdictSignal, REJECT);
    await handle.signal(verdictSignal, APPROVE_AGAIN);
    assert.deepEqual((await handle.query(findingStateQuery)).verdict, APPROVE);
    m.release();
    assert.deepEqual(await update.result(), { verdict: APPROVE, commitSha: 'c-index', first: true, stopAfter: 'verdict' });
    assert.deepEqual((await handle.result()).verdict, APPROVE);
    assert.deepEqual(m.writes, ['approved']);
  });
});

test('Update then Update: in flight and recorded, the same status is answered with the first and a different one is refused', async () => {
  const m = mocks({ hold: true });
  await withWorker(m, async () => {
    const handle = await start('update-then-update', 'resolved');
    const first = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: 'ACCEPTED' });
    await until(handle, (s) => s.status === 'writing', 'writing');

    // In flight.
    const refusedInFlight = await refusalOf(record(handle, REJECT));
    assert.equal(refusedInFlight.message, 'A verdict is already recorded: approved (source cli).');
    const second = await handle.startUpdate(verdictUpdate, { args: [APPROVE_AGAIN], waitForStage: 'ACCEPTED' });
    m.release();
    assert.deepEqual(await first.result(), { verdict: APPROVE, commitSha: 'c-index', first: true, stopAfter: 'resolved' });
    assert.deepEqual(await second.result(), { verdict: APPROVE, commitSha: 'c-index', first: false, stopAfter: 'resolved' });

    // Recorded.
    assert.deepEqual(await record(handle, APPROVE_AGAIN), { verdict: APPROVE, commitSha: 'c-index', first: false, stopAfter: 'resolved' });
    const refusedRecorded = await refusalOf(record(handle, REJECT));
    assert.equal(refusedRecorded.message, 'A verdict is already recorded: approved (source cli).');

    assert.deepEqual(m.writes, ['approved'], 'one write for four Updates');
    await handle.terminate('test over');
  });
});

test('a write that fails: the waiting Update fails with the reason, and the run fails', async () => {
  const m = mocks({ fail: true });
  await withWorker(m, async () => {
    const handle = await start('write-fails');
    const failure = await refusalOf(record(handle, APPROVE));
    assert.equal(failure.type, VERDICT_WRITE_FAILED);
    assert.equal(failure.message, 'The verdict was not written: The finding file is gone.');
    await assert.rejects(handle.result(), (err: unknown) => err instanceof WorkflowFailedError);
    assert.equal((await handle.describe()).status.name, 'FAILED');
  });
});

test('a run cancelled during the write: the waiting Update fails, and the run ends cancelled', async () => {
  const m = mocks({ hold: true });
  await withWorker(m, async () => {
    const handle = await start('cancelled');
    const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: 'ACCEPTED' });
    await until(handle, (s) => s.status === 'writing', 'writing');
    await handle.cancel();
    const failure = await refusalOf(update.result());
    assert.equal(failure.type, VERDICT_WRITE_FAILED);
    assert.equal(failure.message, 'The run was cancelled before the verdict was written.');
    await assert.rejects(handle.result(), (err: unknown) => err instanceof WorkflowFailedError);
    assert.equal((await handle.describe()).status.name, 'CANCELLED');
    m.release();
  });
});

test('a verdict by Update issues the commands a verdict by Signal does', async () => {
  const m = mocks();
  await withWorker(m, async () => {
    const bySignal = await start('by-signal', 'resolved');
    await until(bySignal, (s) => s.step === 'waiting-verdict', 'the verdict wait');
    await bySignal.signal(verdictSignal, APPROVE);
    await until(bySignal, (s) => s.step === 'waiting-fix', 'waiting-fix');

    const byUpdate = await start('by-update', 'resolved');
    await until(byUpdate, (s) => s.step === 'waiting-verdict', 'the verdict wait');
    await record(byUpdate, APPROVE);
    await until(byUpdate, (s) => s.step === 'waiting-fix', 'waiting-fix');

    const signalled = await eventTypes(bySignal);
    const updated = await eventTypes(byUpdate);
    const ownEvents = ['workflowExecutionUpdateAcceptedEventAttributes', 'workflowExecutionUpdateCompletedEventAttributes'];
    assert.deepEqual(
      updated.filter((type) => ownEvents.includes(type)),
      ownEvents,
      'the Update leaves its accepted and completed events',
    );

    // What the workflow asked for: every event a command produces. Workflow
    // task events are left out, since a Query in between adds none and the
    // server batches them differently for a Signal and an Update.
    const commands = (types: string[]) =>
      types.filter((type) => /^(activityTaskScheduled|timerStarted|markerRecorded|startChildWorkflow|signalExternal|workflowExecution(Completed|Failed))/.test(type));
    assert.deepEqual(commands(updated), commands(signalled));
    assert.ok(commands(signalled).includes('activityTaskScheduledEventAttributes'));

    // Everything else in the two histories, apart from how the verdict arrived.
    const rest = (types: string[]) =>
      types.filter((type) => !/^workflowTask/.test(type) && !ownEvents.includes(type) && type !== 'workflowExecutionSignaledEventAttributes');
    assert.deepEqual(rest(updated), rest(signalled));

    await bySignal.terminate('test over');
    await byUpdate.terminate('test over');
  });
});
