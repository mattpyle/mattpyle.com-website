import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  createAuditServer,
  MCP_HANDLER_OPTIONS,
  MODERN_PROTOCOL_VERSION,
  SERVED_PROTOCOL_VERSIONS,
  SERVER_NAME,
  TOOL_NAME,
} from '../src/lib/mcp-audit-server.mjs';

// The two protocol revisions /mcp answers on one endpoint, driven the way src/pages/mcp.ts drives
// them: the body is read and parsed first, then the Request goes to `handler.fetch` with the parsed
// body beside it. A fake auditor stands in for the real one, as in tests/mcp-audit-server.test.mjs;
// the questions here are about the wire, not about a site.
//
// What this file does not re-implement is the SDK's own work on the modern path: header validation
// and the server identity in `_meta`. One test each reads them back, so a SDK upgrade that changes
// either fails here rather than in a client.

const ENVELOPE = Object.freeze({
  'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'Protocol Test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

function auditFor(url) {
  return {
    schemaVersion: 2,
    tool: { name: 'steward-audit', version: '0.2.0' },
    target: { input: url, origin: new URL(url.includes('://') ? url : `https://${url}`).origin },
    startedAt: '2026-10-23T15:00:00.000Z',
    finishedAt: '2026-10-23T15:00:04.000Z',
    durationMs: 4000,
    requests: 11,
    categories: [{ category: 'crawlability', passed: 3, failed: 1, notApplicable: 0, errored: 0 }],
    checks: [
      {
        id: 'llms-txt',
        title: 'llms.txt exists and follows the spec',
        category: 'discovery',
        severity: 'medium',
        status: 'fail',
        observed: '404 - no llms.txt',
      },
    ],
    notes: [],
  };
}

/** What the fake auditor was asked, across every request of one test. */
function newSession() {
  return { audited: [], factoryCalls: 0 };
}

function buildServer(session) {
  return createAuditServer({
    runAudit: async (url) => {
      session.audited.push(url);
      return auditFor(url);
    },
    renderSummary: (audit) => `# Audit of ${audit.target.origin}`,
    normaliseTarget: (input) => {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
      return { origin: url.origin, url };
    },
    version: '9.9.9',
    userAgent: 'test-audit/9.9.9 (+https://example.test/steward)',
  });
}

/** The JSON-RPC messages in a response, whether the SDK framed them as one JSON body or as SSE. */
async function messagesOf(response) {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    return text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)));
  }
  return [JSON.parse(text)];
}

/**
 * One POST, built the way the route builds it: a server and a handler per request, the body read
 * once, the handler closed after the response.
 */
async function post(session, body, headers = {}) {
  const request = new Request('https://test.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const parsed = JSON.parse(await request.text());
  const server = buildServer(session);
  const handler = createMcpHandler(() => {
    session.factoryCalls += 1;
    return server;
  }, MCP_HANDLER_OPTIONS);
  try {
    const response = await handler.fetch(request, { parsedBody: parsed });
    const messages = await messagesOf(response);
    return { status: response.status, headers: response.headers, messages, message: messages.at(-1) };
  } finally {
    await handler.close();
  }
}

/** The three headers a 2026-07-28 POST carries beside its envelope. */
function modernHeaders(method, name) {
  return {
    'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {}),
  };
}

function modern(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: ENVELOPE } };
}

// --- the 2026-07-28 revision ------------------------------------------------------------------

test('server/discover answers with the revision shape and no handshake before it', async () => {
  const session = newSession();
  const { status, message } = await post(session, modern(1, 'server/discover'), modernHeaders('server/discover'));

  assert.equal(status, 200);
  assert.equal(message.id, 1);
  assert.equal(message.result.resultType, 'complete');
  assert.deepEqual(message.result.supportedVersions, [MODERN_PROTOCOL_VERSION]);
  assert.ok(message.result.capabilities.tools, 'the tools capability is advertised');
  assert.match(message.result.instructions, /agent-readiness/);
  assert.equal(typeof message.result.ttlMs, 'number');
  assert.ok(['public', 'private'].includes(message.result.cacheScope));
});

test('the newest served revision is the one server/discover reports, and the card list follows it', async () => {
  const session = newSession();
  const { message } = await post(session, modern(1, 'server/discover'), modernHeaders('server/discover'));
  assert.equal(SERVED_PROTOCOL_VERSIONS[0], message.result.supportedVersions[0]);
  // The 2025-era half is the SDK's own list, and it must still be there behind the new one.
  assert.ok(SERVED_PROTOCOL_VERSIONS.includes('2025-06-18'));
});

test('a tools/call with the envelope returns resultType complete and the server identity in _meta', async () => {
  const session = newSession();
  const { status, headers, message } = await post(
    session,
    modern(2, 'tools/call', { name: TOOL_NAME, arguments: { url: 'example.com' } }),
    modernHeaders('tools/call', TOOL_NAME),
  );

  assert.equal(status, 200);
  // One JSON body under `responseMode: 'auto'`, because nothing is emitted before the result.
  assert.match(headers.get('content-type'), /^application\/json/);
  assert.equal(message.result.resultType, 'complete');
  // Read back, not reimplemented: the SDK stamps the identity on every modern response.
  assert.deepEqual(message.result._meta['io.modelcontextprotocol/serverInfo'], { name: SERVER_NAME, version: '9.9.9' });
  assert.equal(message.result.structuredContent.target.origin, 'https://example.com');
  assert.deepEqual(session.audited, ['example.com']);
});

