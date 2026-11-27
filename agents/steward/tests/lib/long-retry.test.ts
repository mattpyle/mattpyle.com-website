import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure, CancelledFailure } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';

import { hostedRegistry } from '../../src/hosted-registry.js';
import {
  NOT_YET_FAILURE_TYPES,
  WAIT_ACTIVITY_TYPES,
  longRetryAlarm,
  type LastFailureGauge,
} from '../../src/lib/long-retry.js';
import { createLastFailureGauge } from '../../src/lib/temporal-logger.js';

/**
 * The last-failure gauge, driven through its interceptor with a fake context and
 * a fake gauge. `tests/workflows/long-retry.test.ts` runs it on a test server.
 */

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

interface Attempt {
  type?: string;
  attempt?: number;
  /** When this attempt was scheduled, after the activity was first scheduled. */
  at: number;
  throws?: unknown;
  /** The activity's cancellation signal had fired. */
  aborted?: boolean;
  retryPolicy?: { maximumAttempts?: number; nonRetryableErrorTypes?: string[] };
}

function harness(gauge?: LastFailureGauge) {
  const factory = longRetryAlarm(gauge);
  /** Runs one attempt. Returns what the interceptor returned or threw. */
  const run = async (a: Attempt): Promise<{ result?: unknown; error?: unknown }> => {
    const ctx = {
      info: {
        activityType: a.type ?? 'writeFindingVerdict',
        attempt: a.attempt ?? 5,
        activityId: '1',
        workflowExecution: { workflowId: 'finding/s/k', runId: 'run-1' },
        scheduledTimestampMs: T0,
        currentAttemptScheduledTimestampMs: T0 + a.at,
        retryPolicy: a.retryPolicy,
      },
      cancellationSignal: { aborted: a.aborted ?? false },
    };
    const inbound = factory(ctx as never).inbound!;
    const next = async () => {
      if ('throws' in a) throw a.throws;
      return 'result';
    };
    try {
      return { result: await inbound.execute!({ args: [], headers: {} }, next) };
    } catch (error) {
      return { error };
    }
  };
  return { run };
}

const down = () => new Error('GitHub answered 502');
const benign = () => ApplicationFailure.create({ type: 'StillPresent', category: ApplicationFailureCategory.BENIGN });
const notYet = (type = 'PrStillOpen') => ApplicationFailure.retryable('not yet', type);

test('the activity result and its failure pass through unchanged', async () => {
  const h = harness();
  const error = down();
  assert.equal((await h.run({ at: 3 * HOUR, throws: error })).error, error);
  assert.equal((await h.run({ at: 3 * HOUR })).result, 'result');
});

const wait = (a: Attempt): Attempt => ({ type: 'awaitFixPrMerge', ...a });

// --- the last-failure gauge -------------------------------------------------

function fakeGauge() {
  const writes: { value: number; labels: unknown }[] = [];
  const gauge: LastFailureGauge = { set: (value, labels) => void writes.push({ value, labels }) };
  return { gauge, writes };
}

test('a counted failure writes the time and the two labels', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: T0 + 999 });
  t.after(() => mock.timers.reset());
  const g = fakeGauge();
  const h = harness(g.gauge);
  await h.run({ at: 0, attempt: 1, throws: down() });
  await h.run({ at: 3 * HOUR, throws: down() });
  await h.run(wait({ at: 0, attempt: 1, throws: down() }));
  await h.run(wait({ at: 2 * HOUR, throws: ApplicationFailure.nonRetryable('gone', 'NotFound') }));
  const call = { value: T0 / 1000, labels: { activity_type: 'writeFindingVerdict', kind: 'call' } };
  const merge = { value: T0 / 1000, labels: { activity_type: 'awaitFixPrMerge', kind: 'wait' } };
  assert.deepEqual(g.writes, [call, call, merge, merge]);
});

test('a success, a cancellation, a benign failure and a "not yet" write nothing', async () => {
  const g = fakeGauge();
  const h = harness(g.gauge);
  const unwritten: Attempt[] = [
    { at: 3 * HOUR },
    { at: 3 * HOUR, throws: new CancelledFailure('CANCELLED') },
    { at: 3 * HOUR, throws: new Error('fetch aborted'), aborted: true },
    { at: 3 * HOUR, throws: benign() },
    ...[...NOT_YET_FAILURE_TYPES].map((type) => ({ at: 3 * HOUR, throws: notYet(type) })),
  ];
  for (const attempt of unwritten) {
    await h.run(attempt);
    await h.run({ ...attempt, type: 'watchFinding' });
  }
  assert.deepEqual(g.writes, []);
});

test('two failures a second apart write different values', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  t.after(() => mock.timers.reset());
  const g = fakeGauge();
  const h = harness(g.gauge);
  await h.run({ at: 0, throws: down() });
  mock.timers.tick(1000);
  await h.run({ at: 0, throws: down() });
  assert.deepEqual(
    g.writes.map((w) => w.value),
    [T0 / 1000, T0 / 1000 + 1],
  );
});

test('a gauge that throws leaves the activity alone, and one that works is written once', async () => {
  const broken: LastFailureGauge = {
    set: () => {
      throw new Error('meter gone');
    },
  };
  const h = harness(broken);
  const error = down();
  assert.equal((await h.run({ at: 3 * HOUR, throws: error })).error, error);

  const g = fakeGauge();
  const silent = harness(g.gauge);
  assert.equal((await silent.run({ at: 3 * HOUR, throws: error })).error, error);
  assert.equal(g.writes.length, 1);
});

test('the gauge is an int in seconds with no tags of its own', () => {
  const made: unknown[][] = [];
  const gauge = { set: () => {} };
  const meter = {
    createGauge: (...args: unknown[]) => {
      made.push(args.slice(0, 3));
      return gauge;
    },
  };
  assert.equal(createLastFailureGauge(meter as never), gauge);
  assert.deepEqual(made, [['steward_activity_last_failure_timestamp', 'int', 'seconds']]);
});

test('a meter that throws gives no gauge and one warning', () => {
  const warnings: unknown[] = [];
  const meter = {
    createGauge: () => {
      throw new Error('no meter');
    },
  };
  assert.equal(createLastFailureGauge(meter as never, { warn: (...a: unknown[]) => void warnings.push(a) } as never), undefined);
  assert.equal(warnings.length, 1);
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
