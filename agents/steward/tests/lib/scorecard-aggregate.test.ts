import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregate,
  decidePublish,
  validateCommentary,
  type PageAuditOutcome,
  type ScorecardMetric,
  type PublishableRun,
} from '../../src/lib/scorecard-aggregate.js';

/**
 * Aggregation, thresholds, and the publish decision (spec §5.3, §6), against
 * the canned fixtures §9.1 asks for: all-green, one-page-perf-92, an axe
 * violation, and a tool-failure marker.
 */

const ALL_CHECKS_PASS = [
  { id: 'agent-accessibility-tree', title: 'Accessibility tree is well-formed', applicable: true, passed: true },
  { id: 'webmcp-schema-validity', title: 'WebMCP schemas are valid', applicable: true, passed: true },
  { id: 'cumulative-layout-shift', title: 'Cumulative Layout Shift', applicable: true, passed: true },
  { id: 'llms-txt', title: 'llms.txt follows recommendations', applicable: true, passed: true },
];

function page(overrides: Partial<Extract<PageAuditOutcome, { ok: true }>> = {}): PageAuditOutcome {
  return {
    url: 'https://www.mattpyle.com/',
    ok: true,
    scores: { performance: 100, accessibility: 100, seo: 100 },
    agenticChecks: ALL_CHECKS_PASS,
    axeViolations: 0,
    ...overrides,
  };
}

// --- all-green ---------------------------------------------------------

test('all-green: every metric passes', () => {
  const metrics = aggregate([page(), page({ url: 'b' })]);
  for (const m of metrics) assert.equal(m.status, 'Pass', `${m.name} expected Pass`);
  const perf = metrics.find((m) => m.name === 'Performance')!;
  assert.equal(perf.value, '100');
  const agentic = metrics.find((m) => m.name === 'Agentic Browsing')!;
  assert.equal(agentic.value, '4');
  assert.equal(agentic.maximum, '4');
  assert.match(agentic.description, /4 of 4 agent checks pass/);
});

// --- one-page-perf-92 ---------------------------------------------------

test('perf 92 on one page: Performance Partial, everything else still Pass', () => {
  const metrics = aggregate([page(), page({ scores: { performance: 92, accessibility: 100, seo: 100, 'agentic-browsing': 100 } })]);
  const perf = metrics.find((m) => m.name === 'Performance')!;
  assert.equal(perf.value, '92');
  assert.equal(perf.status, 'Partial');
  assert.equal(metrics.find((m) => m.name === 'Accessibility')!.status, 'Pass');
});

test('perf below 90 fails; the min across pages is what is shown', () => {
  const metrics = aggregate([page(), page({ scores: { performance: 84, accessibility: 100, seo: 100, 'agentic-browsing': 100 } })]);
  const perf = metrics.find((m) => m.name === 'Performance')!;
  assert.equal(perf.value, '84');
  assert.equal(perf.status, 'Fail');
});

// --- an axe violation -----------------------------------------------------

test('an axe violation on one page fails Accessibility even with a perfect Lighthouse score', () => {
  const metrics = aggregate([page(), page({ axeViolations: 2 })]);
  const a11y = metrics.find((m) => m.name === 'Accessibility')!;
  assert.equal(a11y.status, 'Fail');
  assert.match(a11y.description, /2 axe violations/);
});

// --- a tool-failure marker --------------------------------------------

test('a tool-failure marker blocks a green publish rather than being dropped', () => {
  const failed: PageAuditOutcome = { url: 'https://www.mattpyle.com/broken/', ok: false, error: 'Lighthouse timed out' };
  const metrics = aggregate([page(), failed]);
  for (const m of metrics) assert.equal(m.status, 'Fail', `${m.name} expected Fail on a tool failure`);
});

