import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { longRetryAlarm } from '../../src/lib/long-retry.js';
import { bounded, createTestEnv } from '../helpers/test-env.js';

/**
 * The last-failure gauge on a real Worker: the Grafana rule depends on the
 * interceptor running there. The gauge is a list.
 */

let env: TestWorkflowEnvironment;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env?.teardown();
});

test('the gauge is written once for each counted failure, with both labels, and not on a success', async () => {
  const writes: unknown[] = [];
  const attempts: string[] = [];
  const attempt = (): number => {
    const { activityType, attempt } = Context.current().info;
    // The writes made before this attempt, so each write is pinned to the attempt it followed.
    attempts.push(`${activityType} ${attempt}: ${writes.length}`);
    return attempt;
  };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'last-failure',
    workflowsPath: fileURLToPath(new URL('./long-retry.workflows.ts', import.meta.url)),
    activities: {
      // Fails twice, then succeeds.
      async writeThing() {
        if (attempt() < 3) throw new Error('GitHub answered 500');
      },
      // "Not yet", then a failure, then done.
      async awaitFixPrMerge() {
        const n = attempt();
        if (n === 1) throw ApplicationFailure.retryable('the PR is still open', 'PrStillOpen');
        if (n === 2) throw new Error('GitHub answered 502');
      },
    },
    interceptors: { activity: [longRetryAlarm({ set: (_value, labels) => void writes.push(labels) })] },
  });
  await worker.runUntil(bounded(env.client.workflow.execute('lastFailureWorkflow', { taskQueue: 'last-failure', workflowId: 'last-failure' })));
  assert.deepEqual(attempts, [
    'writeThing 1: 0',
    'writeThing 2: 1',
    'writeThing 3: 2',
    'awaitFixPrMerge 1: 2',
    'awaitFixPrMerge 2: 2',
    'awaitFixPrMerge 3: 3',
  ]);
  const call = { activity_type: 'writeThing', kind: 'call' };
  assert.deepEqual(writes, [call, call, { activity_type: 'awaitFixPrMerge', kind: 'wait' }]);
});
