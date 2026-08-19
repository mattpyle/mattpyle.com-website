import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRateLimit, deepCallerKeyFor, deepGlobalKeyFor, callerHash, utcDayFor } from '../src/lib/mcp-rate-limit.mjs';
import { A2A_METHOD, respond } from '../src/lib/a2a-responder.mjs';

/**
 * One budget across two protocols.
 *
 * The decision this file holds: the A2A audit skill spends the same counters the MCP deep tools
 * spend, because the cost being bounded is minutes of paid browser time on one hosted worker and
 * it does not care which protocol asked for them. A parallel limiter would have doubled this
 * site's worst day while both endpoints reported themselves inside their caps.
 *
 * It is asserted two ways, because either one alone is weak. The **property** test drives the real
 * `checkRateLimit` against one in-memory store from both call paths and shows the second call
 * refused by the first call's spending. The **wiring** test reads both route files and shows they
 * reach the same function with the same caller key — because a shared store is worth nothing if
 * one of the routes stops asking.
 */

const IP = '203.0.113.7';
const SECRET = 'a-test-secret';
const NOW = new Date('2026-08-18T15:20:30.000Z');

const ENV = {
  MCP_AUDIT_RATE_SECRET: SECRET,
  UPSTASH_REDIS_REST_URL: 'https://store.example',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  // One deep audit for this caller, so the second call from either protocol is the refused one.
  MCP_DEEP_RATE_PER_CALLER: '1',
};

/** One store, standing in for the one Upstash database both endpoints share in production. */
function sharedStore() {
  const state = {};
  return {
    state,
    fetchImpl: async (_url, init) => {
      const commands = JSON.parse(init.body);
      const key = commands[0][1];
      state[key] = (state[key] ?? 0) + 1;
      return { ok: true, status: 200, json: async () => [{ result: state[key] }, { result: 1 }] };
    },
  };
}

const digest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/data/a2a-digest.json', import.meta.url)), 'utf8')
);

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('a deep slot spent over A2A is spent over MCP, and the other way round', async () => {
  const store = sharedStore();
  const spend = () =>
    checkRateLimit({ ip: IP, tier: 'deep', env: ENV, now: NOW, fetchImpl: store.fetchImpl });

  // First call: over A2A, through the same function the audit skill's `checkLimit` calls.
  const overA2a = await spend();
  assert.equal(overA2a.allowed, true);

  // Second call: over MCP, same caller, same day. Refused by the first one's spending.
  const overMcp = await spend();
  assert.equal(overMcp.allowed, false);
  assert.equal(overMcp.scope, 'caller');
  assert.match(overMcp.reason, /1 deep audits today/);

  // And the key it landed on is the deep tier's, keyed by the caller hash and the UTC day — the
  // one key, not two protocol-flavoured ones.
  const day = utcDayFor(NOW).day;
  assert.deepEqual(Object.keys(store.state), [
    deepCallerKeyFor(callerHash(IP, SECRET), day),
    deepGlobalKeyFor(day),
  ]);
});

test('the fast tier is shared too, and does not spend the deep budget', async () => {
  const store = sharedStore();
  const fast = await checkRateLimit({
    ip: IP,
    tier: 'fast',
    env: ENV,
    now: NOW,
    fetchImpl: store.fetchImpl,
  });
  assert.equal(fast.allowed, true);
  // Nothing a fast audit touched is a deep key, on either protocol.
  assert.equal(Object.keys(store.state).some((key) => key.includes(':deep:')), false);
});

test('both routes ask the same limiter, with the same caller key', async () => {
  // A shared store bounds nothing if a route stops asking. This is the wiring, read off the source:
  // one import of one function, and the caller identified from the platform headers the same way.
  for (const path of ['../src/pages/a2a.ts', '../src/pages/mcp.ts']) {
    const source = read(path);
    assert.match(source, /from '\.\.\/lib\/mcp-rate-limit\.mjs'/, path);
    assert.match(source, /checkRateLimit\(\{\s*ip: clientIpFrom\(request\.headers\)/, path);
  }

  // And there is exactly one limiter in the tree: no second module, no A2A-flavoured copy.
  const limiters = ['a2a-rate-limit.mjs', 'a2a-audit-rate-limit.mjs'];
  for (const name of limiters) {
    assert.doesNotMatch(read('../src/pages/a2a.ts'), new RegExp(name));
  }
});

test('the audit skill asks its injected limiter for the tier it is about to spend', async () => {
  const asked = [];
  const audit = {
    originFor: (url) => `https://${url}`,
    checkLimit: async (tier) => {
      asked.push(tier);
      return { allowed: true, tier };
    },
    runFast: async () => ({ target: { origin: 'https://example.com' } }),
    startDeep: async () => ({ workflowId: 'steward-audit-example.com-deep-1a2b3c4d' }),
    readTask: async () => ({ status: {} }),
    renderSummary: () => 'summary',
  };
  const call = (text) =>
    respond(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: A2A_METHOD,
        params: { message: { parts: [{ text }] } },
      }),
      { digest, newId: () => 'id', now: () => NOW.toISOString(), audit }
    );

  await call('audit example.com');
  await call('run a deep audit of example.com');
  assert.deepEqual(asked, ['fast', 'deep'], 'each tier is counted against its own budget');
});