test('one check failing on one page: that check fails overall, others still pass (Partial)', () => {
  const flaky = page({
    agenticChecks: [
      { id: 'agent-accessibility-tree', title: 'Accessibility tree is well-formed', applicable: true, passed: false },
      { id: 'webmcp-schema-validity', title: 'WebMCP schemas are valid', applicable: true, passed: true },
      { id: 'cumulative-layout-shift', title: 'Cumulative Layout Shift', applicable: true, passed: true },
      { id: 'llms-txt', title: 'llms.txt follows recommendations', applicable: true, passed: true },
    ],
  });
  const metrics = aggregate([page(), flaky]);
  const agentic = metrics.find((m) => m.name === 'Agentic Browsing')!;
  assert.equal(agentic.value, '3');
  assert.equal(agentic.maximum, '4');
  assert.equal(agentic.status, 'Partial');
});

test('a check applicable on only a subset of pages is graded only over that subset', () => {
  const noWebmcp = page({
    agenticChecks: [
      { id: 'agent-accessibility-tree', title: 'Accessibility tree is well-formed', applicable: true, passed: true },
      { id: 'webmcp-schema-validity', title: 'WebMCP schemas are valid', applicable: false, passed: false },
      { id: 'cumulative-layout-shift', title: 'Cumulative Layout Shift', applicable: true, passed: true },
      { id: 'llms-txt', title: 'llms.txt follows recommendations', applicable: true, passed: true },
    ],
  });
  // WebMCP is applicable (and passing) on the other page, so it is still in J
  // and still counts as passed overall — the page where it doesn't apply
  // neither helps nor hurts it.
  const metrics = aggregate([page(), noWebmcp]);
  const agentic = metrics.find((m) => m.name === 'Agentic Browsing')!;
  assert.equal(agentic.value, '4');
  assert.equal(agentic.maximum, '4');
  assert.equal(agentic.status, 'Pass');
});

test('a check applicable nowhere is excluded from J entirely', () => {
  const neverApplicable = page({
    agenticChecks: [
      { id: 'agent-accessibility-tree', title: 'Accessibility tree is well-formed', applicable: true, passed: true },
      { id: 'webmcp-schema-validity', title: 'WebMCP schemas are valid', applicable: false, passed: false },
      { id: 'cumulative-layout-shift', title: 'Cumulative Layout Shift', applicable: true, passed: true },
      { id: 'llms-txt', title: 'llms.txt follows recommendations', applicable: true, passed: true },
    ],
  });
  const metrics = aggregate([neverApplicable]);
  const agentic = metrics.find((m) => m.name === 'Agentic Browsing')!;
  assert.equal(agentic.value, '3');
  assert.equal(agentic.maximum, '3');
  assert.equal(agentic.status, 'Pass');
});

test('a page that failed to audit fails every applicable check, status Fail', () => {
  const failed: PageAuditOutcome = { url: 'https://www.mattpyle.com/broken/', ok: false, error: 'Lighthouse timed out' };
  const metrics = aggregate([page(), failed]);
  const agentic = metrics.find((m) => m.name === 'Agentic Browsing')!;
  assert.equal(agentic.value, '0');
  assert.equal(agentic.maximum, '4');
  assert.equal(agentic.status, 'Fail');
});

// --- decidePublish -------------------------------------------------------

function metric(name: string, value: string, maximum: string, status: ScorecardMetric['status']): ScorecardMetric {
  return { name, value, maximum, status, description: '' };
}

function run(iso: string, metrics: ScorecardMetric[]): PublishableRun {
  return { iso, metrics };
}

const GREEN = [
  metric('Accessibility', '100', '100', 'Pass'),
  metric('Performance', '98', '100', 'Pass'),
  metric('SEO', '100', '100', 'Pass'),
  metric('Agentic Browsing', '3', '3', 'Pass'),
];

test('no published run yet: always opens a PR', () => {
  const decision = decidePublish(run('2026-07-22', GREEN), undefined, 7);
  assert.equal(decision.decision, 'open-pr');
});

test('unchanged and fresh: no-op', () => {
  const decision = decidePublish(run('2026-07-16', GREEN), run('2026-07-15', GREEN), 7);
  assert.equal(decision.decision, 'no-op');
});

test('unchanged but stale: opens a PR', () => {
  const decision = decidePublish(run('2026-07-25', GREEN), run('2026-07-15', GREEN), 7);
  assert.equal(decision.decision, 'open-pr');
  assert.match(decision.reason, /stale|old/);
});

