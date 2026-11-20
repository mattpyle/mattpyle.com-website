import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  checkRateLimit,
  DEFAULT_READ_PER_CALLER,
  DEFAULT_READ_WINDOW_SECONDS,
  readCallerKeyFor,
  readReadLimits,
} from '../src/lib/mcp-rate-limit.mjs';
import {
  createAuditServer,
  DEEP_TOOL_NAME,
  GET_AUDIT_OUTPUT_SHAPE,
  GET_AUDIT_TOOL_NAME,
  STATUS_POLL_SECONDS,
  tierFor,
  TOOL_NAME,
} from '../src/lib/mcp-audit-server.mjs';
import { A2A_METHOD, respond } from '../src/lib/a2a-responder.mjs';
import { consultantTaskIdFor, consultantTurnTaskId } from '../src/lib/consultant-task-id.mjs';

// The read tier: the bound on reads of a run, which spend no audit allowance. These tests hold what
// makes it different from the three tiers that count work:
//
//   1. Per caller only. There is no global key, so one caller cannot lock another out of reading
//      their own report, and a read is one store request whether it is allowed or refused.
//   2. Its own key space. A read spends no fast, deep or session budget, and a refused read writes
//      to no other tier's key.
//   3. It fails open. A read that cannot be counted is allowed, while an audit that cannot be
//      counted is still refused.
//   4. It charges the MCP `get_audit` tool and the A2A `GetTask` method, and only where the read is
//      about to reach Temporal. `CancelTask` is not charged.

const IP = '203.0.113.7';
const HASH = '5689b2211a4a900895af69e079f77c7e';
const SECRET = 'a-test-secret';
// 15:20:30 UTC. Minute 29780120 since the epoch, with 30 seconds of it left.
const NOW = new Date('2026-08-15T15:20:30.000Z');
const NEXT_MINUTE = new Date('2026-08-15T15:21:00.000Z');
const READ_KEY = `mcp:v1:read:caller:${HASH}:29780120`;

