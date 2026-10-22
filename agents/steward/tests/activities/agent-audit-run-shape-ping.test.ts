import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AssembleDeepAuditInput } from '../../src/activities/agent-audit.js';
import type { AuditResult } from '../../src/lib/agent-audit/result.js';
import type { RenderedPageOutcome } from '../../src/lib/agent-audit/deep-assemble.js';

/**
 * `assembleDeepAudit` pings `run-shape` on every deep audit: success when the
 * browser rendered a page of the sample, `/fail` when it rendered none. The
 * success ping is what clears a fail ping left by an earlier bad run.
 *
 * `HEALTHCHECK_BASE` is read once, when `config.ts` loads, so this file points
 * it at a loopback server and only then imports the activity.
 */

const received: string[] = [];
let server: http.Server;
let assembleDeepAudit: typeof import('../../src/activities/agent-audit.js').assembleDeepAudit;

before(async () => {
  server = http.createServer((req, res) => {
    received.push(req.url ?? '');
    req.resume();
    req.on('end', () => res.end('OK'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env.STEWARD_HEALTHCHECK_BASE = `http://127.0.0.1:${port}/pingkey`;
  ({ assembleDeepAudit } = await import('../../src/activities/agent-audit.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fast(): AuditResult {
  return {
    schemaVersion: 2,
    tool: { name: 'steward-audit', version: '0.2.0' },
    target: { input: 'example.com', origin: 'https://example.com' },
    startedAt: '2026-10-21T00:00:00.000Z',
    finishedAt: '2026-10-21T00:00:04.000Z',
    durationMs: 4000,
    requests: 12,
    categories: [],
    checks: [],
    notes: [],
  };
}

function page(url: string): RenderedPageOutcome {
  return {
    url,
    scores: { 'agentic-browsing': 95, accessibility: 100, seo: 100, performance: 95, 'best-practices': 100 },
    lighthouseVersion: '13.4.1',
    lighthouseError: null,
    violations: [],
    axeError: null,
    timedOut: false,
    blocked: { listed: [], total: 0 },
  };
}

function input(overrides: Partial<AssembleDeepAuditInput>): AssembleDeepAuditInput {
  return {
    fast: fast(),
    pages: [],
    skipped: [],
    sample: [],
    available: 0,
    browserFailure: null,
    progressNotes: [],
    ...overrides,
  };
}

test('a healthy deep audit pings run-shape success', async () => {
  received.length = 0;
  await assembleDeepAudit(
    input({ pages: [page('https://example.com/')], sample: ['https://example.com/'], available: 1 }),
  );
  assert.deepEqual(received, ['/pingkey/steward-run-shape']);
});

test('a deep audit that rendered nothing of its sample still pings run-shape fail', async () => {
  received.length = 0;
  await assembleDeepAudit(
    input({
      sample: ['https://example.com/', 'https://example.com/about'],
      available: 2,
      browserFailure: 'Chrome could not be launched',
    }),
  );
  assert.deepEqual(received, ['/pingkey/steward-run-shape/fail']);
});
