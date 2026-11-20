import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRateLimit } from '../src/lib/mcp-rate-limit.mjs';

// The limiter's wire behaviour, written out as literals: every key, every TTL, every verdict, for
// each tier and each way a check can end. The key builders are deliberately not imported, so a
// change to how a key is assembled fails here even when the builders and `checkRateLimit` still
// agree with each other. Stored counters are read by these exact strings, and a key that moves
// starts every caller's window again.

const IP = '203.0.113.7';
const HASH = '5689b2211a4a900895af69e079f77c7e';
const NOW = new Date('2026-08-15T15:20:30.000Z');
// 15:20:30 UTC: 2370 seconds left in the hour, 31170 in the day. Hour 496335 since the epoch.
const HOUR_TTL = '2370';
const DAY_TTL = '31170';

const ENV = {
  MCP_AUDIT_RATE_SECRET: 'a-test-secret',
  UPSTASH_REDIS_REST_URL: 'https://store.example',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

const TIERS = {
  fast: {
    caller: { key: `mcp:v1:caller:${HASH}:496335`, ttl: HOUR_TTL, limit: 10 },
    global: { key: 'mcp:v1:global:2026-08-15', ttl: DAY_TTL, limit: 500 },
    callerReason: 'this caller has used 10 audits in the current window',
    globalReason: 'this endpoint has run 500 audits today',
    callerRetry: 2370,
  },
  deep: {
    caller: { key: `mcp:v1:deep:caller:${HASH}:2026-08-15`, ttl: DAY_TTL, limit: 2 },
    global: { key: 'mcp:v1:deep:global:2026-08-15', ttl: DAY_TTL, limit: 10 },
    callerReason: 'this caller has used 2 deep audits today',
    globalReason: 'this endpoint has run 10 deep audits today',
    callerRetry: 31170,
  },
  session: {
    caller: { key: `mcp:v1:session:caller:${HASH}:2026-08-15`, ttl: DAY_TTL, limit: 3 },
    global: { key: 'mcp:v1:session:global:2026-08-15', ttl: DAY_TTL, limit: 20 },
    callerReason: 'this caller has used 3 consultant sessions today',
    globalReason: 'this endpoint has run 20 consultant sessions today',
    callerRetry: 31170,
  },
};

/** A store that answers each key with a set count, and records each request exactly as sent. */
function fakeStore({ counts = {}, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, commands: JSON.parse(init.body) });
    if (status !== 200) return { ok: false, status, json: async () => [] };
    const key = JSON.parse(init.body)[0][1];
    return { ok: true, status: 200, json: async () => [{ result: counts[key] ?? 1 }, { result: 1 }] };
  };
  return { calls, fetchImpl };
}

const request = (counter) => ({
  url: 'https://store.example/pipeline',
  method: 'POST',
  headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
  commands: [
    ['INCR', counter.key],
    ['EXPIRE', counter.key, counter.ttl],
  ],
});

