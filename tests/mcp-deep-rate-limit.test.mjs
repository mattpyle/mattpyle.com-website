import assert from 'node:assert/strict';
import test from 'node:test';
import {
  callerHash,
  checkRateLimit,
  DEFAULT_DEEP_GLOBAL_PER_DAY,
  DEFAULT_DEEP_PER_CALLER,
  deepCallerKeyFor,
  deepGlobalKeyFor,
  readDeepLimits,
  utcDayFor,
} from '../src/lib/mcp-rate-limit.mjs';

// The deep tier's limits. Same machinery as the fast tier's and a separate key space, and these
// tests exist for the three properties that separation is for:
//
//   1. A deep call spends only deep budget, so one deep audit cannot lock a caller out of the
//      cheap tier and a fast audit cannot consume a deep slot.
//   2. Both deep counters are the UTC day, so the cap that bounds a daily bill cannot be spent
//      twice inside one day by waiting out an hourly window.
//   3. It fails closed exactly as the fast limiter does — a deep audit that cannot be counted is a
//      workflow that is never started, and that is the difference between a bounded bill and an
//      unbounded one.

const IP = '203.0.113.7';
const SECRET = 'a-test-secret';
const NOW = new Date('2026-08-15T15:20:30.000Z');
const DAY = '2026-08-15';

const ENV = {
  MCP_AUDIT_RATE_SECRET: SECRET,
  UPSTASH_REDIS_REST_URL: 'https://store.example',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

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

const keysOf = (store) => store.calls.map((call) => call.commands[0][1]);
const deep = (extra = {}) => ({ ip: IP, tier: 'deep', env: { ...ENV, ...extra }, now: NOW });

test('the deep limits come from the environment, with documented defaults', () => {
  assert.deepEqual(readDeepLimits({}), {
    perCaller: DEFAULT_DEEP_PER_CALLER,
    globalPerDay: DEFAULT_DEEP_GLOBAL_PER_DAY,
  });
  assert.deepEqual(
    readDeepLimits({ MCP_DEEP_RATE_PER_CALLER: '5', MCP_DEEP_RATE_GLOBAL_PER_DAY: '25' }),
    { perCaller: 5, globalPerDay: 25 },
  );
});

test('a malformed deep limit falls back to its default rather than throwing', () => {
  for (const bad of ['', 'two', '0', '-1', 'NaN']) {
    assert.equal(
      readDeepLimits({ MCP_DEEP_RATE_PER_CALLER: bad }).perCaller,
      DEFAULT_DEEP_PER_CALLER,
      bad,
    );
  }
});

test('a deep audit is counted in its own key space, keyed by the UTC day', async () => {
  const store = fakeStore();
  const verdict = await checkRateLimit({ ...deep(), fetchImpl: store.fetchImpl });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.tier, 'deep');
  assert.deepEqual(keysOf(store), [
    deepCallerKeyFor(callerHash(IP, SECRET), DAY),
    deepGlobalKeyFor(DAY),
  ]);
  // Never the address itself, in either key. The fast tier's property, held here too.
  for (const key of keysOf(store)) assert.ok(!key.includes(IP), key);
});

test('the two tiers never spend each other budget', async () => {
  const store = fakeStore();
  await checkRateLimit({ ip: IP, tier: 'fast', env: ENV, now: NOW, fetchImpl: store.fetchImpl });
  await checkRateLimit({ ...deep(), fetchImpl: store.fetchImpl });

  const written = keysOf(store);
  const deepKeys = written.filter((key) => key.includes(':deep:'));
  const fastKeys = written.filter((key) => !key.includes(':deep:'));
  assert.equal(deepKeys.length, 2);
  assert.equal(fastKeys.length, 2);
  // Four distinct counters, not two shared ones with different ceilings.
  assert.equal(new Set(written).size, 4);
});

test('the third deep audit of a UTC day from one caller is refused', async () => {
  const callerKey = deepCallerKeyFor(callerHash(IP, SECRET), DAY);
  const store = fakeStore({ counts: { [callerKey]: DEFAULT_DEEP_PER_CALLER } });

  const verdict = await checkRateLimit({ ...deep(), fetchImpl: store.fetchImpl });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.scope, 'caller');
  assert.equal(verdict.limit, DEFAULT_DEEP_PER_CALLER);
  assert.match(verdict.reason, /deep audits/);
  // The refusal costs no global budget: the caller check runs first and the global counter is only
  // touched by a request that passed it.
  assert.deepEqual(keysOf(store), [callerKey]);
  // Retry-After is the rest of the UTC day, not an hour.
  assert.equal(verdict.retryAfterSeconds, utcDayFor(NOW).secondsRemaining);
});

test('the global deep cap refuses everyone past it', async () => {
  const store = fakeStore({ counts: { [deepGlobalKeyFor(DAY)]: DEFAULT_DEEP_GLOBAL_PER_DAY } });

  const verdict = await checkRateLimit({ ...deep(), fetchImpl: store.fetchImpl });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.scope, 'global');
  assert.equal(verdict.limit, DEFAULT_DEEP_GLOBAL_PER_DAY);
});

test('a deep audit that cannot be counted is refused, not admitted', async () => {
  // The whole posture, on the tier where it costs the most: an uncounted deep audit is minutes of
  // paid worker time nobody bounded.
  const unreachable = fakeStore({ fail: true });
  const down = await checkRateLimit({ ...deep(), fetchImpl: unreachable.fetchImpl });
  assert.equal(down.allowed, false);
  assert.equal(down.scope, 'store');

  const noSecret = await checkRateLimit({
    ip: IP,
    tier: 'deep',
    env: { ...ENV, MCP_AUDIT_RATE_SECRET: undefined },
    now: NOW,
    fetchImpl: fakeStore().fetchImpl,
  });
  assert.equal(noSecret.allowed, false);
  assert.equal(noSecret.scope, 'config');

  const noStore = await checkRateLimit({
    ip: IP,
    tier: 'deep',
    env: { MCP_AUDIT_RATE_SECRET: SECRET },
    now: NOW,
    fetchImpl: fakeStore().fetchImpl,
  });
  assert.equal(noStore.allowed, false);
  assert.equal(noStore.scope, 'store');

  const noAddress = await checkRateLimit({ ...deep(), ip: null, fetchImpl: fakeStore().fetchImpl });
  assert.equal(noAddress.allowed, false);
  assert.equal(noAddress.scope, 'caller-unknown');

  // Every refusal names the tier, so a 429 in the logs says which budget was involved.
  for (const verdict of [down, noSecret, noStore, noAddress]) assert.equal(verdict.tier, 'deep');
});
