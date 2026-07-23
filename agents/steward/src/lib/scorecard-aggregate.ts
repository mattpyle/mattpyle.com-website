/**
 * Aggregation, thresholds, and the publish decision for the Scorecard system
 * (scorecard-audit-spec.md §5.3, §6). Pure — no I/O, no Temporal, no clock —
 * so it is unit-testable against canned fixtures and safe to call from
 * workflow code (spec §8: "pure in the workflow").
 *
 * **Never import `FLOORS` from `lib/audit-map.ts` here (design rule 6).** The
 * Steward's build-audit floors (Perf 90) and the Scorecard's floors (Perf 95)
 * answer different questions on different environments (spec §2) and must
 * never be allowed to converge by accident.
 */

export type ScorecardStatus = 'Pass' | 'Partial' | 'Fail';

export interface ScorecardMetric {
  name: string;
  value: string;
  maximum: string;
  status: ScorecardStatus;
  description: string;
}

/**
 * One page's audit outcome, as the Scorecard sees it — a thin, tool-agnostic
 * projection of `audit-engine.ts`'s `RawAudit`, plus the tool-failure case
 * (rule 4) that `RawAudit` itself has no room for (it either resolves or the
 * caller's activity threw).
 */
export type PageAuditOutcome =
  | {
      url: string;
      ok: true;
      scores: Record<string, number>;
      /** Present only when Lighthouse still returns Agentic Browsing as an audit *group* (see audit-map.ts's comment on `AGENTIC_AUDITS`) rather than a scored category. */
      agenticBrowsing?: { passed: number; total: number };
      axeViolations: number;
    }
  | {
      url: string;
      ok: false;
      /** Why the tool failed to produce a result for this URL, after retries. */
      error: string;
    };

/**
 * The current fallback framing when no page returns the Agentic Browsing
 * audit *group* — i.e. the normal case on the Lighthouse version pinned here,
 * where it is a scored *category* instead (audit-map.ts's `AGENTIC_AUDITS`
 * comment: "the first live audit returned `categories['agentic-browsing'].score
 * = 1`... The category path is therefore the real one"). Matches the
 * currently-published card's "3 of 3" framing (spec §5.3: "reported as a
 * ratio, matching the current card") without pretending to know which three
 * checks a future audit-group revival would actually name.
 */
const AGENTIC_CATEGORY_FALLBACK_MAXIMUM = 3;

interface NormalizedPage {
  scores: Record<string, number>;
  agenticBrowsing?: { passed: number; total: number };
  axeViolations: number;
}

/**
 * A failed tool-run becomes the worst possible result for every category
 * (rule 4) — scores of 0, a violation on the books, an agentic ratio of
 * 0-of-fallback — rather than a special case threaded through every
 * threshold below. `min`-across-pages then does the blocking on its own: a
 * page that could not be audited can never let the Scorecard show green.
 */
function normalize(page: PageAuditOutcome): NormalizedPage {
  if (!page.ok) {
    return {
      scores: { performance: 0, accessibility: 0, seo: 0, 'agentic-browsing': 0 },
      agenticBrowsing: { passed: 0, total: AGENTIC_CATEGORY_FALLBACK_MAXIMUM },
      axeViolations: 1,
    };
  }
  return {
    scores: page.scores,
    agenticBrowsing: page.agenticBrowsing,
    axeViolations: page.axeViolations,
  };
}

function min(values: number[]): number {
  return values.length ? Math.min(...values) : 0;
}

/**
 * Aggregates every audited page into the four public Scorecard metrics
 * (spec §5.3), by the page's own stated rule: the lowest result across the
 * tested pages, for every category (design rule 5).
 */
