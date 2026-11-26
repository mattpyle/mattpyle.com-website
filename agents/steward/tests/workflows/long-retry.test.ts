import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { longRetryAlarm } from '../../src/lib/long-retry.js';
import type { RunShape } from '../../src/lib/run-health.js';
import { bounded, createTestEnv } from '../helpers/test-env.js';

/**
 * The long-retry alarm on real activities, with the server's timestamps and
 * hours of skipped time. The ping transport is a list.
 */

let env: TestWorkflowEnvironment;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env?.teardown();
});

/** Runs one stub workflow and returns the pings, each with the attempt that sent it. */
async function pingsOf(workflow: string, activities: Record<string, () => Promise<void>>) {
  const pings: { ok: boolean; attempt: number; summary: string }[] = [];
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'long-retry',
    workflowsPath: fileURLToPath(new URL('./long-retry.workflows.ts', import.meta.url)),
    activities,
    interceptors: {
      activity: [
        longRetryAlarm(async (_signal: 'long-retry', shape: RunShape) => {
          pings.push({ ok: shape.ok, attempt: Number(/attempt (\d+)/.exec(shape.summary)?.[1]), summary: shape.summary });
        }),
      ],
    },
  });
  await worker.runUntil(bounded(env.client.workflow.execute(workflow, { taskQueue: 'long-retry', workflowId: workflow })));
  return pings;
}

test('an activity failing for two hours pings each later attempt, then its recovery', async () => {
  // Attempts every 30 minutes. This server stamps a retry with the time it was
  // decided, not the time it is due, so attempt 6 is the first to read two
  // hours. A dev server stamps the due time, one attempt sooner.
  const pings = await pingsOf('longRetryWorkflow', {
    async writeThing() {
      if (Context.current().info.attempt < 8) throw new Error('GitHub answered 500');
    },
  });
  assert.deepEqual(
    pings.map((p) => [p.ok, p.attempt]),
    [
      [false, 6],
      [false, 7],
      [true, 8],
    ],
  );
  assert.match(pings[0].summary, /failing for 2 h 0 min.*Activity writeThing, workflow longRetryWorkflow.*GitHub answered 500/);
});

test('a wait three hours old alarms on its streak of failures, not on its age', async () => {
  // "Not yet" for three hours (attempts 1 to 7), one failure (8), "not yet" (9),
  // then failures from 10: attempt 14 is two hours into that streak, and the
  // "not yet" at 15 recovers it.
  const pings = await pingsOf('longWaitWorkflow', {
    async awaitFixPrMerge() {
      const { attempt } = Context.current().info;
      if (attempt === 16) return;
      if (attempt === 8 || (attempt >= 10 && attempt <= 14)) throw new Error('GitHub answered 502');
      throw ApplicationFailure.retryable('the PR is still open', 'PrStillOpen');
    },
  });
  assert.deepEqual(
    pings.map((p) => [p.ok, p.attempt]),
    [
      [false, 14],
      [true, 15],
    ],
  );
});
