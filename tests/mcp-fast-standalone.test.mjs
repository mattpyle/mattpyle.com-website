import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_FAST_ACTIVITY_TYPE,
  AUDIT_FAST_TASK_QUEUE,
} from '@mattpyle/steward/agent-audit/deep-contract';
import { createFastAuditRunner, withPath } from '../src/lib/mcp-fast-standalone.mjs';

// The fast tier's standalone path, driven against a fake Temporal client.
//
// The card's Done-when line is "the fast tier still answers when Temporal Cloud is unreachable,
// proven by tests against a fake client rather than by reading the source", and that is the whole
// design of this file: the module takes the client, the in-function auditor, the clock and the
// suffix as arguments, so all four fallback triggers, the dedup read and every `tool.path` value
// are reachable here with no Temporal, no network and no source-text assertions.

const NOW = new Date('2026-09-04T17:42:11.000Z');

/** The ID the hour and origin above produce. Written out so a change to either is visible here. */
const HOUR_ID = 'audit:https://example.com:2026-09-04T17';

/** A minimal document with the shape `tool.path` is written onto. */
function auditFor(url, where) {
  return {
    schemaVersion: 2,
    tool: { name: 'steward audit-url', version: '0.2.0' },
    target: { input: url, origin: 'https://example.com' },
    startedAt: '2026-09-04T17:42:11.000Z',
    finishedAt: '2026-09-04T17:42:15.000Z',
    durationMs: 4000,
    requests: 11,
    // Not part of the contract — a marker so a test can tell which auditor produced the document.
    ranBy: where,
    categories: [],
    checks: [],
    notes: [],
  };
}

/** The error the SDK raises when the reuse policy refuses a start. */
function alreadyStarted() {
  const err = new Error('Activity execution already started');
  err.name = 'ActivityExecutionAlreadyStartedError';
  return err;
}

/**
 * A runner over a fake client, and one record of everything either side did.
 *
 * `makeClient` receives that record, so a test's client and the runner write to the same place;
 * `clientError` is the shorthand for the connect that never produces one. Everything else has a
 * working default, so each test names only the thing it is about.
 */
function runnerWith({ makeClient, clientError, runInFunction, budgetMs = 45_000, suffix = 'aabbccdd', clock } = {}) {
  const calls = { started: [], handles: [], inFunction: [], logged: [] };
  let ticks = 0;
  const runner = createFastAuditRunner({
    getClient: async () => {
      if (clientError) throw clientError;
      return makeClient(calls);
    },
    runInFunction: async (url, budget) => {
      calls.inFunction.push({ url, budget });
      return (runInFunction ?? ((target) => auditFor(target, 'function')))(url, budget);
    },
    budgetMs,
    now: clock ?? (() => new Date(NOW.getTime() + ticks++ * 1000)),
    randomSuffix: () => suffix,
    log: (fields) => calls.logged.push(fields),
  });
  return { runner, calls };
}

/** A client whose `start` resolves and whose handles answer with `audit`. */
function clientReturning(audit) {
  return (calls) => ({
    activity: {
      start: async (type, options) => {
        calls.started.push({ type, options });
        return { result: async () => audit };
      },
      getHandle: (id) => {
        calls.handles.push(id);
        return { result: async () => audit };
      },
    },
  });
}

test('a healthy start runs the activity on the fast queue and reports the standalone path', async () => {
  const { runner, calls } = runnerWith({
    makeClient: clientReturning(auditFor('example.com', 'activity')),
  });

  const audit = await runner('example.com', { fresh: false, origin: 'https://example.com' });

  assert.equal(audit.tool.path, 'standalone');
  assert.equal(audit.ranBy, 'activity', 'the document must be the activity, not a local re-run');
  assert.equal(calls.inFunction.length, 0, 'nothing runs in the function when the activity answers');

  assert.equal(calls.started.length, 1);
  const [{ type, options }] = calls.started;
  assert.equal(type, AUDIT_FAST_ACTIVITY_TYPE);
  assert.equal(options.taskQueue, AUDIT_FAST_TASK_QUEUE);
  assert.equal(
    options.id,
    HOUR_ID,
    'the ID is the origin and the UTC hour, which is what makes two callers one visit',
  );
  assert.equal(options.idConflictPolicy, 'USE_EXISTING');
  assert.equal(
    options.idReusePolicy,
    'ALLOW_DUPLICATE_FAILED_ONLY',
    'a completed run is shared, a failed one is replaced rather than locking the hour',
  );
  assert.deepEqual(options.args, ['example.com', { budgetMs: 30_000 }]);
  assert.equal(options.retry.maximumAttempts, 2, 'every attempt is a billable Action and a visit');
  assert.equal(options.scheduleToStartTimeout, 8_000);
  assert.equal(options.startToCloseTimeout, 40_000);
});

