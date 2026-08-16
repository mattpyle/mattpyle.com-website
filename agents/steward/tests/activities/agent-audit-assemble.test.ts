import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleDeepAudit, type AssembleDeepAuditInput } from '../../src/activities/agent-audit.js';
import type { AuditResult } from '../../src/lib/agent-audit/result.js';
import type { RenderedPageOutcome } from '../../src/lib/agent-audit/deep-assemble.js';

/**
 * `assembleDeepAudit` is pure arithmetic over values the workflow already holds,
 * so it runs here with no Temporal, no worker and no browser. What is tested is
 * the invariant the report now carries: a run that rendered nothing of a sample
 * it chose must not assemble a document that reads as clean.
 *
 * The alerting side channel is a no-op in the suite because
 * `STEWARD_HEALTHCHECK_BASE` is unset (`tests/helpers/no-real-credentials.ts`),
 * which is why nothing here has to intercept a network call.
 */

function fastFixture(): AuditResult {
  return {
    schemaVersion: 2,
    tool: { name: 'steward audit-url', version: '0.2.0' },
    target: { input: 'example.com', origin: 'https://example.com' },
    startedAt: '2026-08-15T00:00:00.000Z',
    finishedAt: '2026-08-15T00:00:04.000Z',
    durationMs: 4000,
    requests: 12,
    categories: [],
    checks: [
      {
        id: 'llms-txt',
        title: 'llms.txt is served',
        category: 'discovery',
        severity: 'medium',
        status: 'pass',
        observed: 'llms.txt answered 200 with 40 lines of markdown',
        evidence: [],
      },
    ],
    notes: [],
  };
}

function renderedPage(url: string): RenderedPageOutcome {
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

function input(overrides: Partial<AssembleDeepAuditInput> = {}): AssembleDeepAuditInput {
  return {
    fast: fastFixture(),
    pages: [],
    skipped: [],
    sample: [],
    available: 0,
    browserFailure: null,
    progressNotes: [],
    ...overrides,
  };
}

test('a run that rendered nothing of a nonzero sample assembles degraded', async () => {
  const audit = await assembleDeepAudit(
    input({
      sample: ['https://example.com/', 'https://example.com/about'],
      available: 2,
      browserFailure: 'Chrome could not be launched',
    }),
  );

  assert.equal(audit.integrity?.status, 'degraded');
  assert.match(audit.integrity?.reason ?? '', /0 of 2/);
  // The fetch half is untouched by the verdict — that is the sentence the reason
  // carries, and it has to stay true of the document as well as of the prose.
  assert.equal(audit.checks.find((c) => c.id === 'llms-txt')?.status, 'pass');
});

test('a run that rendered a page assembles clean', async () => {
  const audit = await assembleDeepAudit(
    input({
      pages: [renderedPage('https://example.com/')],
      sample: ['https://example.com/', 'https://example.com/about'],
      available: 2,
      skipped: [{ url: 'https://example.com/about', reason: 'out of budget', robots: false }],
    }),
  );

  assert.deepEqual(audit.integrity, { status: 'clean' });
  assert.equal(audit.browserPages, 1);
});

test('a sample of zero assembles clean', async () => {
  // A site whose robots.txt refuses this auditor renders nothing, and that is the
  // site's answer rather than a broken run.
  const audit = await assembleDeepAudit(input());
  assert.deepEqual(audit.integrity, { status: 'clean' });
});
