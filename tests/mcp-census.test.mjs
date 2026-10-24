import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MAX_MCP_CLIENTS_PER_DAY,
  MAX_MCP_VERSIONS_PER_DAY,
  MCP_ENDPOINT_PATH,
  MCP_METHODS,
  OTHER_MCP_CLIENT,
  OTHER_MCP_METHOD,
  OTHER_MCP_VERSION,
  UNNAMED_MCP_CLIENT,
  UNSTATED_MCP_VERSION,
  cleanMcpClientName,
  cleanMcpProtocolVersion,
  counterPath,
  mcpCensusKeys,
  mcpClientField,
  mcpFactsFrom,
  mcpKeyFor,
  mcpNamedFrom,
  parseMcpField,
  recordMcpRequest,
} from '../src/lib/agent-hits.mjs';
import { bucketHour, flattenMcpHashes, summarizeMcp } from '../src/lib/agent-traffic.mjs';
import {
  MCP_CLIENTS_LEGEND,
  MCP_COUNTS_NOTE,
  MCP_METHODS_LEGEND,
  buildActivity,
} from '../src/lib/activity-summary.mjs';

// The MCP client census: every POST to /mcp counted by JSON-RPC method, and every initialize by the
// client name and protocol revision it gives. The store is a fake that records what it was asked,
// so nothing here touches a network.

const AT = new Date('2026-10-23T20:00:00Z');
const NOW = new Date('2026-10-23T20:30:00Z');

const STORE_ENV = {
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

const KEY = 'hits:v2:mcp:2026-10-23';

function initialize(name, protocolVersion, extra = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name, version: '1.2.3' }, ...extra },
  };
}

/**
 * A store whose MCP hash for the day already names these fields. Answers HKEYS with them and every
 * other pipeline with a bare OK, recording each one.
 */
function storeNaming(fields, { hkeys = 'answer' } = {}) {
  const calls = [];
  const impl = async (_url, init) => {
    const commands = JSON.parse(init.body);
    calls.push(commands);
    if (commands[0][0] === 'HKEYS') {
      if (hkeys === 'fail') throw new Error('ECONNRESET');
      if (hkeys === '500') return { ok: false, status: 500 };
      return new Response(JSON.stringify([{ result: fields }]), { status: 200 });
    }
    return { ok: true, status: 200 };
  };
  impl.calls = calls;
  return impl;
}

const routeSource = readFileSync(fileURLToPath(new URL('../src/pages/mcp.ts', import.meta.url)), 'utf8');
const bodySource = readFileSync(
  fileURLToPath(new URL('../src/components/activity/ActivityBody.astro', import.meta.url)),
  'utf8'
);
const jsonSource = readFileSync(fileURLToPath(new URL('../src/pages/activity.json.ts', import.meta.url)), 'utf8');
const markdownSource = readFileSync(fileURLToPath(new URL('../src/pages/activity.md.ts', import.meta.url)), 'utf8');

// --- the facts a body gives -------------------------------------------------------------------

test('the four named methods keep their name and every other request is other-method', () => {
  for (const method of MCP_METHODS) {
    assert.equal(mcpFactsFrom({ jsonrpc: '2.0', id: 1, method }).method, method);
  }
  for (const body of [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'Tools/Call' },
    { jsonrpc: '2.0', id: 4, method: 7 },
    { jsonrpc: '2.0', id: 5 },
    [{ jsonrpc: '2.0', id: 6, method: 'tools/call' }],
    [],
    'nonsense',
    42,
    null,
    true,
    undefined,
  ]) {
    assert.equal(mcpFactsFrom(body).method, OTHER_MCP_METHOD, JSON.stringify(body));
  }
});

/** A request of the 2026-07-28 revision: no handshake, the client in the `_meta` envelope. */
function enveloped(method, { name, protocolVersion = '2026-07-28', params = {}, meta = {} } = {}) {
  return {
    jsonrpc: '2.0',
    id: 2,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
        ...(name === undefined ? {} : { 'io.modelcontextprotocol/clientInfo': { name, version: '4.5.6' } }),
        'io.modelcontextprotocol/clientCapabilities': {},
        ...meta,
      },
    },
  };
}

