import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure, CancelledFailure } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';

import { hostedRegistry } from '../../src/hosted-registry.js';
import {
  LONG_RETRY_MS,
  NOT_YET_FAILURE_TYPES,
  WAIT_ACTIVITY_TYPES,
  longRetryAlarm,
  type LongRetryPing,
} from '../../src/lib/long-retry.js';
import { healthCheckSlug, type RunShape } from '../../src/lib/run-health.js';

/**
 * The long-retry alarm, driven through its interceptor with a fake context and a
 * fake ping transport. `tests/workflows/long-retry.test.ts` runs it on a test
 * server.
 */

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

interface Attempt {
  type?: string;
  attempt?: number;
  /** When this attempt was scheduled, after the activity was first scheduled. */
  at: number;
  activityId?: string;
  workflowId?: string;
  runId?: string;
  throws?: unknown;
  /** The activity's cancellation signal had fired. */
  aborted?: boolean;
  cancellationDetails?: { cancelRequested?: boolean; timedOut?: boolean };
  retryPolicy?: { maximumAttempts?: number; nonRetryableErrorTypes?: string[] };
}

function harness(ping?: LongRetryPing) {
  const pings: RunShape[] = [];
  const factory = longRetryAlarm(
    ping ??
      (async (signal, shape) => {
        assert.equal(signal, 'long-retry');
        pings.push(shape);
      }),
  );
  /** Runs one attempt. Returns what the interceptor returned or threw. */
  const run = async (a: Attempt): Promise<{ result?: unknown; error?: unknown }> => {
    const ctx = {
      info: {
        activityType: a.type ?? 'writeFindingVerdict',
        attempt: a.attempt ?? 5,
        activityId: a.activityId ?? '1',
        workflowExecution: { workflowId: a.workflowId ?? 'finding/s/k', runId: a.runId ?? 'run-1' },
        scheduledTimestampMs: T0,
        currentAttemptScheduledTimestampMs: T0 + a.at,
        retryPolicy: a.retryPolicy,
      },
      cancellationSignal: { aborted: a.aborted ?? false },
      cancellationDetails: a.cancellationDetails,
    };
    const inbound = factory(ctx as never).inbound!;
    const next = async () => {
      if ('throws' in a) throw a.throws;
      return 'result';
    };
    let outcome: { result?: unknown; error?: unknown };
    try {
      outcome = { result: await inbound.execute!({ args: [], headers: {} }, next) };
    } catch (error) {
      outcome = { error };
    }
    // The ping is not awaited by the interceptor.
    await new Promise((resolve) => setImmediate(resolve));
    return outcome;
  };
  return { run, pings, kinds: () => pings.map((p) => (p.ok ? 'ok' : 'fail')) };
}

const down = () => new Error('GitHub answered 502');
const benign = () => ApplicationFailure.create({ type: 'StillPresent', category: ApplicationFailureCategory.BENIGN });
const notYet = (type = 'PrStillOpen') => ApplicationFailure.retryable('not yet', type);

test('the threshold is two hours and the check is steward-long-retry', () => {
  assert.equal(LONG_RETRY_MS, 2 * HOUR);
  assert.equal(healthCheckSlug('long-retry'), 'steward-long-retry');
});

test('every failing attempt past two hours pings fail, and none before', async () => {
  const h = harness();
  await h.run({ at: LONG_RETRY_MS - 1, throws: down() });
  assert.deepEqual(h.kinds(), []);
  await h.run({ at: LONG_RETRY_MS, attempt: 9, throws: down() });
  await h.run({ at: 3 * HOUR, attempt: 10, throws: ApplicationFailure.retryable('limit', 'RateLimited') });
  assert.deepEqual(h.kinds(), ['fail', 'fail']);
  assert.equal(
    h.pings[0].summary,
    'An activity has been failing for 2 h 0 min and is still being retried. ' +
      'Activity writeFindingVerdict, workflow finding/s/k, attempt 9. Last error: Error: GitHub answered 502',
  );
  assert.match(h.pings[1].summary, /3 h 0 min.*attempt 10\. Last error: RateLimited: limit/);
});