for (const [tier, expected] of Object.entries(TIERS)) {
  test(`${tier}: an allowed call writes the caller key, then the global key`, async () => {
    const store = fakeStore();
    const verdict = await checkRateLimit({ ip: IP, tier, env: ENV, now: NOW, fetchImpl: store.fetchImpl });
    assert.deepEqual(store.calls, [request(expected.caller), request(expected.global)]);
    assert.deepEqual(verdict, {
      allowed: true,
      tier,
      caller: { used: 1, limit: expected.caller.limit },
      global: { used: 1, limit: expected.global.limit },
    });
  });

  test(`${tier}: a caller past their limit is refused on one store request`, async () => {
    const used = expected.caller.limit + 1;
    const store = fakeStore({ counts: { [expected.caller.key]: used } });
    const verdict = await checkRateLimit({ ip: IP, tier, env: ENV, now: NOW, fetchImpl: store.fetchImpl });
    assert.deepEqual(store.calls, [request(expected.caller)]);
    assert.deepEqual(verdict, {
      allowed: false,
      tier,
      scope: 'caller',
      reason: expected.callerReason,
      retryAfterSeconds: expected.callerRetry,
      used,
      limit: expected.caller.limit,
    });
  });

  test(`${tier}: a spent global budget is refused until the end of the UTC day`, async () => {
    const used = expected.global.limit + 1;
    const store = fakeStore({ counts: { [expected.global.key]: used } });
    const verdict = await checkRateLimit({ ip: IP, tier, env: ENV, now: NOW, fetchImpl: store.fetchImpl });
    assert.deepEqual(store.calls, [request(expected.caller), request(expected.global)]);
    assert.deepEqual(verdict, {
      allowed: false,
      tier,
      scope: 'global',
      reason: expected.globalReason,
      retryAfterSeconds: 31170,
      used,
      limit: expected.global.limit,
    });
  });

  test(`${tier}: a store error, a missing secret, a missing store and a missing address all refuse`, async () => {
    const failing = fakeStore({ status: 500 });
    assert.deepEqual(await checkRateLimit({ ip: IP, tier, env: ENV, now: NOW, fetchImpl: failing.fetchImpl }), {
      allowed: false,
      tier,
      scope: 'store',
      reason: 'the rate-limit store could not be reached: Error',
      retryAfterSeconds: 60,
    });
    assert.equal(failing.calls.length, 1);

    const untouched = fakeStore();
    const check = (input) => checkRateLimit({ ip: IP, tier, env: ENV, now: NOW, fetchImpl: untouched.fetchImpl, ...input });
    assert.deepEqual(await check({ env: { ...ENV, MCP_AUDIT_RATE_SECRET: undefined } }), {
      allowed: false,
      tier,
      scope: 'config',
      reason: 'the endpoint has no rate-limit secret configured, so it cannot tell callers apart',
      retryAfterSeconds: 60,
    });
    assert.deepEqual(await check({ env: { MCP_AUDIT_RATE_SECRET: 'a-test-secret' } }), {
      allowed: false,
      tier,
      scope: 'store',
      reason: 'the endpoint has no rate-limit store configured',
      retryAfterSeconds: 60,
    });
    assert.deepEqual(await check({ ip: null }), {
      allowed: false,
      tier,
      scope: 'caller-unknown',
      reason: 'the request carried no client address, so it cannot be rate limited',
      retryAfterSeconds: 60,
    });
    assert.equal(untouched.calls.length, 0);
  });
}

test('the environment moves each limit, and the fast window, without moving another tier', async () => {
  const env = {
    ...ENV,
    MCP_AUDIT_RATE_PER_CALLER: '4',
    MCP_AUDIT_RATE_WINDOW_SECONDS: '600',
    MCP_AUDIT_RATE_GLOBAL_PER_DAY: '40',
    MCP_DEEP_RATE_PER_CALLER: '5',
    MCP_DEEP_RATE_GLOBAL_PER_DAY: '50',
    A2A_SESSION_RATE_PER_CALLER: '6',
    A2A_SESSION_RATE_GLOBAL_PER_DAY: '60',
  };
  const run = async (tier) => {
    const store = fakeStore();
    const verdict = await checkRateLimit({ ip: IP, tier, env, now: NOW, fetchImpl: store.fetchImpl });
    return { verdict, commands: store.calls.map((call) => call.commands) };
  };

  // A ten-minute window: index 2978012, 570 seconds left at 15:20:30.
  const fast = await run('fast');
  assert.deepEqual(fast.commands[0], [
    ['INCR', `mcp:v1:caller:${HASH}:2978012`],
    ['EXPIRE', `mcp:v1:caller:${HASH}:2978012`, '570'],
  ]);
  assert.deepEqual([fast.verdict.caller.limit, fast.verdict.global.limit], [4, 40]);

  // The fast window variable does not reach the daily tiers.
  const deep = await run('deep');
  assert.deepEqual(deep.commands[0][1], ['EXPIRE', `mcp:v1:deep:caller:${HASH}:2026-08-15`, DAY_TTL]);
  assert.deepEqual([deep.verdict.caller.limit, deep.verdict.global.limit], [5, 50]);

  const session = await run('session');
  assert.deepEqual([session.verdict.caller.limit, session.verdict.global.limit], [6, 60]);
});

test('a tier name the limiter does not know is counted as a fast audit', async () => {
  // What `checkRateLimit` has always done with a name it was not taught: charge the fast counters
  // and echo the name back. Names that are properties of every object are no exception.
  for (const tier of ['nonsense', 'constructor', 'toString']) {
    const store = fakeStore();
    const verdict = await checkRateLimit({ ip: IP, tier, env: ENV, now: NOW, fetchImpl: store.fetchImpl });
    assert.deepEqual(store.calls, [request(TIERS.fast.caller), request(TIERS.fast.global)]);
    assert.deepEqual(verdict, {
      allowed: true,
      tier,
      caller: { used: 1, limit: 10 },
      global: { used: 1, limit: 500 },
    });
  }
});