test('a request with the 2026-07-28 envelope carries a client and a revision on any method', () => {
  for (const method of ['tools/call', 'tools/list', 'server/discover', 'subscriptions/listen']) {
    const expected = MCP_METHODS.includes(method) ? method : OTHER_MCP_METHOD;
    assert.deepEqual(
      mcpFactsFrom(enveloped(method, { name: 'Claude-AI' })),
      { method: expected, clientName: 'claude-ai', protocolVersion: '2026-07-28' },
      method
    );
  }
});

test('the envelope gives a name or a revision or both, and the missing half says so', () => {
  // clientInfo is optional in the 2026-07-28 revision, so a request with a revision and no name is
  // a client that did not identify itself, the same finding an initialize with no name is.
  assert.deepEqual(mcpFactsFrom(enveloped('tools/list')), {
    method: 'tools/list',
    clientName: UNNAMED_MCP_CLIENT,
    protocolVersion: '2026-07-28',
  });
  assert.deepEqual(
    mcpFactsFrom({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'Solo' } } } }),
    { method: 'tools/list', clientName: 'solo', protocolVersion: UNSTATED_MCP_VERSION }
  );
  assert.deepEqual(mcpFactsFrom(enveloped('tools/list', { name: 7, protocolVersion: 20260728 })), {
    method: 'tools/list',
    clientName: UNNAMED_MCP_CLIENT,
    protocolVersion: UNSTATED_MCP_VERSION,
  });
});

test('a request without the envelope keys, or with a malformed _meta, carries no client', () => {
  for (const params of [
    undefined,
    null,
    'text',
    [],
    {},
    { _meta: null },
    { _meta: 'text' },
    { _meta: [] },
    // A 2025-era call that only asks for progress: `_meta` is there and the envelope is not.
    { _meta: { progressToken: 'tok-1' } },
  ]) {
    assert.deepEqual(
      mcpFactsFrom({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
      { method: 'tools/call', clientName: null, protocolVersion: null },
      JSON.stringify(params)
    );
  }
});

test('an initialize keeps its own path, whatever else is in the envelope', () => {
  const body = initialize('Claude-AI', '2025-06-18', { _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'Other' } } });
  assert.deepEqual(mcpFactsFrom(body), { method: 'initialize', clientName: 'claude-ai', protocolVersion: '2025-06-18' });
});

test('only an initialize or an enveloped request carries a client and a revision', () => {
  assert.deepEqual(mcpFactsFrom({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    method: 'tools/list',
    clientName: null,
    protocolVersion: null,
  });
  assert.deepEqual(mcpFactsFrom(initialize('Claude-AI', '2025-06-18')), {
    method: 'initialize',
    clientName: 'claude-ai',
    protocolVersion: '2025-06-18',
  });
});

test('an initialize that gives no name or no revision says so rather than being dropped', () => {
  for (const body of [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: null },
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: 'curl' } },
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 7 }, protocolVersion: 20250618 } },
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: '' }, protocolVersion: '' } },
  ]) {
    assert.deepEqual(
      mcpFactsFrom(body),
      { method: 'initialize', clientName: UNNAMED_MCP_CLIENT, protocolVersion: UNSTATED_MCP_VERSION },
      JSON.stringify(body)
    );
  }
});

test('a client name is lowercased, cut to 64 characters and held to a short list of marks', () => {
  assert.equal(cleanMcpClientName('Visual Studio Code'), 'visual studio code');
  assert.equal(cleanMcpClientName('MCP Inspector (v2)'), 'mcp inspector (v2)');
  assert.equal(cleanMcpClientName('a'.repeat(200)), 'a'.repeat(64));
  // The field delimiter, control characters and anything outside the list become an underscore.
  assert.equal(cleanMcpClientName('evil|name\n<script>'), 'evil_name__script_');
  assert.equal(cleanMcpClientName('  padded  '), 'padded');
  assert.equal(cleanMcpClientName('   '), UNNAMED_MCP_CLIENT);
  for (const raw of [undefined, null, 5, {}, []]) assert.equal(cleanMcpClientName(raw), UNNAMED_MCP_CLIENT);
});

