import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { rateLimitFailure } from '../../src/lib/github.js';
import { bounded, createTestEnv } from '../helpers/test-env.js';

/**
 * A `RateLimited` failure carries `nextRetryDelay`, and GitHub's wait can be far
 * longer than a policy's `maximumInterval`. This shows the time-skipping test
 * server waits the delay the failure asks for and does not cut it to that
 * interval.
 */

let env: TestWorkflowEnvironment;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env?.teardown();
});

test('a nextRetryDelay longer than the maximum interval is waited in full', async () => {
  let attempts = 0;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'next-retry-delay',
    workflowsPath: fileURLToPath(new URL('./next-retry-delay.workflows.ts', import.meta.url)),
    activities: {
      async limitedOnce(): Promise<void> {
        attempts = Context.current().info.attempt;
        if (attempts > 1) return;
        const headers = new Headers({ 'retry-after': '3600' });
        throw rateLimitFailure({ status: 403, ok: false, headers, text: '{}' }, '/repos/o/r');
      },
    },
  });
  const elapsed = await worker.runUntil(
    bounded(
      env.client.workflow.execute('nextRetryDelayWorkflow', {
        taskQueue: 'next-retry-delay',
        workflowId: 'next-retry-delay',
      }),
    ),
  );
  assert.equal(attempts, 2);
  assert.ok(Number(elapsed) >= 3_600_000, `waited ${String(elapsed)} ms`);
});
