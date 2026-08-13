import assert from 'node:assert/strict';
import test from 'node:test';
import {
  callerHash,
  callerKeyFor,
  checkRateLimit,
  clientIpFrom,
  counterCommands,
  DEFAULT_GLOBAL_PER_DAY,
  DEFAULT_PER_CALLER,
  DEFAULT_WINDOW_SECONDS,
  globalKeyFor,
  readLimits,
  utcDayFor,
  windowFor,
} from '../src/lib/mcp-rate-limit.mjs';

// The limit in front of /mcp. Four properties are what these tests exist for, because each one
// fails silently and expensively: the stored key is a hash and not an address, a caller over the
// limit is refused with a Retry-After, a caller over the limit does not spend the global budget,
// and a store that cannot be reached refuses rather than admits.

const IP = '203.0.113.7';
const SECRET = 'a-test-secret';
const NOW = new Date('2026-08-12T15:20:30.000Z');

/** The env a working endpoint has. Individual tests take pieces away. */
const ENV = {
  MCP_AUDIT_RATE_SECRET: SECRET,
  UPSTASH_REDIS_REST_URL: 'https://store.example',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

/**
 * A fake Upstash that answers a pipeline with the next count for whichever key it was handed, and
 * records every request so a test can assert what was stored.
 */
function fakeStore({ counts = {}, fail = false } = {}) {
  const calls = [];
  const state = { ...counts };
  const fetchImpl = async (url, init) => {
    const commands = JSON.parse(init.body);
    calls.push({ url, commands });
    if (fail) return { ok: false, status: 500, json: async () => [] };
    const key = commands[0][1];
    state[key] = (state[key] ?? 0) + 1;
    return { ok: true, status: 200, json: async () => [{ result: state[key] }, { result: 1 }] };
  };
  return { fetchImpl, calls, state };
}

/** Every key any call in this run wrote to. */
const keysOf = (store) => store.calls.map((call) => call.commands[0][1]);

test('the limits come from the environment, with documented defaults', () => {
  assert.deepEqual(readLimits({}), {
    perCaller: DEFAULT_PER_CALLER,
    windowSeconds: DEFAULT_WINDOW_SECONDS,
    globalPerDay: DEFAULT_GLOBAL_PER_DAY,
  });
  assert.deepEqual(
    readLimits({
      MCP_AUDIT_RATE_PER_CALLER: '3',
      MCP_AUDIT_RATE_WINDOW_SECONDS: '60',
      MCP_AUDIT_RATE_GLOBAL_PER_DAY: '20',
    }),
    { perCaller: 3, windowSeconds: 60, globalPerDay: 20 },
  );
});

test('a malformed limit falls back to its default rather than throwing', () => {
  // A limiter that refuses to start on a typo in a dashboard field is a limiter that gets switched
  // off. Every one of these is a value someone could plausibly paste in.
  for (const bad of ['', 'ten', '0', '-5', 'NaN']) {
    assert.equal(readLimits({ MCP_AUDIT_RATE_PER_CALLER: bad }).perCaller, DEFAULT_PER_CALLER, bad);
  }
});

test('the client address is the first hop of x-forwarded-for', () => {
  // The last entry is Vercel's own edge. Keying on it would put every caller in one bucket, which
  // is a limiter that either blocks everybody or nobody.
  const headers = new Headers({ 'x-forwarded-for': `${IP}, 198.51.100.1, 198.51.100.2` });
  assert.equal(clientIpFrom(headers), IP);
});

test('x-real-ip is the fallback, and no address at all is null', () => {
  assert.equal(clientIpFrom(new Headers({ 'x-real-ip': IP })), IP);
  assert.equal(clientIpFrom(new Headers()), null);
  assert.equal(clientIpFrom(new Headers({ 'x-forwarded-for': '  ' })), null);
});

test('the stored key is the HMAC, and the address does not appear in it', () => {
  const hash = callerHash(IP, SECRET);
  const key = callerKeyFor(hash, windowFor(NOW, DEFAULT_WINDOW_SECONDS).index);
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.ok(!key.includes(IP), key);
  assert.ok(!key.includes('203'), key);
  assert.match(key, /^mcp:v1:caller:[0-9a-f]{32}:\d+$/);
});

test('the same address hashes the same way and a different one does not', () => {
  assert.equal(callerHash(IP, SECRET), callerHash(IP, SECRET));
  assert.notEqual(callerHash(IP, SECRET), callerHash('198.51.100.9', SECRET));
  // A different secret is a different key space, which is what makes rotating the secret a reset.
  assert.notEqual(callerHash(IP, SECRET), callerHash(IP, 'another-secret'));
});

test('the window is derived from the clock alone and its TTL is what is left of it', () => {
  // Epoch-aligned, so nothing about the window has to be stored: the key names it and the TTL is
  // exactly its remaining life.
  const { index, secondsRemaining } = windowFor(NOW, 3600);
  assert.equal(index, Math.floor(Date.UTC(2026, 7, 12, 15, 20, 30) / 1000 / 3600));
  assert.equal(secondsRemaining, 39 * 60 + 30);
  assert.ok(secondsRemaining <= 3600);
});

test('the global window is the UTC day and its TTL ends with the day', () => {
  const { day, secondsRemaining } = utcDayFor(NOW);
  assert.equal(day, '2026-08-12');
  assert.equal(secondsRemaining, 8 * 3600 + 39 * 60 + 30);
  assert.equal(globalKeyFor(day), 'mcp:v1:global:2026-08-12');
});

test('a counter is incremented and given a TTL no longer than its window', () => {
  assert.deepEqual(counterCommands('k', 120), [
    ['INCR', 'k'],
    ['EXPIRE', 'k', '120'],
  ]);
});

test('a caller under the limit passes, and both counters are written', async () => {
  const store = fakeStore();
  const verdict = await checkRateLimit({ ip: IP, env: ENV, now: NOW, fetchImpl: store.fetchImpl });

  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.caller, { used: 1, limit: DEFAULT_PER_CALLER });
  assert.deepEqual(verdict.global, { used: 1, limit: DEFAULT_GLOBAL_PER_DAY });
  assert.deepEqual(keysOf(store), [
    callerKeyFor(callerHash(IP, SECRET), windowFor(NOW, DEFAULT_WINDOW_SECONDS).index),
    'mcp:v1:global:2026-08-12',
  ]);
});