export function aggregate(perPage: PageAuditOutcome[]): ScorecardMetric[] {
  const pages = perPage.map(normalize);
  const pageCount = perPage.length;

  // --- Accessibility: min Lighthouse a11y AND 0 axe violations -----------
  const a11yScores = pages.map((p) => p.scores.accessibility ?? 0);
  const minA11y = min(a11yScores);
  const totalAxeViolations = pages.reduce((n, p) => n + p.axeViolations, 0);
  const accessibility: ScorecardMetric = {
    name: 'Accessibility',
    value: String(minA11y),
    maximum: '100',
    status: minA11y === 100 && totalAxeViolations === 0 ? 'Pass' : 'Fail',
    description:
      totalAxeViolations > 0
        ? `${totalAxeViolations} axe violation${totalAxeViolations === 1 ? '' : 's'} across ${pageCount} tested page${pageCount === 1 ? '' : 's'}.`
        : `The lowest Lighthouse accessibility score across ${pageCount} tested page${pageCount === 1 ? '' : 's'}. No automated WCAG violations.`,
  };

  // --- Performance: min Lighthouse perf, with a Partial band -------------
  const perfScores = pages.map((p) => p.scores.performance ?? 0);
  const minPerf = min(perfScores);
  const performance: ScorecardMetric = {
    name: 'Performance',
    value: String(minPerf),
    maximum: '100',
    status: minPerf >= 95 ? 'Pass' : minPerf >= 90 ? 'Partial' : 'Fail',
    description: `The lowest Lighthouse performance score across ${pageCount} tested page${pageCount === 1 ? '' : 's'}.`,
  };

  // --- SEO: min Lighthouse seo, binary -----------------------------------
  const seoScores = pages.map((p) => p.scores.seo ?? 0);
  const minSeo = min(seoScores);
  const seo: ScorecardMetric = {
    name: 'SEO',
    value: String(minSeo),
    maximum: '100',
    status: minSeo === 100 ? 'Pass' : 'Fail',
    description: `The lowest Lighthouse SEO score across ${pageCount} tested page${pageCount === 1 ? '' : 's'}.`,
  };

  // --- Agentic Browsing: a ratio, pooled worst-case across pages ----------
  const agentic = aggregateAgentic(pages, pageCount);

  return [accessibility, performance, seo, agentic];
}

/**
 * Agentic Browsing as a ratio (spec §5.3). Two source shapes, handled
 * separately because they answer different questions:
 *
 * - **The audit-group ratio** (`page.agenticBrowsing`), when Lighthouse
 *   returns individual named audits. Pooled per audit id, worst-case
 *   across pages (rule 5's "lowest across pages" generalised to pass/fail):
 *   an audit only counts as passed overall if it passed on every page it
 *   applied to.
 * - **The category score** (`page.scores['agentic-browsing']`), the shape
 *   the pinned Lighthouse version actually returns. Reported as "how many of
 *   the N tested pages scored the maximum", which is a ratio in the same
 *   spirit without inventing per-audit detail that was never computed.
 */
function aggregateAgentic(pages: NormalizedPage[], pageCount: number): ScorecardMetric {
  const withGroupRatio = pages.filter((p) => p.agenticBrowsing !== undefined);

  if (withGroupRatio.length > 0) {
    // Pool every page's agentic ratio into "N of M page-audits passed".
    // (Per-audit-id union pooling would need the audit ids themselves, which
    // `PageAuditOutcome` does not carry — the group shape only ever appears
    // in tests/fixtures today, so this stays a coarse, honest pass count
    // rather than a precision this codebase cannot currently back up.)
    const passed = withGroupRatio.reduce((n, p) => n + (p.agenticBrowsing!.passed === p.agenticBrowsing!.total ? 1 : 0), 0);
    const total = withGroupRatio.length;
    return {
      name: 'Agentic Browsing',
      value: String(passed),
      maximum: String(total),
      status: passed === total ? 'Pass' : passed === 0 ? 'Fail' : 'Partial',
      description: `${passed} of ${total} tested pages passed every applicable Lighthouse Agentic Browsing audit.`,
    };
  }

  // Category-score fallback (the normal live case).
  const perfectPages = pages.filter((p) => (p.scores['agentic-browsing'] ?? 0) === 100).length;
  return {
    name: 'Agentic Browsing',
    value: String(perfectPages),
    maximum: String(pageCount || AGENTIC_CATEGORY_FALLBACK_MAXIMUM),
    status: perfectPages === pageCount ? 'Pass' : perfectPages === 0 ? 'Fail' : 'Partial',
    description: `${perfectPages} of ${pageCount} tested pages scored the maximum Lighthouse Agentic Browsing category score.`,
  };
}