test('a success pings only on a later attempt of an old activity', async () => {
  const h = harness();
  await h.run({ at: HOUR, attempt: 4 });
  await h.run({ at: 3 * HOUR, attempt: 1 });
  assert.deepEqual(h.kinds(), []);
  await h.run({ at: 3 * HOUR, attempt: 2 });
  assert.deepEqual(h.kinds(), ['ok']);
  assert.equal(h.pings[0].summary, 'An activity recovered after 3 h 0 min. Activity writeFindingVerdict, workflow finding/s/k, attempt 2.');
});

test('a cancellation, a benign failure and a "not yet" are not counted', async () => {
  const h = harness();
  const uncounted: Attempt[] = [
    { at: 3 * HOUR, throws: new CancelledFailure('CANCELLED') },
    { at: 3 * HOUR, throws: new Error('fetch aborted'), aborted: true },
    { at: 3 * HOUR, throws: benign() },
    ...[...NOT_YET_FAILURE_TYPES].map((type) => ({ at: 3 * HOUR, throws: notYet(type) })),
  ];
  for (const attempt of uncounted) await h.run(attempt);
  for (const attempt of uncounted) await h.run({ ...attempt, type: 'watchFinding' });
  assert.deepEqual(h.kinds(), []);
});

test('the activity result and its failure pass through unchanged', async () => {
  const h = harness();
  const error = down();
  assert.equal((await h.run({ at: 3 * HOUR, throws: error })).error, error);
  assert.equal((await h.run({ at: 3 * HOUR })).result, 'result');
});

test('a ping that throws, rejects or never answers is dropped', async () => {
  const transports: LongRetryPing[] = [
    () => {
      throw new Error('threw');
    },
    () => Promise.reject(new Error('rejected')),
    () => new Promise(() => {}),
  ];
  for (const transport of transports) {
    const h = harness(transport);
    const error = down();
    assert.equal((await h.run({ at: 3 * HOUR, throws: error })).error, error);
    assert.equal((await h.run({ at: 3 * HOUR })).result, 'result');
  }
});

// --- the waits --------------------------------------------------------------

const wait = (a: Attempt): Attempt => ({ type: 'awaitFixPrMerge', ...a });

test('one failure on day three of a wait raises nothing, and neither does its end', async () => {
  const h = harness();
  await h.run(wait({ at: 72 * HOUR, throws: notYet() }));
  await h.run(wait({ at: 72 * HOUR + 1, throws: down() }));
  await h.run(wait({ at: 72 * HOUR + 2, throws: notYet() }));
  await h.run(wait({ at: 96 * HOUR }));
  assert.deepEqual(h.kinds(), []);
});

test('a wait alarms on a two-hour streak, and a "not yet" then pings the recovery once', async () => {
  const h = harness();
  const day3 = 72 * HOUR;
  await h.run(wait({ at: day3, throws: down() }));
  await h.run(wait({ at: day3 + HOUR, throws: down() }));
  assert.deepEqual(h.kinds(), []);
  await h.run(wait({ at: day3 + 2 * HOUR, throws: down() }));
  assert.match(h.pings[0].summary, /failing for 2 h 0 min.*awaitFixPrMerge/);
  await h.run(wait({ at: day3 + 3 * HOUR, throws: notYet() }));
  await h.run(wait({ at: day3 + 4 * HOUR, throws: notYet() }));
  assert.deepEqual(h.kinds(), ['fail', 'ok']);
  assert.match(h.pings[1].summary, /recovered after 3 h 0 min/);
});

test('a "not yet", a benign failure or a success ends a streak', async () => {
  for (const end of [{ throws: notYet() }, { throws: benign() }, {}]) {
    const h = harness();
    await h.run(wait({ at: 0, throws: down() }));
    await h.run(wait({ at: HOUR, ...end }));
    await h.run(wait({ at: 2 * HOUR, throws: down() }));
    await h.run(wait({ at: 3 * HOUR, throws: down() }));
    assert.deepEqual(h.kinds(), []);
  }
});

