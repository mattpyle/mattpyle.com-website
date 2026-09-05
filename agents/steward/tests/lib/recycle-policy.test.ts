import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActivityTracker,
  RECYCLE_IDLE_MS,
  shouldRecycle,
  trackActivityExecution,
} from '../../src/lib/recycle-policy.js';

/**
 * The recycle exists to drop the hosted worker's memory bill, and it is the one
 * feature in this codebase whose failure mode is a worker that exits while
 * somebody's audit is running. These tests hold the four states the decision
 * function distinguishes, and the interceptor's accounting that feeds them.
 *
 * The decision is a pure function of four numbers precisely so this file needs
 * no worker, no clock, and no Temporal.
 */

const NOW = 1_800_000_000_000;

test('a worker that has run no browser activity never recycles', () => {
  const decision = shouldRecycle(
    { lastBrowserActivityAt: null, lastActivityFinishedAt: NOW - 60 * 60 * 1000, inFlight: 0 },
    NOW,
  );
  assert.equal(decision.recycle, false);
  assert.match(decision.reason, /no browser activity/);
});

test('a browser activity has run and the worker is idle: recycle', () => {
  const decision = shouldRecycle(
    {
      lastBrowserActivityAt: NOW - 20 * 60 * 1000,
      lastActivityFinishedAt: NOW - RECYCLE_IDLE_MS - 1000,
      inFlight: 0,
    },
    NOW,
  );
  assert.equal(decision.recycle, true);
  assert.match(decision.reason, /idle/);
});

test('an activity in flight is never interrupted, however long the worker has been up', () => {
  const decision = shouldRecycle(
    {
      lastBrowserActivityAt: NOW - 20 * 60 * 1000,
      lastActivityFinishedAt: NOW - 60 * 60 * 1000,
      inFlight: 1,
    },
    NOW,
  );
  assert.equal(decision.recycle, false);
  assert.match(decision.reason, /in flight/);
});

test('an activity that finished two minutes ago is inside the idle window: keep running', () => {
  const decision = shouldRecycle(
    {
      lastBrowserActivityAt: NOW - 20 * 60 * 1000,
      lastActivityFinishedAt: NOW - 2 * 60 * 1000,
      inFlight: 0,
    },
    NOW,
  );
  assert.equal(decision.recycle, false);
  assert.match(decision.reason, /120s ago/);
});

test('the idle window is exclusive at its own edge, so a tick early never recycles', () => {
  const state = {
    lastBrowserActivityAt: NOW - 20 * 60 * 1000,
    lastActivityFinishedAt: NOW - RECYCLE_IDLE_MS,
    inFlight: 0,
  };
  assert.equal(shouldRecycle(state, NOW).recycle, true);
  assert.equal(shouldRecycle(state, NOW - 1).recycle, false);
});

test('the tracker records a browser activity, its end, and the in-flight count', async () => {
  let clock = NOW;
  const tracker = new ActivityTracker(() => clock);
  const interceptors = trackActivityExecution(tracker);

  assert.deepEqual(tracker.state(), {
    lastBrowserActivityAt: null,
    lastActivityFinishedAt: null,
    inFlight: 0,
  });

  const inbound = interceptors({ info: { activityType: 'auditRenderedPage' } } as never).inbound;
  assert.ok(inbound?.execute, 'the factory must install an inbound execute interceptor');

  let stateDuringExecution = tracker.state();
  const next = async () => {
    stateDuringExecution = tracker.state();
    clock = NOW + 5000;
    return 'the activity result';
  };
  const result = await inbound.execute({ args: [], headers: {} } as never, next as never);

  assert.equal(result, 'the activity result', 'the interceptor must return what the activity did');
  assert.equal(stateDuringExecution.inFlight, 1, 'in flight while the activity runs');
  assert.equal(stateDuringExecution.lastBrowserActivityAt, NOW, 'the browser activity is stamped');
  assert.deepEqual(tracker.state(), {
    lastBrowserActivityAt: NOW,
    lastActivityFinishedAt: NOW + 5000,
    inFlight: 0,
  });
});

test('a failed activity still ends, so a crash cannot strand the worker in flight', async () => {
  const tracker = new ActivityTracker(() => NOW);
  const inbound = trackActivityExecution(tracker)({
    info: { activityType: 'auditSiteFast' },
  } as never).inbound;

  await assert.rejects(
    inbound!.execute!({ args: [], headers: {} } as never, (async () => {
      throw new Error('chrome died');
    }) as never),
    /chrome died/,
  );
  const state = tracker.state();
  assert.equal(state.inFlight, 0, 'the finally must release the slot');
  assert.equal(state.lastActivityFinishedAt, NOW);
  assert.equal(
    state.lastBrowserActivityAt,
    null,
    'a fetch-only activity must not arm the recycle policy',
  );
});

/**
 * Read as source text rather than by importing the worker, for the reason
 * `hosted-worker-concurrency.test.ts` gives: `worker-hosted.ts` calls `main()`
 * at module scope.
 *
 * What this holds is the rule the card states as "the recycle is hosted-only".
 * The laptop worker (`worker.ts`, started by `steward up`) must never exit
 * mid-session, and the only thing stopping a later edit from lifting the policy
 * into the shared worker is that somebody notices. This test notices.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

test('the recycle is wired into the hosted worker and nowhere else', async () => {
  const hosted = await fs.readFile(path.join(SRC, 'worker-hosted.ts'), 'utf8');
  assert.match(hosted, /watchForRecycle\(worker, tracker\)/);
  assert.match(hosted, /interceptors: \{ activity: \[trackActivityExecution\(tracker\)\] \}/);

  const local = await fs.readFile(path.join(SRC, 'worker.ts'), 'utf8');
  assert.doesNotMatch(
    local,
    /recycle-policy/,
    'worker.ts is the laptop worker; a worker that exits mid-session is a surprise',
  );
});
