import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { refusalForBody } from '../src/lib/mcp-audit-server.mjs';

// What request shapes POST /mcp accepts, and the ordering that makes the rate limit mean what it
// says.
//
// The endpoint counts one audit per POST. A JSON-RPC batch breaks that arithmetic and nothing else
// notices: the SDK's transport parses an array body into N messages and dispatches every one of
// them, so a batch of ten `tools/call` members is ten audits against a single rate-limit
// increment — a 10x bypass of both the per-caller and the global limit, available to anyone who
// can write a JSON array.
//
// Batching was removed from the MCP protocol in 2025-06-18, the version this server speaks, so
// refusing an array costs a conformant client nothing at all.
//
// Two halves, and they only mean something together: the pure function refuses a batch, and the
// route consults it before it reaches the store or the auditor. The second half is asserted against
// the route's source because it is an ordering property, not observable from any export — the same
// way tests/on-demand-routes.test.mjs pins its redirect ahead of the first countHit call.

const routeSource = readFileSync(fileURLToPath(new URL('../src/pages/mcp.ts', import.meta.url)), 'utf8');

test('a JSON-RPC batch is refused', () => {
  const refusal = refusalForBody([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'audit_site', arguments: { url: 'a.example' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'audit_site', arguments: { url: 'b.example' } } },
  ]);

  assert.ok(refusal, 'an array body must be refused');
  assert.equal(refusal.status, 400);
  // `id: null` because a batch has no single id to answer under, which is the case the spec
  // reserves null for.
  assert.equal(refusal.payload.id, null);
  assert.equal(refusal.payload.error.code, -32600);
  assert.match(refusal.payload.error.message, /one request per POST/i);
});

test('a batch of one is refused too, on its shape rather than its length', () => {
  // The bypass is the array, not the count. Admitting a one-member array would leave the guard
  // asking how many audits are too many, which is the question the rate limiter exists to answer.
  const refusal = refusalForBody([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  assert.ok(refusal, 'a single-member array is still a batch');
  assert.equal(refusal.status, 400);
});

test('an empty array is refused rather than passed through as harmless', () => {
  assert.ok(refusalForBody([]));
});

test('a single request is not refused, whatever it asks for', () => {
  const bodies = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'audit_site', arguments: { url: 'example.com' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ];
  for (const body of bodies) {
    assert.equal(refusalForBody(body), null, JSON.stringify(body));
  }
});

test('a body that is not an object at all is left to the transport to reject', () => {
  // This guard has one job. A string or a number is an invalid request, but it is not a *batch*,
  // and the SDK's own schema parse gives a better error for it than a second opinion here would.
  for (const body of ['nonsense', 42, null, true]) {
    assert.equal(refusalForBody(body), null, JSON.stringify(body));
  }
});

test('the route refuses a batch before it reaches the rate limiter or the transport', () => {
  // The whole point of the guard. If the screen ran after `checkRateLimit`, a batch would still
  // cost one increment and buy N audits; if it ran after `handleRequest`, the audits would already
  // have happened. Ordering, asserted against the source because it is not observable from the
  // exports.
  const screen = routeSource.indexOf('refusalForBody(body)');
  const limiter = routeSource.indexOf('checkRateLimit(');
  const transport = routeSource.indexOf('transport.handleRequest(');

  assert.ok(screen > 0, 'src/pages/mcp.ts must consult refusalForBody');
  assert.ok(limiter > 0, 'src/pages/mcp.ts must still call checkRateLimit');
  assert.ok(transport > 0, 'src/pages/mcp.ts must still hand the request to the transport');
  assert.ok(screen < limiter, 'the batch screen must run before the rate limiter');
  assert.ok(screen < transport, 'the batch screen must run before the transport');
});

test('the rate limiter runs before the transport', () => {
  // The property the limiter is worthless without: an audit that has not been counted must not
  // have run. Pinned here rather than left to review, because both call sites are one `await` apart.
  assert.ok(
    routeSource.indexOf('checkRateLimit(') < routeSource.indexOf('transport.handleRequest('),
    'no audit may reach the transport before it has been counted',
  );
});