const ENV = {
  MCP_AUDIT_RATE_SECRET: SECRET,
  UPSTASH_REDIS_REST_URL: 'https://store.example',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

/** One in-memory store, counting per key and recording every request. */
function fakeStore({ fail = false } = {}) {
  const calls = [];
  const state = {};
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

const check = (store, input = {}) =>
  checkRateLimit({ ip: IP, tier: 'read', env: ENV, now: NOW, fetchImpl: store.fetchImpl, ...input });

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------------------------
// The limiter
// ---------------------------------------------------------------------------------------------

test('the read limits come from the environment, with documented defaults', () => {
  assert.equal(DEFAULT_READ_PER_CALLER, 60);
  assert.equal(DEFAULT_READ_WINDOW_SECONDS, 60);
  assert.deepEqual(readReadLimits({}), { perCaller: 60, windowSeconds: 60 });
  assert.deepEqual(
    readReadLimits({ MCP_READ_RATE_PER_CALLER: '120', MCP_READ_RATE_WINDOW_SECONDS: '30' }),
    { perCaller: 120, windowSeconds: 30 }
  );
});

test('a malformed read limit falls back to its default rather than throwing', () => {
  for (const bad of ['', 'sixty', '0', '-1', 'NaN']) {
    assert.deepEqual(
      readReadLimits({ MCP_READ_RATE_PER_CALLER: bad, MCP_READ_RATE_WINDOW_SECONDS: bad }),
      { perCaller: 60, windowSeconds: 60 },
      bad
    );
  }
});

test('an allowed read is one store request, on the read key, expiring with its window', async () => {
  const store = fakeStore();
  const verdict = await check(store);

  assert.deepEqual(verdict, { allowed: true, tier: 'read', caller: { used: 1, limit: 60 } });
  assert.deepEqual(store.calls, [
    {
      url: 'https://store.example/pipeline',
      commands: [
        ['INCR', READ_KEY],
        ['EXPIRE', READ_KEY, '30'],
      ],
    },
  ]);
  assert.equal(readCallerKeyFor(HASH, 29780120), READ_KEY);
  // The key holds the keyed hash and never the address.
  assert.equal(READ_KEY.includes(IP), false);
});

test('the TTL is never longer than the window', async () => {
  for (const [at, ttl] of [
    ['2026-08-15T15:20:00.000Z', '60'],
    ['2026-08-15T15:20:59.000Z', '1'],
  ]) {
    const store = fakeStore();
    await check(store, { now: new Date(at) });
    assert.equal(store.calls[0].commands[1][2], ttl, at);
  }
});

test('the 61st read in a window is refused, and the next window allows again', async () => {
  const store = fakeStore();
  for (let i = 1; i <= 60; i += 1) {
    const verdict = await check(store);
    assert.equal(verdict.allowed, true, `read ${i}`);
  }

  const refused = await check(store);
  assert.deepEqual(refused, {
    allowed: false,
    tier: 'read',
    scope: 'caller',
    reason: 'this caller is reading too fast',
    retryAfterSeconds: 30,
    used: 61,
    limit: 60,
  });
  // Refused on one store request, like every read before it.
  assert.equal(store.calls.length, 61);

  const later = await check(store, { now: NEXT_MINUTE });
  assert.deepEqual(later, { allowed: true, tier: 'read', caller: { used: 1, limit: 60 } });
});

test('the read tier has no global key, and a refused read touches no other tier', async () => {
  const store = fakeStore();
  for (let i = 0; i < 65; i += 1) await check(store);

  // Sixty-five reads, five of them refused, and the store holds one key.
  assert.deepEqual(Object.keys(store.state), [READ_KEY]);
  assert.equal(store.calls.every((call) => call.commands[0][1] === READ_KEY), true);
});

test('another caller reads freely while one caller is refused', async () => {
  const store = fakeStore();
  for (let i = 0; i < 61; i += 1) await check(store);
  assert.equal((await check(store)).allowed, false);

  const other = await check(store, { ip: '198.51.100.9' });
  assert.deepEqual(other, { allowed: true, tier: 'read', caller: { used: 1, limit: 60 } });
});

test('reads do not spend the fast tier, and audits do not spend reads', async () => {
  const store = fakeStore();
  for (let i = 0; i < 61; i += 1) await check(store);

  // A caller who is reading too fast can still run an audit, on a full fast allowance.
  const fast = await check(store, { tier: 'fast' });
  assert.equal(fast.allowed, true);
  assert.deepEqual(fast.caller, { used: 1, limit: 10 });
  assert.deepEqual(fast.global, { used: 1, limit: 500 });

  // And the audit wrote nothing to the read key.
  assert.equal(store.state[READ_KEY], 61);
});

test('a store error allows a read and refuses a fast audit', async () => {
  const store = fakeStore({ fail: true });

  const reading = await check(store);
  assert.deepEqual(reading, {
    allowed: true,
    tier: 'read',
    counted: false,
    scope: 'store',
    reason: 'the rate-limit store could not be reached: Error',
  });

  for (const tier of ['fast', 'deep', 'session']) {
    const verdict = await check(store, { tier });
    assert.equal(verdict.allowed, false, tier);
    assert.equal(verdict.scope, 'store', tier);
  }
});

test('a store that throws, and a store that answers nonsense, also allow a read', async () => {
  const throwing = { fetchImpl: async () => { throw new TypeError('fetch failed'); } };
  assert.equal((await check(throwing)).allowed, true);
  assert.equal((await check(throwing)).counted, false);

  const nonsense = { fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ result: 'many' }] }) };
  assert.equal((await check(nonsense)).allowed, true);
  assert.equal((await check(nonsense, { tier: 'fast' })).allowed, false);
});

test('a missing secret, store or address allows a read, and still refuses an audit', async () => {
  const cases = [
    ['config', { env: { ...ENV, MCP_AUDIT_RATE_SECRET: undefined } }],
    ['store', { env: { MCP_AUDIT_RATE_SECRET: SECRET } }],
    ['caller-unknown', { ip: null }],
  ];
  for (const [scope, input] of cases) {
    const store = fakeStore();
    const reading = await check(store, input);
    assert.equal(reading.allowed, true, scope);
    assert.equal(reading.counted, false, scope);
    assert.equal(reading.scope, scope);

    const audit = await check(store, { ...input, tier: 'fast' });
    assert.equal(audit.allowed, false, scope);
    assert.equal(audit.scope, scope);
    assert.equal(store.calls.length, 0, 'neither reached the store');
  }
});

test('a read still counts, and is still refused, when the store works', async () => {
  // Failing open is about a store that cannot answer. A store that answers "61" is a refusal.
  const store = { fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ result: 61 }, { result: 1 }] }) };
  const verdict = await check(store);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.scope, 'caller');
});

test('a slow store holds a read for about half a second, then the read goes ahead', async () => {
  // The store never answers. It ends only when the request's own timeout aborts it.
  const hanging = {
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
  };
  const started = Date.now();
  const verdict = await check(hanging);
  const waited = Date.now() - started;

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.counted, false);
  assert.ok(waited >= 400, `waited ${waited} ms`);
  assert.ok(waited < 1400, `waited ${waited} ms, which is the other tiers' timeout`);
});

