import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { Client } from '@temporalio/client';
import proto from '@temporalio/proto';
import { bounded, createLocalEnv } from '../helpers/test-env.js';
import { runFindingChecks, type RunFindingChecksInput } from '../../src/activities/verify-finding.js';
import { DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * An attempt of `runFindingChecks` that stops heartbeating is retried when the
 * heartbeat timeout ends, not when the start-to-close timeout does.
 *
 * The workflow is a stub (`tests/helpers/check-heartbeat-stub.ts`) with a
 * three-second heartbeat timeout under a five-minute start-to-close, so the
 * test waits seconds. The real verifier would need its 30 seconds and a
 * 15-second backoff in wall time: a real dev server skips no time, and the
 * time-skipping server holds its clock while an attempt runs
 * (`untilBetweenAttempts` in `tests/helpers/test-env.ts`). That each real stub
 * carries the timeout is the source check in `heartbeat-timeouts.test.ts`.
 *
 * The first attempt stands in for a worker that died: it beats once and then
 * neither beats nor returns. The second is the real activity over a fetch that
 * serves one page.
 */

const QUEUE = 'check-heartbeat';
const workflowsPath = fileURLToPath(new URL('../helpers/check-heartbeat-stub.ts', import.meta.url));

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createLocalEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

test('an attempt that stops heartbeating is retried after the heartbeat timeout, not the start-to-close timeout', async () => {
  const attempts: number[] = [];
  let release!: () => void;
  const dead = new Promise<void>((resolve) => (release = resolve));
  const activities = {
    runFindingChecks: async (input: RunFindingChecksInput) => {
      const ctx = Context.current();
      attempts.push(ctx.info.attempt);
      if (ctx.info.attempt === 1) {
        ctx.heartbeat('running finding checks');
        await dead;
        throw new Error('the first attempt was released at the end of the test');
      }
      return runFindingChecks(input, { fetch: (async () => new Response('<p>Home</p>', { status: 200 })) as typeof fetch });
    },
  };
  const worker = await Worker.create({ connection: env.nativeConnection, workflowsPath, activities, taskQueue: QUEUE });

  const started = Date.now();
  const { result, history } = await worker.runUntil(
    bounded(
      (async () => {
        try {
          const handle = await client.workflow.start('checkHeartbeatStub', {
            workflowId: 'check-heartbeat-retry',
            taskQueue: QUEUE,
            args: [{ key: DEFECT_KEY, checks: [{ url: `${ORIGIN}/`, kind: 'text', expect: { contains: 'Home' } }] }],
          });
          return { result: await handle.result(), history: await handle.fetchHistory() };
        } finally {
          // The worker drains only once the stand-in attempt returns.
          release();
        }
      })(),
    ),
  );
  const elapsedMs = Date.now() - started;

  assert.equal(result.passed, true);
  assert.deepEqual(attempts, [1, 2]);
  const second = history.events?.find((event) => event.activityTaskStartedEventAttributes)?.activityTaskStartedEventAttributes;
  assert.equal(second?.attempt, 2, 'the attempt that completed is the second');
  assert.equal(
    second?.lastFailure?.timeoutFailureInfo?.timeoutType,
    proto.temporal.api.enums.v1.TimeoutType.TIMEOUT_TYPE_HEARTBEAT,
    'the first attempt ended on its heartbeat timeout',
  );
  assert.ok(elapsedMs < 30_000, `the retry came in ${elapsedMs} ms, well inside the five-minute start-to-close timeout`);
});