test('a start refused as a duplicate reads the finished result back and says it was shared', async () => {
  const shared = auditFor('example.com', 'an earlier caller');
  const { runner, calls } = runnerWith({
    makeClient: (record) => ({
      activity: {
        start: async (type, options) => {
          record.started.push({ type, options });
          throw alreadyStarted();
        },
        getHandle: (id) => {
          record.handles.push(id);
          return { result: async () => shared };
        },
      },
    }),
  });

  const audit = await runner('example.com', { fresh: false, origin: 'https://example.com' });

  assert.equal(audit.tool.path, 'standalone-shared');
  assert.equal(audit.ranBy, 'an earlier caller');
  assert.deepEqual(
    calls.handles,
    [HOUR_ID],
    'the finished result is read back by the same ID the start was refused under',
  );
  assert.equal(calls.inFunction.length, 0, 'a dedup hit is a success, never a fallback');
});

test('a start after the hour ID failed runs again rather than reading the failure back', async () => {
  // What `ALLOW_DUPLICATE_FAILED_ONLY` buys: the server lets the start through instead of raising
  // `ActivityExecutionAlreadyStartedError`, so the module never reaches the read-back branch and
  // the caller gets a fresh audit rather than the earlier run's failure and a fallback.
  const { runner, calls } = runnerWith({
    makeClient: (record) => ({
      activity: {
        start: async (type, options) => {
          record.started.push({ type, options });
          return { result: async () => auditFor('example.com', 'the replacement run') };
        },
        getHandle: () => assert.fail('a failed run is replaced, never read back'),
      },
    }),
  });

  const audit = await runner('example.com', { fresh: false, origin: 'https://example.com' });

  assert.equal(audit.tool.path, 'standalone', 'a replacement run is not a shared one');
  assert.equal(audit.ranBy, 'the replacement run');
  assert.deepEqual(calls.handles, [], 'nothing is read back by handle');
  assert.equal(calls.started[0].options.id, HOUR_ID, 'the replacement keeps the hour bucket');
  assert.equal(calls.inFunction.length, 0, 'the hour is not sent through the fallback');
});

test('fresh: true adds a suffix and drops both dedup policies', async () => {
  const { runner, calls } = runnerWith({
    makeClient: clientReturning(auditFor('example.com', 'activity')),
    suffix: '0f1e2d3c',
  });

  const audit = await runner('example.com', { fresh: true, origin: 'https://example.com' });

  assert.equal(audit.tool.path, 'standalone');
  const [{ options }] = calls.started;
  assert.equal(options.id, `${HOUR_ID}:0f1e2d3c`);
  assert.equal(options.idConflictPolicy, undefined, 'a unique ID has nothing to conflict with');
  assert.equal(
    options.idReusePolicy,
    undefined,
    'a reuse policy on a unique ID is a rule waiting for the day the suffix repeats',
  );
});

test('trigger 1: no Temporal configuration falls back into the function', async () => {
  const { runner, calls } = runnerWith({
    clientError: new Error('The deep tier is not configured on this deployment'),
  });

  const audit = await runner('example.com', { fresh: false, origin: 'https://example.com' });

  assert.equal(audit.tool.path, 'function');
  assert.equal(audit.ranBy, 'function');
  assert.equal(calls.inFunction.length, 1);
  assert.equal(calls.logged[0].outcome, 'fast-audit-fallback');
  assert.match(calls.logged[0].reason, /not configured/);
});

