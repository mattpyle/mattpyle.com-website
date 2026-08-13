import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Client } from '@temporalio/client';
import { startMcpHttpServer, MCP_PATH, type McpHttpServer } from '../../src/mcp/http.js';

/**
 * The listener's Host-header check, over real sockets.
 *
 * No Temporal here on purpose: the check runs before any routing, and the one
 * request that gets past it is an `initialize`, which the server answers out of
 * its own registrations without ever touching the client. A `Client` is
 * therefore a stub — if any of these tests starts a workflow, that is the test
 * having drifted off the thing it measures.
 *
 * The requests are hand-rolled `http.request` calls rather than `fetch` because
 * `Host` is a forbidden header name for `fetch`: the one header these tests are
 * about is the one it will not let them set.
 */

const STUB_CLIENT = {} as unknown as Client;
const TUNNEL_HOST = 'audit.example.trycloudflare.com';

let server: McpHttpServer;

before(async () => {
  server = await startMcpHttpServer({
    client: STUB_CLIENT,
    host: '127.0.0.1',
    port: 0,
    allowedHosts: [TUNNEL_HOST],
  });
});

after(async () => {
  await server?.close();
});

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'steward-host-test', version: '0.0.0' },
  },
});

function request(options: {
  host: string | null;
  path?: string;
  method?: string;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    // `http.request` writes a Host header itself; `setHeader`-style overrides in
    // the options object replace it, and `null` removes it entirely.
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: options.path ?? MCP_PATH,
        method: options.method ?? 'POST',
        headers,
        setHost: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    if (options.host !== null) req.setHeader('host', options.host);
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('a request carrying a foreign Host is refused before it reaches the MCP server', async () => {
  // The attack this closes: a page on evil.example, or a name the attacker
  // resolves to 127.0.0.1, POSTing to the loopback port from the operator's own
  // browser. The Host header is what gives it away.
  const refused = await request({ host: 'evil.example', body: INITIALIZE });
  assert.equal(refused.status, 403);
  const error = JSON.parse(refused.body) as { error: { code: number; message: string } };
  assert.equal(error.error.code, -32000);
  assert.match(error.error.message, /Invalid Host: evil\.example/);
});

test('a request with no Host header at all is refused', async () => {
  // Node's own HTTP/1.1 parser answers this one with a 400 before the handler
  // ever runs, so the 403 branch for a missing Host is a belt the parser already
  // wears. What matters is that no such request is served: hence the range.
  const refused = await request({ host: null, body: INITIALIZE });
  assert.ok(refused.status === 400 || refused.status === 403, `served a Host-less request: ${refused.status}`);
});

test('the check is on the hostname, so a loopback Host on any port is accepted', async () => {
  for (const host of ['127.0.0.1', `127.0.0.1:${server.port}`, 'localhost:1234', '[::1]']) {
    const accepted = await request({ host, body: INITIALIZE });
    assert.equal(accepted.status, 200, `Host ${host} was refused`);
    const answer = JSON.parse(accepted.body) as { result?: { serverInfo?: { name: string } } };
    assert.equal(answer.result?.serverInfo?.name, 'steward-audit');
  }
});

test('an operator-extended host is accepted — the tunnel case', async () => {
  // cloudflared forwards the public request's Host, so a strict loopback list
  // would refuse every request the demo makes.
  const accepted = await request({ host: TUNNEL_HOST, body: INITIALIZE });
  assert.equal(accepted.status, 200);
});

test('the health probe is behind the same check', async () => {
  const refused = await request({ host: 'evil.example', path: '/healthz', method: 'GET' });
  assert.equal(refused.status, 403);
  const allowed = await request({ host: 'localhost', path: '/healthz', method: 'GET' });
  assert.equal(allowed.status, 200);
});