test('a protocol revision is kept as given when it has the shape of one', () => {
  for (const ok of ['2025-06-18', '2024-11-05', '2026-07-28', 'DRAFT-2026-v1']) {
    assert.equal(cleanMcpProtocolVersion(ok), ok);
  }
  for (const bad of ['', 'a|b', ' 2025-06-18', 'x'.repeat(33), '../etc', null, 20250618, undefined]) {
    assert.equal(cleanMcpProtocolVersion(bad), UNSTATED_MCP_VERSION, String(bad));
  }
});

// --- the schema -------------------------------------------------------------------------------

test('the census hash is a v2 key of its own, with a field for a method and a field for a client', () => {
  assert.equal(mcpKeyFor('2026-10-23'), KEY);
  assert.deepEqual(parseMcpField('20|method|tools/call'), { hour: '20', kind: 'method', method: 'tools/call' });
  assert.deepEqual(parseMcpField(`20|method|${OTHER_MCP_METHOD}`), { hour: '20', kind: 'method', method: OTHER_MCP_METHOD });
  assert.deepEqual(parseMcpField('20|client|visual studio code|2025-06-18'), {
    hour: '20',
    kind: 'client',
    name: 'visual studio code',
    protocolVersion: '2025-06-18',
  });
  // Not the parts the schema promises: dropped, never guessed at.
  for (const bad of [
    'xx|method|tools/call',
    '20|method|tools/delete',
    '20|method',
    '20|method|tools/call|extra',
    '20|client|name',
    '20|client|Name|2025-06-18',
    '20|client| name|2025-06-18',
    '20|client|name|bad version',
    '20|client||2025-06-18',
    '20|other|x|y',
    '20|client|a|b|c',
  ]) {
    assert.equal(parseMcpField(bad), null, bad);
  }
});

test('a method count is one command, an initialize adds a second, and the day set is always written', () => {
  const call = mcpCensusKeys(mcpFactsFrom({ jsonrpc: '2.0', id: 1, method: 'tools/call' }), { names: [], versions: [] }, AT);
  assert.deepEqual(call.commands, [
    ['HINCRBY', KEY, '20|method|tools/call', '1'],
    ['SADD', 'hits:v2:days', '2026-10-23'],
  ]);
  assert.equal(call.clientField, null);

  const init = mcpCensusKeys(mcpFactsFrom(initialize('Claude-AI', '2025-06-18')), { names: [], versions: [] }, AT);
  assert.deepEqual(init.commands, [
    ['HINCRBY', KEY, '20|method|initialize', '1'],
    ['HINCRBY', KEY, '20|client|claude-ai|2025-06-18', '1'],
    ['SADD', 'hits:v2:days', '2026-10-23'],
  ]);
});

// --- the caps ---------------------------------------------------------------------------------

test('a day names at most sixteen clients and the seventeenth is other-client', () => {
  const named = Array.from({ length: MAX_MCP_CLIENTS_PER_DAY }, (_, i) => `client-${i}`);
  const facts = (clientName) => ({ clientName, protocolVersion: '2025-06-18' });
  // Room left: a new name takes its name.
  assert.equal(mcpClientField(facts('new'), { names: named.slice(0, 3), versions: [] }).name, 'new');
  // Already named today: keeps its name however full the day is.
  assert.equal(mcpClientField(facts('client-4'), { names: named, versions: [] }).name, 'client-4');
  // Full: a new name is the bucket.
  assert.equal(mcpClientField(facts('seventeenth'), { names: named, versions: [] }).name, OTHER_MCP_CLIENT);
  // The two fixed buckets are never counted towards the cap, and never capped.
  assert.equal(mcpClientField(facts(UNNAMED_MCP_CLIENT), { names: named, versions: [] }).name, UNNAMED_MCP_CLIENT);
  assert.equal(
    mcpClientField(facts('fifteenth-plus-one'), { names: [...named.slice(0, 15), OTHER_MCP_CLIENT, UNNAMED_MCP_CLIENT], versions: [] }).name,
    'fifteenth-plus-one'
  );
});