test('tools/list on the modern path carries the public one-hour cache hint', async () => {
  const session = newSession();
  const { message } = await post(session, modern(3, 'tools/list'), modernHeaders('tools/list'));

  assert.equal(message.result.resultType, 'complete');
  assert.equal(message.result.ttlMs, 3_600_000);
  assert.equal(message.result.cacheScope, 'public');
  assert.deepEqual(
    message.result.tools.map((tool) => tool.name),
    [TOOL_NAME],
  );
});

test('an Mcp-Method header that disagrees with the body is -32020', async () => {
  const session = newSession();
  const { status, message } = await post(session, modern(4, 'tools/list'), modernHeaders('server/discover'));

  assert.equal(status, 400);
  assert.equal(message.error.code, -32020);
  assert.equal(message.id, 4);
  assert.deepEqual(session.audited, []);
});

test('an Mcp-Name header that disagrees with the tool in the body is -32020 and nothing is audited', async () => {
  const session = newSession();
  const { status, message } = await post(
    session,
    modern(5, 'tools/call', { name: TOOL_NAME, arguments: { url: 'example.com' } }),
    modernHeaders('tools/call', 'some_other_tool'),
  );

  assert.equal(status, 400);
  assert.equal(message.error.code, -32020);
  assert.deepEqual(session.audited, [], 'a refused call must not reach the auditor');
});

// --- subscriptions/listen on a function with a time limit -------------------------------------

test('a subscriptions/listen request returns within one second and holds nothing open', async (t) => {
  const session = newSession();
  let timer;
  const held = new Promise((resolve) => {
    timer = setTimeout(() => resolve('held open'), 1000);
  });
  t.after(() => clearTimeout(timer));

  const answer = post(
    session,
    modern(6, 'subscriptions/listen', { notifications: { toolsListChanged: true } }),
    modernHeaders('subscriptions/listen'),
  );
  const outcome = await Promise.race([answer, held]);

  assert.notEqual(outcome, 'held open', 'the listen stream must end on its own: no timer bounds it');
  assert.equal(outcome.status, 200);
  // The acknowledgement names what the server honoured, which is nothing, and the stream then ends
  // with a complete result rather than waiting for an event that cannot come.
  const [ack, result] = outcome.messages;
  assert.equal(ack.method, 'notifications/subscriptions/acknowledged');
  assert.deepEqual(ack.params.notifications, {});
  assert.equal(result.result.resultType, 'complete');
});

test('the server advertises no listChanged on its tools, on either revision', async () => {
  const session = newSession();
  const discover = await post(session, modern(1, 'server/discover'), modernHeaders('server/discover'));
  assert.notEqual(discover.message.result.capabilities.tools.listChanged, true);

  const initialize = await post(session, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
  });
  assert.notEqual(initialize.message.result.capabilities.tools.listChanged, true);
});

// --- 2025-era clients on the same endpoint ----------------------------------------------------

test('a 2025-06-18 initialize and then a tools/call answer as before', async () => {
  const session = newSession();
  const init = await post(session, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
  });
  assert.equal(init.status, 200);
  assert.equal(init.message.result.protocolVersion, '2025-06-18');
  assert.equal(init.message.result.serverInfo.name, SERVER_NAME);
  assert.equal(init.message.result.serverInfo.version, '9.9.9');
  assert.match(init.message.result.instructions, /agent-readiness/);

  // Stateless: the second request carries no session and no handshake, and is answered anyway.
  const call = await post(
    session,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: TOOL_NAME, arguments: { url: 'example.com' } } },
    { 'mcp-protocol-version': '2025-06-18' },
  );
  assert.equal(call.status, 200);
  assert.equal(call.message.result.structuredContent.target.origin, 'https://example.com');
  assert.equal(call.message.result.content[0].type, 'text');
  // The 2026 fields belong to the 2026 revision alone.
  assert.equal('resultType' in call.message.result, false);
  assert.equal(call.message.result._meta, undefined);
  assert.deepEqual(session.audited, ['example.com']);
});

test('a 2025-era tools/list carries no cache fields', async () => {
  const session = newSession();
  const { message } = await post(
    session,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { 'mcp-protocol-version': '2025-06-18' },
  );
  assert.equal(message.result.tools.length, 1);
  assert.equal('ttlMs' in message.result, false);
  assert.equal('cacheScope' in message.result, false);
});

test('every revision in the 2025-era list is negotiated back to the client', async () => {
  const session = newSession();
  for (const version of SERVED_PROTOCOL_VERSIONS.filter((v) => v !== MODERN_PROTOCOL_VERSION)) {
    const { message } = await post(session, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'old', version: '1' } },
    });
    assert.equal(message.result.protocolVersion, version);
  }
});

test('the factory runs once per request on both revisions', async () => {
  // The route hands the handler a server it has already built, so a second call would connect that
  // one server twice. Pinned here because the SDK, not this repository, decides how often it asks.
  const modernSession = newSession();
  await post(modernSession, modern(1, 'tools/list'), modernHeaders('tools/list'));
  assert.equal(modernSession.factoryCalls, 1);

  const legacySession = newSession();
  await post(legacySession, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
  assert.equal(legacySession.factoryCalls, 1);
});