// ---------------------------------------------------------------------------------------------
// /mcp: which calls are counted
// ---------------------------------------------------------------------------------------------

const AUDIT_ID = 'steward-audit-example.com-deep-1a2b3c4d';
const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('tierFor maps each method to the budget it spends', () => {
  // Handshakes and notifications spend nothing.
  for (const method of ['initialize', 'tools/list', 'ping', 'notifications/initialized', 'server/discover']) {
    assert.equal(tierFor({ jsonrpc: '2.0', id: 1, method }), null, method);
  }
  assert.equal(tierFor(call(TOOL_NAME, { url: 'example.com' })), 'fast');
  assert.equal(tierFor(call(DEEP_TOOL_NAME, { url: 'example.com' })), 'deep');
  // An unknown tool is still counted as a fast audit.
  assert.equal(tierFor(call('no_such_tool', {})), 'fast');
  // Not a request object at all.
  for (const body of [null, undefined, 'tools/call', 7]) assert.equal(tierFor(body), null);
});

test('get_audit is counted as a read on every view', () => {
  assert.equal(tierFor(call(GET_AUDIT_TOOL_NAME, { workflowId: AUDIT_ID })), 'read');
  for (const view of ['status', 'report', 'summary']) {
    assert.equal(tierFor(call(GET_AUDIT_TOOL_NAME, { workflowId: AUDIT_ID, view })), 'read', view);
  }
});

test('get_audit with an id that is not an audit id reaches no Temporal call, and is not counted', () => {
  for (const args of [{}, { workflowId: '' }, { workflowId: 'wf-1' }, { workflowId: 7 }, { workflowId: `${AUDIT_ID}/..` }]) {
    assert.equal(tierFor(call(GET_AUDIT_TOOL_NAME, args)), null, JSON.stringify(args));
  }
  assert.equal(tierFor({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: GET_AUDIT_TOOL_NAME } }), null);
});