test('trigger 2: a start that fails falls back, and the caller never sees the Temporal error', async () => {
  const { runner, calls } = runnerWith({
    makeClient: () => ({
      activity: {
        start: async () => {
          throw new Error('14 UNAVAILABLE: no connection established');
        },
        getHandle: () => assert.fail('a failed start is not a duplicate and must not be read back'),
      },
    }),
  });

  const audit = await runner('example.com', { fresh: false, origin: 'https://example.com' });

  assert.equal(audit.tool.path, 'function');
  assert.equal(calls.inFunction.length, 1);
  assert.match(calls.logged[0].reason, /UNAVAILABLE/);
});

test('trigger 3: a schedule-to-start timeout falls back, and the log names the timeout', async () => {
  // The shape the SDK really produces, measured against a dev server on 2026-09-04: the outer
  // error says only "Activity execution failed", and which of the four triggers fired is on
  // `.cause`. A log line carrying the outer message would say the same thing for all four.
  const wrapped = new Error('Activity execution failed', {
    cause: new Error('activity ScheduleToStart timeout'),
  });
  wrapped.name = 'ActivityExecutionFailedError';
  const { runner, calls } = runnerWith({
    makeClient: () => ({
      activity: {
        start: async () => ({
          result: async () => {
            throw wrapped;
          },
        }),
      },
    }),
  });

  const audit = await runner('example.com', { fresh: false, origin: 'https://example.com' });

  assert.equal(audit.tool.path, 'function');
  assert.equal(calls.logged[0].reason, 'activity ScheduleToStart timeout');
});

test('trigger 4: no result inside the budget falls back, with what is left of the budget', async () => {
  // Three readings, in the order the runner takes them: the call starting, the activity ID's hour,
  // and the moment the fallback begins. Forty of the budget's seconds are gone by the third.
  const times = [NOW.getTime(), NOW.getTime(), NOW.getTime() + 40_000];
  let index = 0;
  const { runner, calls } = runnerWith({
    // Never settles. The runner's own deadline is the only thing that ends this.
    makeClient: () => ({ activity: { start: async () => ({ result: () => new Promise(() => {}) }) } }),
    budgetMs: 60,
    clock: () => new Date(times[Math.min(index++, times.length - 1)]),
  });

  const audit = await runner('example.com', { fresh: false, origin: 'https://example.com' });

  assert.equal(audit.tool.path, 'function');
  assert.match(calls.logged[0].reason, /did not answer within/);
  assert.equal(
    calls.inFunction[0].budget,
    10_000,
    'a fallback that starts late gets the floor, so one call can never spend two whole budgets',
  );
});

test('the fallback gets the rest of the budget when the standalone attempt was cheap', async () => {
  // Two readings only: a connect that throws never reaches the activity ID.
  const times = [NOW.getTime(), NOW.getTime() + 8_000];
  let index = 0;
  const { runner, calls } = runnerWith({
    clientError: new Error('no configuration'),
    budgetMs: 45_000,
    clock: () => new Date(times[Math.min(index++, times.length - 1)]),
  });

  await runner('example.com', { fresh: false, origin: 'https://example.com' });

  assert.equal(calls.inFunction[0].budget, 37_000);
});

test('a fallback audit that itself fails is still a tool error, not a silent empty report', async () => {
  const { runner } = runnerWith({
    clientError: new Error('no configuration'),
    runInFunction: () => {
      throw new Error('"nope" is not a URL.');
    },
  });

  await assert.rejects(runner('nope', { fresh: false, origin: 'https://nope' }), /is not a URL/);
});

test('withPath copies the document rather than writing into a shared result', () => {
  const shared = auditFor('example.com', 'activity');
  const tagged = withPath(shared, 'standalone-shared');

  assert.equal(tagged.tool.path, 'standalone-shared');
  assert.equal(shared.tool.path, undefined, 'the result another caller is holding is untouched');
  assert.equal(tagged.tool.name, shared.tool.name, 'the rest of the header rides along');
});