test('a status flip opens a PR immediately, even if fresh', () => {
  const regressed = GREEN.map((m) => (m.name === 'Performance' ? metric('Performance', '80', '100', 'Fail') : m));
  const decision = decidePublish(run('2026-07-16', regressed), run('2026-07-15', GREEN), 7);
  assert.equal(decision.decision, 'open-pr');
  assert.match(decision.reason, /Performance/);
});

test('Performance below the noise threshold does not open a PR', () => {
  const wobble = GREEN.map((m) => (m.name === 'Performance' ? metric('Performance', '97', '100', 'Pass') : m));
  const decision = decidePublish(run('2026-07-16', wobble), run('2026-07-15', GREEN), 7);
  assert.equal(decision.decision, 'no-op');
});

test('Performance at or above the noise threshold opens a PR even without a status flip', () => {
  const moved = GREEN.map((m) => (m.name === 'Performance' ? metric('Performance', '95', '100', 'Pass') : m));
  const decision = decidePublish(run('2026-07-16', moved), run('2026-07-15', GREEN), 7);
  assert.equal(decision.decision, 'open-pr');
});

test('any pinned-metric move opens a PR, even without a status flip', () => {
  const moved = GREEN.map((m) => (m.name === 'Agentic Browsing' ? metric('Agentic Browsing', '2', '3', 'Partial') : m));
  const decision = decidePublish(run('2026-07-16', moved), run('2026-07-15', GREEN), 7);
  assert.equal(decision.decision, 'open-pr');
  assert.match(decision.reason, /Agentic Browsing/);
});

// --- validateCommentary (spec §5.1 rule 7) --------------------------------

test('validateCommentary passes a timeless, factual line', () => {
  const result = validateCommentary('Five live page types audited; all four public metrics passed.');
  assert.equal(result.ok, true);
  assert.deepEqual(result.matches, []);
});

test('validateCommentary flags "currently"', () => {
  const result = validateCommentary(
    'Currently published Scorecard baseline: five live page types audited, all four public metrics passing.',
  );
  assert.equal(result.ok, false);
  assert.ok(result.matches.includes('currently'));
});

test('validateCommentary flags "published baseline" / "current baseline" even without "currently"', () => {
  for (const phrase of ['the published baseline', 'the current baseline', 'the existing baseline']) {
    const result = validateCommentary(`This run replaces ${phrase}.`);
    assert.equal(result.ok, false, `expected "${phrase}" to be flagged`);
  }
});

test('validateCommentary does not flag a bare, historically-factual "baseline"', () => {
  const result = validateCommentary(
    'The first live-network baseline exposed a Performance regression hidden by localhost testing.',
  );
  assert.equal(result.ok, true);
});

test('validateCommentary flags "latest", "now", "today", and "at present"', () => {
  for (const word of ['latest', 'now', 'today', 'at present']) {
    const result = validateCommentary(`The ${word} run passed every metric.`);
    assert.equal(result.ok, false, `expected "${word}" to be flagged`);
  }
});

test('validateCommentary does not flag "now" or "baseline" as substrings of other words', () => {
  const result = validateCommentary('Nowhere on the baselined pipeline did a check regress.');
  assert.equal(result.ok, true);
});

test('every committed run-log commentary and metric description is timeless', async () => {
  const jsonPath = fileURLToPath(
    new URL('../../../../src/data/scorecard-runs.json', import.meta.url),
  );
  const runs = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as Array<{
    id: string;
    commentary: string;
    metrics: ScorecardMetric[];
  }>;
  assert.ok(runs.length > 0, 'expected at least one run in scorecard-runs.json');
  for (const run of runs) {
    const commentaryResult = validateCommentary(run.commentary);
    assert.ok(
      commentaryResult.ok,
      `run ${run.id} commentary reads as present-relative (found: ${commentaryResult.matches.join(', ')}): "${run.commentary}"`,
    );
    for (const m of run.metrics) {
      const descriptionResult = validateCommentary(m.description);
      assert.ok(
        descriptionResult.ok,
        `run ${run.id} ${m.name} description reads as present-relative (found: ${descriptionResult.matches.join(', ')}): "${m.description}"`,
      );
    }
  }
});