// ---------------------------------------------------------------------------
// The publish policy (spec §6).
// ---------------------------------------------------------------------------

export interface PublishableRun {
  iso: string;
  metrics: ScorecardMetric[];
}

/**
 * The public run-log record shape (scorecard-audit-spec.md §5.1) — one entry
 * in `src/data/scorecard-runs.json`. Defined here, alongside the pure
 * aggregation it is built from, so both `activities/scorecard.ts` and
 * `workflows/scorecard-audit.ts` import the identical contract.
 */
export interface ScorecardRunRecord extends PublishableRun {
  id: string;
  /** Full ISO 8601 audit time, when available. */
  timestamp?: string;
  scope: string;
  tools: string[];
  entry: string;
  commentary: string;
}

export interface PublishDecision {
  decision: 'open-pr' | 'no-op';
  reason: string;
}

/** Performance is the one metric with lab variance; everything else is meant to be pinned (spec §6). */
const PERFORMANCE_NOISE_THRESHOLD = 3;

/**
 * Whether `candidate` is worth a human's attention over `published` (spec
 * §6): a status flip or (for Performance) a move past the noise threshold,
 * on ANY metric, opens a PR immediately — a regression must never wait for
 * the weekly staleness PR. Otherwise, only staleness does.
 */
function hasChanged(candidate: ScorecardMetric[], published: ScorecardMetric[]): string | undefined {
  for (const next of candidate) {
    const prev = published.find((m) => m.name === next.name);
    if (!prev) return `${next.name} is a new metric`;

    if (next.status !== prev.status) {
      return `${next.name} ${prev.status}→${next.status}`;
    }

    const prevValue = Number(prev.value);
    const nextValue = Number(next.value);
    if (Number.isNaN(prevValue) || Number.isNaN(nextValue)) continue;

    if (next.name === 'Performance') {
      const delta = Math.abs(nextValue - prevValue);
      if (delta >= PERFORMANCE_NOISE_THRESHOLD) return `Performance ${prev.value}→${next.value}`;
    } else if (nextValue !== prevValue) {
      // A11y / SEO / Agentic are meant to be pinned — any move is news.
      return `${next.name} ${prev.value}/${prev.maximum}→${next.value}/${next.maximum}`;
    }
  }
  return undefined;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00.000Z`).getTime();
  const to = new Date(`${toIso}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

/**
 * `decidePublish` (spec §6): open a PR iff the run changed anything worth
 * seeing, or the published run has gone stale — otherwise no-op. `candidate`
 * carries its own `iso` (from `workflow.now()` in the caller), which doubles
 * as "now" for the staleness check — there is no separate clock here, this
 * module is pure.
 */
export function decidePublish(
  candidate: PublishableRun,
  published: PublishableRun | undefined,
  maxAgeDays: number,
): PublishDecision {
  if (!published) {
    return { decision: 'open-pr', reason: 'no published run exists yet' };
  }

  const changeReason = hasChanged(candidate.metrics, published.metrics);
  if (changeReason) {
    return { decision: 'open-pr', reason: changeReason };
  }

  const ageDays = daysBetween(published.iso, candidate.iso);
  if (ageDays > maxAgeDays) {
    return {
      decision: 'open-pr',
      reason: `unchanged, but published run is ${ageDays}d old (> ${maxAgeDays}d staleness threshold)`,
    };
  }

  return {
    decision: 'no-op',
    reason: `unchanged, published ${ageDays}d ago (<= ${maxAgeDays}d threshold)`,
  };
}
