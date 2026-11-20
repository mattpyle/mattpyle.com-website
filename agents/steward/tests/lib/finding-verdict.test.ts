import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure, Client, WorkflowNotFoundError, WorkflowUpdateFailedError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { bounded, createLocalEnv } from '../helpers/test-env.js';
import {
  FindingVerdictError,
  sendFindingVerdict,
  type FindingVerdictErrorKind,
  type VerdictClient,
  type VerdictHandle,
} from '../../src/lib/finding-verdict.js';
import { findingWorkflowId, type FindingVerdict } from '../../src/lib/findings.js';
import { VERDICT_WRITE_FAILED, verdictSignal, verdictUpdate, type VerdictRecorded } from '../../src/workflows/finding.js';
import { receivedVerdictsQuery, verdictStubBeforeUpdateWorkflow } from '../fixtures/workflows/verdict-stub.js';

/**
 * `sendFindingVerdict` (STW-636): what it returns from the `record-verdict`
 * Update, and the sentence for each way the Update can fail. The handle is a
 * fake, so each case is one scripted answer and no test waits on a server.
 *
 * The last test is the exception. It runs a real server and a workflow with no
 * `record-verdict` handler, as a worker from before the Update serves a run,
 * to pin what the SDK does there and what the history holds afterwards.
 */

const SITE = 'stub-site';
const KEY = 'stub-finding--page';
const REQUEST = { site: SITE, key: KEY, status: 'approved' as const, reason: 'Real.' };
const NOW = new Date('2026-11-20T18:00:00.000Z');
const SENT: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'cli', at: NOW.toISOString() };

type Start = VerdictHandle['startUpdate'];

function fakeClient(startUpdate: Start, status = 'RUNNING'): { client: VerdictClient; sent: FindingVerdict[] } {
  const sent: FindingVerdict[] = [];
  const client: VerdictClient = {
    workflow: {
      getHandle: (workflowId) => ({
        workflowId,
        describe: async () => ({ status: { name: status } }),
        startUpdate: (def, options) => {
          assert.equal(def, verdictUpdate);
          assert.equal(options.waitForStage, 'ACCEPTED');
          sent.push(options.args[0]);
          return startUpdate(def, options);
        },
      }),
    },
  };
  return { client, sent };
}

const completes = (recorded: VerdictRecorded): Start => async () => ({ result: async () => recorded });
const updateFailed = (message: string, type?: string) =>
  new WorkflowUpdateFailedError('Workflow Update failed', ApplicationFailure.nonRetryable(message, type));
/** A refused Update, as the SDK hands it over: `startUpdate` resolves and `result()` throws. */
const refuses = (message: string): Start => async () => ({
  result: async () => {
    throw updateFailed(message);
  },
});
const never = <T>() => new Promise<T>(() => undefined);

async function refused(startUpdate: Start, kind: FindingVerdictErrorKind, status = 'RUNNING'): Promise<string> {
  const { client } = fakeClient(startUpdate, status);
  try {
    await sendFindingVerdict(REQUEST, { client, waitMs: 50, now: () => NOW, readAutoFix: async () => false });
  } catch (err) {
    assert.ok(err instanceof FindingVerdictError, `expected a FindingVerdictError, got ${String(err)}`);
    assert.equal(err.kind, kind);
    return err.message;
  }
  return assert.fail('the verdict was recorded');
}

test('an approval on a lifecycle run returns the recorded verdict, the commit and the next step', async () => {
  const { client, sent } = fakeClient(completes({ verdict: SENT, commitSha: 'c1', first: true, stopAfter: 'resolved' }));
  const result = await sendFindingVerdict(REQUEST, { client, now: () => NOW, readAutoFix: async () => true });
  assert.deepEqual(sent, [SENT]);
  assert.equal(result.workflowId, findingWorkflowId(SITE, KEY));
  assert.deepEqual(result.sent, SENT);
  assert.deepEqual(result.recorded, SENT);
  assert.equal(result.first, true);
  assert.equal(result.commitSha, 'c1');
  assert.match(result.nextStep ?? '', /auto_fix/);
  assert.equal(result.nextStepError, null);
});

test('a verdict-only run and a rejection have no next step', async () => {
  const verdictOnly = fakeClient(completes({ verdict: SENT, commitSha: 'c1', first: true, stopAfter: 'verdict' }));
  assert.equal((await sendFindingVerdict(REQUEST, { client: verdictOnly.client, readAutoFix: async () => true })).nextStep, null);
  const reject: FindingVerdict = { ...SENT, status: 'rejected' };
  const rejected = fakeClient(completes({ verdict: reject, commitSha: 'c1', first: true, stopAfter: 'resolved' }));
  const result = await sendFindingVerdict({ ...REQUEST, status: 'rejected' }, { client: rejected.client, readAutoFix: async () => true });
  assert.equal(result.nextStep, null);
});

test('an earlier verdict of the same status: the result carries it, says so, and names no next step', async () => {
  const earlier: FindingVerdict = { status: 'approved', reason: 'In the file.', source: 'file', at: '2026-11-19T10:00:00.000Z' };
  const { client } = fakeClient(completes({ verdict: earlier, commitSha: null, first: false, stopAfter: 'resolved' }));
  const result = await sendFindingVerdict(REQUEST, { client, now: () => NOW, readAutoFix: async () => true });
  assert.deepEqual(result.recorded, earlier);
  assert.deepEqual(result.sent, SENT);
  assert.equal(result.first, false);
  assert.equal(result.commitSha, null);
  assert.equal(result.nextStep, null);
});