test('the /mcp route asks tierFor, and answers a refused read in its usual 429 shape', () => {
  const source = read('../src/pages/mcp.ts');
  assert.match(source, /\btierFor,\n[\s\S]*from '\.\.\/lib\/mcp-audit-server\.mjs'/, 'tierFor is the shared one');
  assert.doesNotMatch(source, /function tierFor/, 'and the route keeps no copy of it');
  assert.match(source, /const tier = tierFor\(body\);\s+if \(tier\) \{\s+const verdict = await checkRateLimit\(\{ ip: clientIpFrom\(request\.headers\), tier \}\)/);
  // One refusal path for every tier: the tier named in `data`, the header, the status.
  assert.match(source, /data: \{\s+tier,\s+scope: verdict\.scope,\s+retryAfterSeconds: verdict\.retryAfterSeconds,/);
  assert.match(source, /'Retry-After': String\(verdict\.retryAfterSeconds\)/);
  assert.match(source, /message: `Rate limited: \$\{verdict\.reason\}\. Try again in \$\{verdict\.retryAfterSeconds\} seconds\.`/);
});

// ---------------------------------------------------------------------------------------------
// /mcp: the polling hint
// ---------------------------------------------------------------------------------------------

function connect(readView) {
  const server = createAuditServer({
    runAudit: async () => ({}),
    renderSummary: () => '# Audit',
    normaliseTarget: (input) => ({ origin: `https://${input}`, url: new URL(`https://${input}`) }),
    version: '9.9.9',
    userAgent: 'test-audit/9.9.9',
    deep: { startAudit: async () => ({ workflowId: AUDIT_ID }), readView },
  });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return Promise.all([client.connect(clientTransport), server.connect(serverTransport)]).then(() => ({
    client,
    close: () => Promise.all([client.close(), server.close()]),
  }));
}

const document = (fields) => `${JSON.stringify(fields, null, 2)}\n`;
const RUNNING = { workflowId: AUDIT_ID, url: 'example.com', tier: 'deep', execution: 'RUNNING', done: false, succeeded: false, queued: false };
const FINISHED = { ...RUNNING, execution: 'COMPLETED', done: true, succeeded: true };

test('the status of a running audit says how long to wait before the next read', async (t) => {
  const { client, close } = await connect(async () => document(RUNNING));
  t.after(close);

  const result = await client.callTool({ name: GET_AUDIT_TOOL_NAME, arguments: { workflowId: AUDIT_ID } });
  assert.equal(STATUS_POLL_SECONDS, 5);
  assert.equal(result.structuredContent.pollAfterSeconds, 5);
  // One document, two renderings: the text is the same object.
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.deepEqual(result.structuredContent, { ...RUNNING, pollAfterSeconds: 5 });
  assert.equal(GET_AUDIT_OUTPUT_SHAPE.safeParse(result.structuredContent).success, true);
});

test('a finished audit, and the other two views, carry no polling hint', async (t) => {
  const { client, close } = await connect(async (_id, view) =>
    view === 'status' ? document(FINISHED) : view === 'report' ? document({ done: false, checks: [] }) : '# Audit\n'
  );
  t.after(close);

  const status = await client.callTool({ name: GET_AUDIT_TOOL_NAME, arguments: { workflowId: AUDIT_ID } });
  assert.deepEqual(status.structuredContent, FINISHED);
  assert.equal(status.content[0].text, document(FINISHED));

  // A report is not a status, whatever fields it happens to carry.
  const report = await client.callTool({ name: GET_AUDIT_TOOL_NAME, arguments: { workflowId: AUDIT_ID, view: 'report' } });
  assert.equal('pollAfterSeconds' in report.structuredContent, false);
  const summary = await client.callTool({ name: GET_AUDIT_TOOL_NAME, arguments: { workflowId: AUDIT_ID, view: 'summary' } });
  assert.deepEqual(summary.structuredContent, { view: 'summary', markdown: '# Audit\n' });
});

test('the get_audit description names the interval', async (t) => {
  const { client, close } = await connect(async () => document(RUNNING));
  t.after(close);
  const { tools } = await client.listTools();
  const tool = tools.find((entry) => entry.name === GET_AUDIT_TOOL_NAME);
  assert.match(tool.description, /waiting "pollAfterSeconds" \(5 seconds\) between reads/);
  assert.ok(tool.outputSchema.properties.pollAfterSeconds, 'and the schema declares the field');
});

// ---------------------------------------------------------------------------------------------
// /a2a: which calls are counted
// ---------------------------------------------------------------------------------------------

const SESSION_ID = consultantTaskIdFor('0f8fad5b-d9cb-469f-a165-70867728950e');
const TURN_ID = consultantTurnTaskId(SESSION_ID, 1);

const REFUSED = {
  allowed: false,
  tier: 'read',
  scope: 'caller',
  reason: 'this caller is reading too fast',
  retryAfterSeconds: 23,
  used: 61,
  limit: 60,
};

/** An /a2a context with both engines faked, recording what reached the limiter and the engines. */
function a2a({ verdict = { allowed: true, tier: 'read' }, audit = true, consultant = true, checkRead = true } = {}) {
  const asked = [];
  const reached = [];
  const reading = {
    execution: 'RUNNING',
    status: { current_turn: 1, turn_active: false, pending_turns: [], pending_callbacks: [], pending_approvals: [], close_reason: null },
    session: { turns: 1, ended: null, lastReply: { turn: 1, text: 'The answer.' }, replies: [{ turn: 1, text: 'The answer.' }] },
  };
  const context = {
    digest: {},
    newId: () => 'id',
    now: () => NOW.toISOString(),
    ...(checkRead ? { checkRead: async () => (asked.push('read'), verdict) } : {}),
    ...(audit
      ? {
          audit: {
            checkLimit: async (tier) => (asked.push(tier), { allowed: true, tier }),
            readTask: async (id) => (reached.push(['readTask', id]), { status: { ...RUNNING, phase: 'rendering', note: 'working' } }),
            renderSummary: () => 'summary',
          },
        }
      : {}),
    ...(consultant
      ? {
          consultant: {
            checkLimit: async () => (asked.push('session'), { allowed: true }),
            engine: {
              read: async (id) => (reached.push(['read', id]), reading),
              close: async (id) => reached.push(['close', id]),
            },
          },
        }
      : {}),
  };
  const send = (method, params) => respond(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), context);
  return { asked, reached, send };
}

test('GetTask on an audit and on a consultant session are each counted as one read', async () => {
  for (const [method, id, engineCall] of [
    ['GetTask', AUDIT_ID, 'readTask'],
    ['tasks/get', AUDIT_ID, 'readTask'],
    ['GetTask', TURN_ID, 'read'],
    ['GetTask', SESSION_ID, 'read'],
    ['tasks/get', TURN_ID, 'read'],
  ]) {
    const { asked, reached, send } = a2a();
    const result = await send(method, { id });
    assert.deepEqual(asked, ['read'], `${method} ${id}`);
    assert.equal(reached[0][0], engineCall, `${method} ${id}`);
    assert.equal(result.payload.error, undefined, `${method} ${id}`);
  }
});

test('a refused read is answered in the ErrorInfo shape, and reaches no engine', async () => {
  for (const [method, id] of [
    ['GetTask', AUDIT_ID],
    ['GetTask', TURN_ID],
    ['tasks/get', AUDIT_ID],
  ]) {
    const { reached, send } = a2a({ verdict: REFUSED });
    const result = await send(method, { id });

    assert.equal(result.status, 200, 'a JSON-RPC error rides a 200 on this endpoint');
    assert.match(result.outcome, /rate-limited\/read\/caller$/);
    assert.deepEqual(result.payload, {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32000,
        message: 'Rate limited: this caller is reading too fast. Try again in 23 seconds.',
        data: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMITED',
            domain: result.payload.error.data[0].domain,
            metadata: { tier: 'read', scope: 'caller', retryAfterSeconds: '23', limit: '60' },
          },
        ],
      },
    });
    assert.deepEqual(reached, [], `${method} ${id}`);
  }
});

