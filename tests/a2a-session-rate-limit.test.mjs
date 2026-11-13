import assert from 'node:assert/strict';
import test from 'node:test';
import {
  callerHash,
  checkRateLimit,
  DEFAULT_SESSION_GLOBAL_PER_DAY,
  DEFAULT_SESSION_PER_CALLER,
  readSessionLimits,
  sessionCallerKeyFor,
  sessionGlobalKeyFor,
} from '../src/lib/mcp-rate-limit.mjs';

// The session tier: how many audit-consultant sessions strangers may open. Same machinery as the
// deep tier, on its own keys, so a session never spends an audit slot and an audit never spends a
// session.

const IP = '203.0.113.9';
const SECRET = 'a-test-secret';
const NOW = new Date('2026-11-13T15:20:30.000Z');
const DAY = '2026-11-13';
const ENV = {
  MCP_AUDIT_RATE_SECRET: SECRET,
  UPSTASH_REDIS_REST_URL: 'https://store.example',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

function fakeStore() {
  const calls = [];
  const state = {};
  const fetchImpl = async (_url, init) => {
    const commands = JSON.parse(init.body);
    calls.push(commands);
    const key = commands[0][1];
    state[key] = (state[key] ?? 0) + 1;
    return { ok: true, status: 200, json: async () => [{ result: state[key] }, { result: 1 }] };
  };
  return { fetchImpl, calls, state };
}

const session = (store, extra = {}) =>
  checkRateLimit({ ip: IP, tier: 'session', env: { ...ENV, ...extra }, now: NOW, fetchImpl: store.fetchImpl });

test('the session limits come from the environment, defaulting to 3 per caller and 20 in total', () => {
  assert.equal(DEFAULT_SESSION_PER_CALLER, 3);
  assert.equal(DEFAULT_SESSION_GLOBAL_PER_DAY, 20);
  assert.deepEqual(readSessionLimits({}), { perCaller: 3, globalPerDay: 20 });
  assert.deepEqual(
    readSessionLimits({ A2A_SESSION_RATE_PER_CALLER: '5', A2A_SESSION_RATE_GLOBAL_PER_DAY: '40' }),
    { perCaller: 5, globalPerDay: 40 }
  );
  assert.deepEqual(readSessionLimits({ A2A_SESSION_RATE_PER_CALLER: 'lots' }), { perCaller: 3, globalPerDay: 20 });
});

test('a session spends only session keys, both per UTC day', async () => {
  const store = fakeStore();
  const verdict = await session(store);
  assert.equal(verdict.allowed, true);
  const hash = callerHash(IP, SECRET);
  assert.deepEqual(store.calls.map((c) => c[0][1]), [sessionCallerKeyFor(hash, DAY), sessionGlobalKeyFor(DAY)]);
  assert.equal(sessionCallerKeyFor(hash, DAY), `mcp:v1:session:caller:${hash}:${DAY}`);
  for (const commands of store.calls) assert.ok(!commands[0][1].includes(IP));
});

test('the fourth session from one caller is refused before the global counter moves', async () => {
  const store = fakeStore();
  for (let i = 0; i < 3; i++) assert.equal((await session(store)).allowed, true);
  const refused = await session(store);
  assert.equal(refused.allowed, false);
  assert.equal(refused.scope, 'caller');
  assert.match(refused.reason, /3 consultant sessions today/);
  assert.equal(store.state[sessionGlobalKeyFor(DAY)], 3);
});

test('the global session cap refuses everyone once spent', async () => {
  const store = fakeStore();
  store.state[sessionGlobalKeyFor(DAY)] = 20;
  const refused = await session(store);
  assert.equal(refused.allowed, false);
  assert.equal(refused.scope, 'global');
});

test('a session tier with no secret or store fails closed', async () => {
  const store = fakeStore();
  assert.equal((await session(store, { MCP_AUDIT_RATE_SECRET: '' })).scope, 'config');
  assert.equal((await checkRateLimit({ ip: IP, tier: 'session', env: { MCP_AUDIT_RATE_SECRET: SECRET }, now: NOW })).scope, 'store');
  assert.equal(store.calls.length, 0);
});