test('a streak belongs to one activity of one run', async () => {
  const h = harness();
  await h.run(wait({ at: 0, throws: down() }));
  for (const other of [{ workflowId: 'finding/s/other' }, { runId: 'run-2' }, { activityId: '2' }]) {
    await h.run(wait({ at: 2 * HOUR, throws: down(), ...other }));
  }
  assert.deepEqual(h.kinds(), []);
});

test('a cancel request or a last attempt drops the streak; a timeout keeps it', async () => {
  const cancelled = new CancelledFailure('CANCELLED');
  const dropped: Attempt[] = [
    wait({ at: HOUR, throws: cancelled, cancellationDetails: { cancelRequested: true } }),
    wait({ at: HOUR, throws: ApplicationFailure.nonRetryable('gone', 'NotFound') }),
    wait({ at: HOUR, throws: ApplicationFailure.retryable('gone', 'NotFound'), retryPolicy: { nonRetryableErrorTypes: ['NotFound'] } }),
    wait({ at: HOUR, attempt: 3, throws: down(), retryPolicy: { maximumAttempts: 3 } }),
  ];
  for (const end of dropped) {
    const h = harness();
    await h.run(wait({ at: 0, throws: down() }));
    await h.run(end);
    await h.run(wait({ at: 2 * HOUR, throws: down() }));
    assert.deepEqual(h.kinds(), []);
  }
  const h = harness();
  await h.run(wait({ at: 0, throws: down() }));
  await h.run(wait({ at: HOUR, throws: cancelled, cancellationDetails: { timedOut: true } }));
  await h.run(wait({ at: 2 * HOUR, throws: down() }));
  assert.deepEqual(h.kinds(), ['fail']);
});

// --- the lists --------------------------------------------------------------

const ACTIVITIES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'activities');

/** Retryable failure types that are not a wait's "not yet". A fault, so counted. */
const NOT_A_WAIT = new Set(['BranchMoved']);

/** A function that throws a "not yet" for the activity registered under another name. */
const HELPER_OF: Record<string, string> = { awaitPreviewDeploy: 'awaitPrPreview' };

/** Every `ApplicationFailure.retryable(..., 'Type')` in the activities, with the function that throws it. */
function retryableThrows(): { file: string; fn: string; type: string }[] {
  return fs
    .readdirSync(ACTIVITIES)
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => {
      const source = fs.readFileSync(path.join(ACTIVITIES, file), 'utf8');
      const functions = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
      return [...source.matchAll(/ApplicationFailure\.retryable\([\s\S]*?,\s*'(\w+)',?\s*\)/g)].map((m) => ({
        file,
        fn: functions.filter((f) => f.index < m.index).at(-1)?.[1] ?? '',
        type: m[1],
      }));
    });
}

test('every retryable failure type is a listed "not yet" or a named fault', () => {
  const thrown = retryableThrows();
  for (const t of thrown) {
    assert.ok(
      NOT_YET_FAILURE_TYPES.has(t.type) || NOT_A_WAIT.has(t.type),
      `${t.file}: ${t.type} is neither in NOT_YET_FAILURE_TYPES nor in this test's NOT_A_WAIT`,
    );
  }
  for (const type of NOT_YET_FAILURE_TYPES) {
    assert.ok(thrown.some((t) => t.type === type), `${type} is listed and nothing throws it`);
  }
});

test('every activity that answers "not yet" is a listed wait, and every listed wait is registered', () => {
  const answering = new Set(
    retryableThrows()
      .filter((t) => NOT_YET_FAILURE_TYPES.has(t.type))
      .map((t) => HELPER_OF[t.fn] ?? t.fn),
  );
  // `watchFinding` says "not yet" with a benign failure instead.
  assert.deepEqual([...answering, 'watchFinding'].sort(), [...WAIT_ACTIVITY_TYPES].sort());
  const registered = new Set(hostedRegistry().flatMap((queue) => Object.keys(queue.activities)));
  for (const type of WAIT_ACTIVITY_TYPES) assert.ok(registered.has(type), `${type} is not a hosted activity`);
});