test('a caller over the limit is refused, with the rest of the window as Retry-After', async () => {
  const callerKey = callerKeyFor(callerHash(IP, SECRET), windowFor(NOW, DEFAULT_WINDOW_SECONDS).index);
  const store = fakeStore({ counts: { [callerKey]: DEFAULT_PER_CALLER } });
  const verdict = await checkRateLimit({ ip: IP, env: ENV, now: NOW, fetchImpl: store.fetchImpl });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.scope, 'caller');
  assert.equal(verdict.used, DEFAULT_PER_CALLER + 1);
  assert.equal(verdict.limit, DEFAULT_PER_CALLER);
  assert.equal(verdict.retryAfterSeconds, windowFor(NOW, DEFAULT_WINDOW_SECONDS).secondsRemaining);
});

test('a caller refused by their own limit spends no global budget', async () => {
  // The reason the two limits are two round trips rather than one pipeline. If a refused request
  // still incremented the global counter, one caller in a loop could exhaust the day for everybody.
  const callerKey = callerKeyFor(callerHash(IP, SECRET), windowFor(NOW, DEFAULT_WINDOW_SECONDS).index);
  const store = fakeStore({ counts: { [callerKey]: DEFAULT_PER_CALLER } });
  await checkRateLimit({ ip: IP, env: ENV, now: NOW, fetchImpl: store.fetchImpl });

  assert.deepEqual(keysOf(store), [callerKey]);
  assert.equal(store.state['mcp:v1:global:2026-08-12'], undefined);
});

test('the global limit refuses a caller who is well within their own', async () => {
  const store = fakeStore({ counts: { 'mcp:v1:global:2026-08-12': DEFAULT_GLOBAL_PER_DAY } });
  const verdict = await checkRateLimit({ ip: IP, env: ENV, now: NOW, fetchImpl: store.fetchImpl });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.scope, 'global');
  assert.equal(verdict.retryAfterSeconds, utcDayFor(NOW).secondsRemaining);
});

test('a store that is down refuses the audit rather than admitting it', async () => {
  const store = fakeStore({ fail: true });
  const verdict = await checkRateLimit({ ip: IP, env: ENV, now: NOW, fetchImpl: store.fetchImpl });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.scope, 'store');
  assert.match(verdict.reason, /could not be reached/);
});

test('a store that throws refuses the audit', async () => {
  const verdict = await checkRateLimit({
    ip: IP,
    env: ENV,
    now: NOW,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.scope, 'store');
});

test('a missing secret, a missing store and a missing address all refuse, without a network call', async () => {
  // Fail closed on every configuration gap, and say which. An endpoint that admits everyone while
  // its store is unconfigured is the failure this whole module exists to prevent.
  const never = async () => {
    throw new Error('the limiter must not call the store on a configuration failure');
  };
  const cases = [
    [{ ...ENV, MCP_AUDIT_RATE_SECRET: undefined }, IP, 'config'],
    [{ MCP_AUDIT_RATE_SECRET: SECRET }, IP, 'store'],
    [ENV, null, 'caller-unknown'],
  ];
  for (const [env, ip, scope] of cases) {
    const verdict = await checkRateLimit({ ip, env, now: NOW, fetchImpl: never });
    assert.equal(verdict.allowed, false, scope);
    assert.equal(verdict.scope, scope);
    assert.ok(verdict.retryAfterSeconds > 0, scope);
  }
});

test('the KV_REST_API_* env pair works as well as the UPSTASH_* one', async () => {
  // Both pairs are live on Vercel projects depending on when the integration was provisioned; the
  // read is shared with src/lib/agent-hits.mjs, and this asserts the limiter inherited it.
  const store = fakeStore();
  const verdict = await checkRateLimit({
    ip: IP,
    env: {
      MCP_AUDIT_RATE_SECRET: SECRET,
      KV_REST_API_URL: 'https://store.example',
      KV_REST_API_TOKEN: 'token',
    },
    now: NOW,
    fetchImpl: store.fetchImpl,
  });
  assert.equal(verdict.allowed, true);
});
