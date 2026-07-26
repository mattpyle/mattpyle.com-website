import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregate,
  checkAuditSet,
  decidePublish,
  parsePageCount,
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

// ---------------------------------------------------------------------------
// The audit-set guard (spec §5.4) — canned counts, no browser, no network.
// ---------------------------------------------------------------------------

function guard(overrides: Partial<Parameters<typeof checkAuditSet>[0]> = {}) {
  return checkAuditSet({
    resolvedCount: 19,
    previousCount: 18,
    overridden: false,
    allowShrink: false,
    ...overrides,
  });
}

test('audit-set guard: an equal set passes', () => {
  const result = guard({ resolvedCount: 18, previousCount: 18 });
  assert.equal(result.ok, true);
  assert.match(result.reason, /18 URL\(s\) resolved \(previous run: 18\)/);
});

test('audit-set guard: a larger set passes — new pages are the normal case', () => {
  const result = guard({ resolvedCount: 19, previousCount: 18 });
  assert.equal(result.ok, true);
});

test('audit-set guard: a smaller set fails, and the reason names both counts', () => {
  const result = guard({ resolvedCount: 17, previousCount: 18 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /17 URL\(s\) vs 18/);
  assert.match(result.reason, /--allow-shrink/);
});

test('audit-set guard: an empty set fails', () => {
  const result = guard({ resolvedCount: 0, previousCount: 18 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/);
});

test('audit-set guard: --allow-shrink lets the same smaller set through', () => {
  const result = guard({ resolvedCount: 17, previousCount: 18, allowShrink: true });
  assert.equal(result.ok, true);
  assert.match(result.reason, /allowed by --allow-shrink/);
});

test('audit-set guard: an empty set fails past both overrides — it has no legitimate form', () => {
  for (const overrides of [{ allowShrink: true }, { overridden: true }, { allowShrink: true, overridden: true }]) {
    const result = guard({ resolvedCount: 0, previousCount: 18, ...overrides });
    assert.equal(result.ok, false, `expected empty to fail with ${JSON.stringify(overrides)}`);
  }
});

test('audit-set guard: --urls skips the shrink check entirely', () => {
  const result = guard({ resolvedCount: 1, previousCount: 18, overridden: true });
  assert.equal(result.ok, true);
  assert.match(result.reason, /shrink check skipped/);
});

test('audit-set guard: no previous count is not a failure — there is nothing to compare against', () => {
  const result = guard({ resolvedCount: 19, previousCount: undefined });
  assert.equal(result.ok, true);
  assert.match(result.reason, /no previous run page count/);
});

test('parsePageCount reads the leading integer out of a scope string', () => {
  assert.equal(parsePageCount('18 live pages'), 18);
  assert.equal(parsePageCount('1 live page'), 1);
  assert.equal(parsePageCount('5 live page types'), 5);
});

test('parsePageCount returns undefined for a scope it cannot read, rather than guessing', () => {
  assert.equal(parsePageCount(undefined), undefined);
  assert.equal(parsePageCount(''), undefined);
  assert.equal(parsePageCount('every live page'), undefined);
});

test('the committed run-log\'s newest scope is parseable — the guard has a real baseline', async () => {
  const jsonPath = fileURLToPath(new URL('../../../../src/data/scorecard-runs.json', import.meta.url));
  const runs = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as Array<{ id: string; scope: string }>;
  const count = parsePageCount(runs[0].scope);
  assert.ok(
    typeof count === 'number' && count > 0,
    `newest run ${runs[0].id} has an unparseable scope ("${runs[0].scope}"), so the shrink guard would silently skip`,
  );
});

// ---------------------------------------------------------------------------
// The publish gate's third trigger (spec §6): what was measured changed, even
// when none of the four numbers did.
// ---------------------------------------------------------------------------

const TOOLS = ['Lighthouse 13.4', 'axe-core 4.12'];

/** A candidate/published pair that is identical apart from the overrides. */
function measured(iso: string, scope: string, tools: string[] = TOOLS): PublishableRun {
  return { iso, metrics: GREEN, scope, tools };
}

test('coverage growing opens a PR, even with every metric unchanged and the run fresh', () => {
  const decision = decidePublish(
    measured('2026-07-16', '19 live pages'),
    measured('2026-07-15', '18 live pages'),
    7,
  );
  assert.equal(decision.decision, 'open-pr');
  assert.equal(decision.reason, 'Coverage 18→19 pages');
});

test('coverage shrinking opens a PR too — any difference is news, in either direction', () => {
  const decision = decidePublish(
    measured('2026-07-16', '17 live pages'),
    measured('2026-07-15', '18 live pages'),
    7,
  );
  assert.equal(decision.decision, 'open-pr');
  assert.equal(decision.reason, 'Coverage 18→17 pages');
});

test('identical coverage and tools still no-op when fresh', () => {
  const decision = decidePublish(
    measured('2026-07-16', '18 live pages'),
    measured('2026-07-15', '18 live pages'),
    7,
  );
  assert.equal(decision.decision, 'no-op');
});

test('rewording scope without changing the count does not open a PR', () => {
  // The comparison is on the parsed count, not the raw string — an editorial
  // tweak to the wording is not a change in what was measured.
  const decision = decidePublish(
    measured('2026-07-16', '18 live pages audited'),
    measured('2026-07-15', '18 live pages'),
    7,
  );
  assert.equal(decision.decision, 'no-op');
});

test('an unparseable scope on either side skips the coverage check rather than guessing', () => {
  const fromUnparseable = decidePublish(
    measured('2026-07-16', '19 live pages'),
    measured('2026-07-15', 'every live page'),
    7,
  );
  assert.equal(fromUnparseable.decision, 'no-op');

  const toUnparseable = decidePublish(
    measured('2026-07-16', 'every live page'),
    measured('2026-07-15', '18 live pages'),
    7,
  );
  assert.equal(toUnparseable.decision, 'no-op');
});

test('a tool version bump opens a PR — it changes what "100" means', () => {
  const decision = decidePublish(
    measured('2026-07-16', '18 live pages', ['Lighthouse 13.5', 'axe-core 4.12']),
    measured('2026-07-15', '18 live pages', ['Lighthouse 13.4', 'axe-core 4.12']),
    7,
  );
  assert.equal(decision.decision, 'open-pr');
  assert.match(decision.reason, /^Tools .*13\.4.*→.*13\.5/);
});

test('reordering the tools list is not a change', () => {
  const decision = decidePublish(
    measured('2026-07-16', '18 live pages', ['axe-core 4.12', 'Lighthouse 13.4']),
    measured('2026-07-15', '18 live pages', ['Lighthouse 13.4', 'axe-core 4.12']),
    7,
  );
  assert.equal(decision.decision, 'no-op');
});

test('a missing tools list on either side skips the tools check', () => {
  const decision = decidePublish(
    { iso: '2026-07-16', metrics: GREEN, scope: '18 live pages' },
    measured('2026-07-15', '18 live pages'),
    7,
  );
  assert.equal(decision.decision, 'no-op');
});

test('entry is deliberately not part of the gate', () => {
  // `entry` flips with how the run was triggered, not with what was measured.
  // Gating on it would open a PR every time a human ran the audit by hand.
  const candidate = { ...measured('2026-07-16', '18 live pages'), entry: 'Manual · intentional' };
  const published = { ...measured('2026-07-15', '18 live pages'), entry: 'Nightly · automated' };
  assert.equal(decidePublish(candidate, published, 7).decision, 'no-op');
});

test('a moved number outranks a coverage change in the stated reason', () => {
  // Both changed. The reason becomes the PR title and the commentary's delta,
  // so the number has to win — it is the more important thing to say.
  const regressed = GREEN.map((m) => (m.name === 'SEO' ? metric('SEO', '90', '100', 'Fail') : m));
  const decision = decidePublish(
    { iso: '2026-07-16', metrics: regressed, scope: '19 live pages', tools: TOOLS },
    measured('2026-07-15', '18 live pages'),
    7,
  );
  assert.equal(decision.decision, 'open-pr');
  assert.match(decision.reason, /^SEO /);
});

test('a coverage change outranks staleness in the stated reason', () => {
  const decision = decidePublish(
    measured('2026-08-30', '19 live pages'),
    measured('2026-07-15', '18 live pages'),
    7,
  );
  assert.equal(decision.decision, 'open-pr');
  assert.equal(decision.reason, 'Coverage 18→19 pages');
});