test('CancelTask is not counted, and reaches its handler when the caller is over the read limit', async () => {
  for (const method of ['CancelTask', 'tasks/cancel']) {
    const { asked, reached, send } = a2a({ verdict: REFUSED });
    const result = await send(method, { id: TURN_ID });

    assert.deepEqual(asked, [], method);
    assert.deepEqual(reached, [['read', SESSION_ID], ['close', SESSION_ID]], method);
    assert.match(result.outcome, /ok\/consultant-cancel$/, method);
    assert.equal(result.payload.error, undefined, method);
  }
});

test('a GetTask that makes no Temporal call is not counted', async () => {
  // A missing id, an id of neither kind, and an id whose engine this deployment does not have.
  const cases = [
    [{}, {}],
    [{ id: '' }, {}],
    [{ id: 'not-a-task' }, {}],
    [{ id: 'a2a-consultant-nope' }, {}],
    [{ id: AUDIT_ID }, { audit: false }],
    [{ id: TURN_ID }, { consultant: false }],
  ];
  for (const [params, options] of cases) {
    const { asked, reached, send } = a2a({ verdict: REFUSED, ...options });
    const result = await send('GetTask', params);
    const label = JSON.stringify([params, options]);
    assert.deepEqual(asked, [], label);
    assert.deepEqual(reached, [], label);
    assert.ok(result.payload.error, label);
    assert.notEqual(result.payload.error.code, -32000, label);
  }
});

test('SendMessage is not counted as a read, on any skill', async () => {
  const digest = JSON.parse(read('../src/data/a2a-digest.json'));
  const asked = [];
  const context = {
    digest,
    newId: () => 'id',
    now: () => NOW.toISOString(),
    checkRead: async () => (asked.push('read'), REFUSED),
  };
  const result = await respond(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: A2A_METHOD,
      params: { message: { parts: [{ text: 'what is this site?' }] }, metadata: { skill: 'ask-about-site' } },
    }),
    context
  );
  assert.deepEqual(asked, []);
  assert.equal(result.payload.error, undefined);
});

test('a responder given no read limiter counts nothing, and still answers', async () => {
  const { asked, reached, send } = a2a({ checkRead: false });
  const result = await send('GetTask', { id: AUDIT_ID });
  assert.deepEqual(asked, []);
  assert.deepEqual(reached, [['readTask', AUDIT_ID]]);
  assert.equal(result.payload.error, undefined);
});

test('the /a2a route passes the read limiter, from the same function and the same caller key', () => {
  const source = read('../src/pages/a2a.ts');
  assert.match(
    source,
    /checkRead: async \(\) => \{\s+const verdict = await checkRateLimit\(\{ ip: clientIpFrom\(request\.headers\), tier: 'read' \}\);[\s\S]*?return verdict;\s+\},/
  );
  // Passed to the responder itself, beside the two engines, not inside one of them.
  assert.match(source, /respondOrStream\(raw, \{[\s\S]*?\n    checkRead: async/);
});

// ---------------------------------------------------------------------------------------------
// What stays as it was
// ---------------------------------------------------------------------------------------------

test('the /steward limits table does not list the read tier', () => {
  const page = read('../src/pages/steward.astro');
  assert.doesNotMatch(page, /readReadLimits|DEFAULT_READ_|tier: 'Read/);
  assert.equal((page.match(/\{ tier: '/g) ?? []).length, 6, 'six rows: fast, deep and session, twice each');
});

test('the consultant skill waits for a reply without asking the read limiter', () => {
  // Its wait loop reads the session through the engine it was handed. It has no limiter to ask but
  // the session tier's `checkLimit`, which is charged once, when a session starts.
  const skill = read('../src/lib/a2a-consultant-skill.mjs');
  assert.doesNotMatch(skill, /checkRead/);
});