test('a failed auto_fix read leaves the verdict recorded and the next step unknown', async () => {
  const { client } = fakeClient(completes({ verdict: SENT, commitSha: 'c1', first: true, stopAfter: 'resolved' }));
  const result = await sendFindingVerdict(REQUEST, {
    client,
    readAutoFix: async () => {
      throw new Error('GitHub said no');
    },
  });
  assert.equal(result.commitSha, 'c1');
  assert.equal(result.nextStep, null);
  assert.equal(result.nextStepError?.message, 'GitHub said no');
});

test('no open run: nothing is sent', async () => {
  const closed = fakeClient(async () => assert.fail('no Update goes to a closed run'), 'COMPLETED');
  await assert.rejects(
    sendFindingVerdict(REQUEST, { client: closed.client }),
    (err: unknown) => err instanceof FindingVerdictError && err.kind === 'no-run' && /^No open workflow /.test(err.message),
  );
  assert.deepEqual(closed.sent, []);
  // The run closed between the look and the Update.
  const message = await refused(async () => {
    throw new WorkflowNotFoundError('gone', findingWorkflowId(SITE, KEY), undefined);
  }, 'no-run');
  assert.match(message, /^No open workflow /);
});

test("the validator's refusal is the error, and it says nothing was recorded", async () => {
  const message = await refused(refuses('A verdict is already recorded: rejected (source cli).'), 'refused');
  assert.equal(message, 'Refused: A verdict is already recorded: rejected (source cli). Nothing was recorded.');
});

test('a worker with no handler: a clear refusal, and nothing was recorded', async () => {
  const message = await refused(refuses('No registered handler for update: record-verdict'), 'old-worker');
  assert.equal(
    message,
    'The worker serving this run predates the verdict Update; nothing was recorded. Retry once the worker is deployed.',
  );
});

test('no worker takes the Update within the bound: nothing is recorded', async () => {
  const message = await refused(() => never(), 'unaccepted');
  assert.match(message, /^No worker took the verdict in 0\.05s, so nothing is recorded\. Check `steward finding status stub-finding--page`/);
});

test('accepted and not written within the bound: the error says accepted and still writing', async () => {
  const message = await refused(async () => ({ result: () => never<VerdictRecorded>() }), 'timeout');
  assert.match(message, /^The run accepted the verdict and is still writing it after 0\.05s\. Check `steward finding status stub-finding--page`/);
  assert.doesNotMatch(message, /nothing/i);
});

test('accepted and the write failed: the error carries the run\'s reason', async () => {
  const message = await refused(
    async () => ({
      result: async () => {
        throw updateFailed('The verdict was not written: The finding file is gone.', VERDICT_WRITE_FAILED);
      },
    }),
    'write-failed',
  );
  assert.match(message, /^The run accepted the verdict and did not record it: The verdict was not written: The finding file is gone\. Check /);
});

test('an error that is not an Update failure passes through', async () => {
  const { client } = fakeClient(async () => {
    throw new Error('connection refused');
  });
  await assert.rejects(sendFindingVerdict(REQUEST, { client }), (err: unknown) => !(err instanceof FindingVerdictError) && /connection refused/.test(String(err)));
});

test('a run whose worker predates the handler: the SDK rejects the Update, the history holds nothing of it, and the Signal still lands', { timeout: 120_000 }, async () => {
  const env = await createLocalEnv();
  try {
    const client = new Client({ connection: env.connection, namespace: env.namespace });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      workflowsPath: fileURLToPath(new URL('../fixtures/workflows/verdict-stub.ts', import.meta.url)),
      taskQueue: 'verdict-before-update',
      bundlerOptions: {},
    });
    await worker.runUntil(
      bounded(
        (async () => {
          const handle = await client.workflow.start(verdictStubBeforeUpdateWorkflow, {
            workflowId: findingWorkflowId(SITE, KEY),
            taskQueue: 'verdict-before-update',
          });

          // What the SDK does, unwrapped: `startUpdate` resolves, and `result()` throws the rejection.
          const update = await handle.startUpdate(verdictUpdate, { args: [SENT], waitForStage: 'ACCEPTED' });
          await assert.rejects(
            update.result(),
            (err: unknown) =>
              err instanceof WorkflowUpdateFailedError &&
              (err.cause as Error).message === 'No registered handler for update: record-verdict',
          );

          // What the caller reads.
          await assert.rejects(
            sendFindingVerdict(REQUEST, { client, now: () => NOW }),
            (err: unknown) => err instanceof FindingVerdictError && err.kind === 'old-worker',
          );

          const types = ((await handle.fetchHistory()).events ?? []).map((event) =>
            Object.keys(event).find((k) => k.endsWith('EventAttributes')),
          );
          // Two rejected Updates later, the history is the start and its one workflow task.
          assert.deepEqual(types, [
            'workflowExecutionStartedEventAttributes',
            'workflowTaskScheduledEventAttributes',
            'workflowTaskStartedEventAttributes',
            'workflowTaskCompletedEventAttributes',
          ]);
          assert.deepEqual(await handle.query(receivedVerdictsQuery), [], 'the run took no verdict');
          assert.equal((await handle.describe()).status.name, 'RUNNING');

          // The path for such a run is still there.
          await handle.signal(verdictSignal, SENT);
          assert.deepEqual(await handle.query(receivedVerdictsQuery), [SENT]);
          await handle.terminate('test over');
        })(),
      ),
    );
  } finally {
    await env.teardown();
  }
});