test('a day names at most sixteen revisions and the seventeenth is other-version', () => {
  const named = Array.from({ length: MAX_MCP_VERSIONS_PER_DAY }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`);
  const facts = (protocolVersion) => ({ clientName: 'claude-ai', protocolVersion });
  assert.equal(mcpClientField(facts('2026-07-28'), { names: [], versions: named }).protocolVersion, OTHER_MCP_VERSION);
  assert.equal(mcpClientField(facts(named[3]), { names: [], versions: named }).protocolVersion, named[3]);
  assert.equal(mcpClientField(facts(UNSTATED_MCP_VERSION), { names: [], versions: named }).protocolVersion, UNSTATED_MCP_VERSION);
  assert.equal(mcpClientField(facts('2026-07-28'), { names: [], versions: named.slice(0, 5) }).protocolVersion, '2026-07-28');
});

test('the names and revisions a hash already holds come back without the buckets or the methods', () => {
  const { names, versions } = mcpNamedFrom([
    '07|client|a|2025-06-18',
    '08|client|a|2025-03-26',
    `09|client|${OTHER_MCP_CLIENT}|${OTHER_MCP_VERSION}`,
    `09|client|${UNNAMED_MCP_CLIENT}|${UNSTATED_MCP_VERSION}`,
    '10|method|initialize',
    'junk',
  ]);
  assert.deepEqual([...names], ['a']);
  assert.deepEqual([...versions].sort(), ['2025-03-26', '2025-06-18']);
});

// --- the write --------------------------------------------------------------------------------

test('an initialize costs one read and writes its method and its client in one pipeline', async () => {
  const store = storeNaming(['07|client|earlier|2025-03-26']);
  const result = await recordMcpRequest({
    body: initialize('Claude-AI', '2025-06-18'),
    now: AT,
    env: STORE_ENV,
    fetchImpl: store,
  });
  assert.equal(result.ok, true);
  assert.equal(result.methodField, '20|method|initialize');
  assert.equal(result.clientField, '20|client|claude-ai|2025-06-18');
  assert.deepEqual(store.calls[0], [['HKEYS', KEY]]);
  assert.equal(store.calls.length, 2);
  assert.deepEqual(store.calls[1][0], ['HINCRBY', KEY, '20|method|initialize', '1']);
  assert.deepEqual(store.calls[1][1], ['HINCRBY', KEY, '20|client|claude-ai|2025-06-18', '1']);
});

test('a 2026-era tools/call writes a Clients row from its envelope, with one read', async () => {
  const store = storeNaming(['07|client|earlier|2025-03-26']);
  const result = await recordMcpRequest({
    body: enveloped('tools/call', {
      name: 'Claude-AI',
      params: { name: 'audit_site', arguments: { url: 'https://secret.example/x' } },
      meta: { 'io.modelcontextprotocol/clientCapabilities': { sampling: {}, roots: { listChanged: true } } },
    }),
    now: AT,
    env: STORE_ENV,
    fetchImpl: store,
  });
  assert.equal(result.ok, true);
  assert.equal(result.methodField, '20|method|tools/call');
  assert.equal(result.clientField, '20|client|claude-ai|2026-07-28');
  assert.deepEqual(store.calls[0], [['HKEYS', KEY]]);
  assert.deepEqual(store.calls[1][0], ['HINCRBY', KEY, '20|method|tools/call', '1']);
  assert.deepEqual(store.calls[1][1], ['HINCRBY', KEY, '20|client|claude-ai|2026-07-28', '1']);
  // The same three facts and nothing else: not the version of the client, the target or the
  // capabilities the envelope declares.
  const sent = JSON.stringify(store.calls);
  for (const leaked of ['4.5.6', 'secret.example', 'sampling', 'listChanged', 'audit_site']) {
    assert.ok(!sent.includes(leaked), `leaked: ${leaked}`);
  }
});

test('the seventeenth name of a day is other-client on the envelope path too', async () => {
  const full = storeNaming(Array.from({ length: MAX_MCP_CLIENTS_PER_DAY }, (_, i) => `07|client|client-${i}|2026-07-28`));
  const result = await recordMcpRequest({
    body: enveloped('tools/list', { name: 'seventeenth' }),
    now: AT,
    env: STORE_ENV,
    fetchImpl: full,
  });
  assert.equal(result.clientField, `20|client|${OTHER_MCP_CLIENT}|2026-07-28`);
});

test('any other method is one pipeline and no read', async () => {
  const store = storeNaming([]);
  const result = await recordMcpRequest({
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'audit_site', arguments: { url: 'https://secret.example/x' } } },
    now: AT,
    env: STORE_ENV,
    fetchImpl: store,
  });
  assert.equal(result.ok, true);
  assert.equal(result.clientField, null);
  assert.equal(store.calls.length, 1);
  assert.deepEqual(store.calls[0], [
    ['HINCRBY', KEY, '20|method|tools/call', '1'],
    ['SADD', 'hits:v2:days', '2026-10-23'],
  ]);
});

test('a body that did not parse, a batch and a notification each count once as other-method', async () => {
  for (const body of [undefined, [{ jsonrpc: '2.0', id: 1, method: 'tools/call' }], { jsonrpc: '2.0', method: 'notifications/initialized' }]) {
    const store = storeNaming([]);
    const result = await recordMcpRequest({ body, now: AT, env: STORE_ENV, fetchImpl: store });
    assert.equal(result.ok, true);
    assert.equal(result.methodField, `20|method|${OTHER_MCP_METHOD}`);
    assert.equal(store.calls.length, 1);
  }
});

test('the seventeenth name of a day is counted as other-client', async () => {
  const full = storeNaming(Array.from({ length: MAX_MCP_CLIENTS_PER_DAY }, (_, i) => `07|client|client-${i}|2025-06-18`));
  const result = await recordMcpRequest({
    body: initialize('seventeenth', '2025-06-18'),
    now: AT,
    env: STORE_ENV,
    fetchImpl: full,
  });
  assert.equal(result.clientField, `20|client|${OTHER_MCP_CLIENT}|2025-06-18`);
  assert.deepEqual(full.calls[1][1], ['HINCRBY', KEY, `20|client|${OTHER_MCP_CLIENT}|2025-06-18`, '1']);
});

test('nothing but the method, the name and the revision reaches the store', async () => {
  const store = storeNaming([]);
  await recordMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 99,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: { sampling: {}, roots: { listChanged: true } },
        clientInfo: { name: 'Some Client', version: '9.8.7', title: 'Person Name', websiteUrl: 'https://private.example' },
        _meta: { progressToken: 'tok-123' },
      },
    },
    now: AT,
    env: STORE_ENV,
    fetchImpl: store,
  });
  const sent = JSON.stringify(store.calls);
  for (const leaked of ['9.8.7', 'Person Name', 'private.example', 'tok-123', 'sampling', 'listChanged']) {
    assert.ok(!sent.includes(leaked), `leaked: ${leaked}`);
  }
  assert.ok(sent.includes('some client'));
});

test('no env vars means no store, no throw, and no fetch attempted', async () => {
  const store = storeNaming([]);
  const result = await recordMcpRequest({ body: initialize('x', '2025-06-18'), env: {}, fetchImpl: store });
  assert.deepEqual(result, { ok: false, reason: 'no-store' });
  assert.equal(store.calls.length, 0);
});

test('a read that fails loses the client and never the method', async () => {
  for (const hkeys of ['fail', '500']) {
    const store = storeNaming([], { hkeys });
    const result = await recordMcpRequest({
      body: initialize('claude-ai', '2025-06-18'),
      now: AT,
      env: STORE_ENV,
      fetchImpl: store,
    });
    assert.equal(result.ok, true, hkeys);
    assert.equal(result.clientField, null, hkeys);
    assert.equal(store.calls.length, 2, hkeys);
    assert.deepEqual(store.calls[1], [
      ['HINCRBY', KEY, '20|method|initialize', '1'],
      ['SADD', 'hits:v2:days', '2026-10-23'],
    ]);
  }
});

test('a store error is undercounting, never a throw', async () => {
  const refuse = async () => ({ ok: false, status: 503 });
  const down = async () => {
    throw new Error('ECONNRESET');
  };
  const refused = await recordMcpRequest({ body: { method: 'tools/list' }, now: AT, env: STORE_ENV, fetchImpl: refuse });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'status-503');
  const failed = await recordMcpRequest({ body: { method: 'tools/list' }, now: AT, env: STORE_ENV, fetchImpl: down });
  assert.equal(failed.ok, false);
});

// --- the surface hit --------------------------------------------------------------------------

test('/mcp is a surface of its own, so the By client and By surface tables carry it', () => {
  assert.equal(MCP_ENDPOINT_PATH, '/mcp');
  assert.equal(counterPath('surface', '/mcp'), '/mcp');
  assert.equal(counterPath('surface', '/mcp/'), '/mcp');
  assert.equal(counterPath('surface', '/mcp/other'), '/*');
});

// --- the read ---------------------------------------------------------------------------------

/** A census hash built the way recordMcpRequest() would have built it, `hoursAgo` hours before NOW. */
function census(hoursAgo, fields) {
  const at = new Date(NOW.getTime() - hoursAgo * 3_600_000);
  const day = at.toISOString().slice(0, 10);
  const hour = at.toISOString().slice(11, 13);
  return { day, fields: Object.fromEntries(Object.entries(fields).map(([suffix, count]) => [`${hour}|${suffix}`, String(count)])) };
}

test('the census flattens to method rows and client rows, and drops what it cannot parse', () => {
  const rows = flattenMcpHashes([
    { day: '2026-10-23', fields: { '20|method|initialize': '3', '20|client|claude-ai|2025-06-18': '3', 'xx|method|initialize': '1', '20|client|Bad|2025': '4', '20|method|tools/list': '0' } },
    { day: 'not-a-day', fields: { '20|method|initialize': '9' } },
  ]);
  assert.deepEqual(rows, [
    { hour: bucketHour('2026-10-23', '20'), kind: 'method', method: 'initialize', count: 3 },
    { hour: bucketHour('2026-10-23', '20'), kind: 'client', name: 'claude-ai', protocolVersion: '2025-06-18', count: 3 },
  ]);
});

test('the methods table always has a row for every counted method, zeros included', () => {
  const empty = summarizeMcp([], NOW);
  assert.deepEqual(
    empty.methods.rows.map(({ method, week, month }) => [method, week, month]),
    [...MCP_METHODS, OTHER_MCP_METHOD].map((method) => [method, 0, 0])
  );
  assert.deepEqual(empty.clients, { rows: [], omitted: 0 });
});

test('the census tallies over the 7-day and 30-day windows and sorts clients by the 7-day column', () => {
  const rows = flattenMcpHashes([
    census(2, { 'method|initialize': 4, 'method|server/discover': 2, 'client|claude-ai|2025-06-18': 3, 'client|inspector|2025-03-26': 1 }),
    census(30, { 'method|initialize': 1, 'client|claude-ai|2025-06-18': 1 }),
    census(400, { 'method|initialize': 5, 'method|tools/call': 7, 'client|old-client|2024-11-05': 9 }),
    census(900, { 'method|initialize': 8 }),
  ]);
  const summary = summarizeMcp(rows, NOW);

  const byMethod = Object.fromEntries(summary.methods.rows.map((row) => [row.method, [row.week, row.month]]));
  assert.deepEqual(byMethod['initialize'], [5, 10]);
  assert.deepEqual(byMethod['server/discover'], [2, 2]);
  assert.deepEqual(byMethod['tools/call'], [0, 7]);
  assert.deepEqual(byMethod['tools/list'], [0, 0]);

  assert.deepEqual(
    summary.clients.rows.map(({ name, protocolVersion, week, month }) => [name, protocolVersion, week, month]),
    [
      ['claude-ai', '2025-06-18', 4, 4],
      ['inspector', '2025-03-26', 1, 1],
      ['old-client', '2024-11-05', 0, 9],
    ]
  );
  assert.equal(summary.clients.omitted, 0);
});

test('one client asking for two revisions is two rows', () => {
  const rows = flattenMcpHashes([
    census(1, { 'client|claude-ai|2025-06-18': 2, 'client|claude-ai|2025-03-26': 1 }),
  ]);
  assert.equal(summarizeMcp(rows, NOW).clients.rows.length, 2);
});

test('the census counts nothing twice: it leaves the headline totals where they were', () => {
  const traffic = [{ hour: bucketHour('2026-10-23', '20'), event: 'surface', family: 'curl', path: '/mcp', verification: '', count: 5 }];
  const mcp = flattenMcpHashes([{ day: '2026-10-23', fields: { '20|method|initialize': '5', '20|client|x|2025-06-18': '5' } }]);
  const without = buildActivity(traffic, NOW);
  const withCensus = buildActivity(traffic, NOW, { mcp });
  assert.deepEqual(withCensus.totals, without.totals);
  assert.equal(withCensus.totals.day, 5);
  assert.equal(withCensus.mcp.clients.rows.length, 1);
  assert.deepEqual(without.mcp.clients, { rows: [], omitted: 0 });
});

// --- the wiring -------------------------------------------------------------------------------

test('the route counts every POST before it can refuse one, and through waitUntil', () => {
  const parseError = routeSource.indexOf("countRequest(request, undefined)");
  const parsed = routeSource.indexOf('countRequest(request, body)');
  const screen = routeSource.indexOf('refusalForBody(body)');
  const limiter = routeSource.indexOf('checkRateLimit(');
  const handler = routeSource.indexOf('handler.fetch(');

  assert.ok(parseError > 0, 'a body that does not parse is counted');
  assert.ok(parsed > 0, 'a body that parses is counted');
  assert.ok(parsed < screen, 'a refused batch is counted: the count runs before the screen');
  assert.ok(parsed < limiter, 'a rate-limited call is counted: the count runs before the limiter');
  assert.ok(parsed < handler);
  assert.match(routeSource, /waitUntil\(recordMcpRequest\(\{ body \}\)\)/);
  assert.match(routeSource, /waitUntil\(recordHit\(\{ event: 'surface', path: MCP_ENDPOINT_PATH/);
  assert.equal(routeSource.match(/countRequest\(request,/g).length, 2, 'the two call sites, and no third');
});

test('the count is its own failure domain and never awaited in front of the response', () => {
  const fn = routeSource.slice(routeSource.indexOf('function countRequest'), routeSource.indexOf('export const POST'));
  assert.match(fn, /try \{/);
  assert.match(fn, /catch \{/);
  assert.ok(!/await /.test(fn), 'no await inside the counting function');
});

test('the three renders carry the same legends and the same counts note', () => {
  assert.match(bodySource, /MCP_CLIENTS_LEGEND/);
  assert.match(bodySource, /MCP_METHODS_LEGEND/);
  assert.match(bodySource, /MCP_COUNTS_NOTE/);
  assert.match(jsonSource, /MCP_CLIENTS_LEGEND/);
  assert.match(jsonSource, /MCP_METHODS_LEGEND/);
  assert.match(jsonSource, /MCP_COUNTS_NOTE/);
  assert.match(markdownSource, /MCP_CLIENTS_LEGEND/);
  assert.match(markdownSource, /MCP_METHODS_LEGEND/);
  assert.match(markdownSource, /MCP_COUNTS_NOTE/);
  for (const source of [bodySource, jsonSource, markdownSource]) assert.match(source, /flattenMcpHashes|activity\.mcp/);
});

test('the counts note says a client name is the name of software, and the legend says what a row proves', () => {
  assert.match(MCP_COUNTS_NOTE, /name of a piece of software/);
  assert.match(MCP_COUNTS_NOTE, /not of a person/);
  assert.match(MCP_COUNTS_NOTE, /nothing else in the request body is read/);
  assert.match(MCP_CLIENTS_LEGEND, /not who runs it/);
  assert.match(MCP_METHODS_LEGEND, /server\/discover/);
});
