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

import type { AgenticCheck } from './audit-map.js';

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
      /** The four real Agentic Browsing checks for this page (audit-map.ts's `agenticChecks`) — accessibility tree, layout stability, llms.txt, WebMCP schema validity. */
      agenticChecks: AgenticCheck[];
      axeViolations: number;
    }
  | {
      url: string;
      ok: false;
      /** Why the tool failed to produce a result for this URL, after retries. */
      error: string;
    };

interface NormalizedPage {
  scores: Record<string, number>;
  axeViolations: number;
}

/**
 * A failed tool-run becomes the worst possible result for every numeric
 * category (rule 4) — scores of 0, a violation on the books — rather than a
 * special case threaded through every threshold below. `min`-across-pages
 * then does the blocking on its own: a page that could not be audited can
 * never let the Scorecard show green. Agentic Browsing is handled separately
 * by `aggregateAgentic`, which needs the `ok` flag itself (a failed page
 * fails every applicable check, not a synthesized ratio).
 */
function normalize(page: PageAuditOutcome): NormalizedPage {
  if (!page.ok) {
    return {
      scores: { performance: 0, accessibility: 0, seo: 0 },
      axeViolations: 1,
    };
  }
  return {
    scores: page.scores,
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

  // --- Agentic Browsing: K of J checks pass, worst-across-pages -----------
  const agentic = aggregateAgentic(perPage);

  return [accessibility, performance, seo, agentic];
}

/** Short, human labels for the known checks. Falls back to the Lighthouse audit title (or id) for any check this map hasn't caught up with yet — a future Lighthouse addition/removal to the category must never make the description blank. */
const AGENTIC_CHECK_LABELS: Record<string, string> = {
  'agent-accessibility-tree': 'accessibility tree',
  'cumulative-layout-shift': 'layout stability',
  'llms-txt': 'llms.txt',
  'webmcp-schema-validity': 'WebMCP',
};

/**
 * Agentic Browsing as "K of J checks pass" (spec §5.3), aggregated
 * worst-across-pages (design rule 5) over the real per-page checks
 * (audit-map.ts's `agenticChecks`) rather than a page-count proxy.
 *
 * - **J (the applicable set)** — every check id that was `applicable` on at
 *   least one successfully-audited page. A check applicable on only a subset
 *   of pages (e.g. WebMCP schema validity, which only applies where a page
 *   actually registers tools) is still counted in J from that subset alone —
 *   it is graded only over the pages it applied to, so a page where it does
 *   not apply can neither help nor hurt it. This is what keeps "4/4" honest
 *   when applicability differs page to page, per the spec's requirement to
 *   decide and document that rule.
 * - **A check passes overall** iff it passed on every page where it was
 *   applicable — the same "worst case across pages" the numeric metrics use,
 *   generalised to pass/fail.
 * - **A page that failed to audit (rule 4) fails every check in J** — a
 *   crashed or unreachable page must never let a check quietly sit out of
 *   the count instead of dragging it down.
 */
function aggregateAgentic(perPage: PageAuditOutcome[]): ScorecardMetric {
  const anyPageFailed = perPage.some((p) => !p.ok);
  const okPages = perPage.filter((p): p is Extract<PageAuditOutcome, { ok: true }> => p.ok);

  const byId = new Map<string, { title: string; applicableOnAnyPage: boolean; passedEverywhereApplicable: boolean }>();
  for (const page of okPages) {
    for (const check of page.agenticChecks) {
      const entry = byId.get(check.id) ?? {
        title: AGENTIC_CHECK_LABELS[check.id] ?? check.title ?? check.id,
        applicableOnAnyPage: false,
        passedEverywhereApplicable: true,
      };
      if (check.applicable) {
        entry.applicableOnAnyPage = true;
        if (!check.passed) entry.passedEverywhereApplicable = false;
      }
      byId.set(check.id, entry);
    }
  }

  const applicable = [...byId.values()].filter((v) => v.applicableOnAnyPage);
  const J = applicable.length;
  const passing = anyPageFailed ? [] : applicable.filter((v) => v.passedEverywhereApplicable);
  const K = passing.length;

  const status: ScorecardStatus = anyPageFailed || K === 0 ? 'Fail' : K === J ? 'Pass' : 'Partial';
  const names = applicable.map((v) => v.title);
  const description =
    J === 0
      ? 'No Agentic Browsing checks were applicable on any successfully audited page.'
      : anyPageFailed
        ? `${K} of ${J} agent checks pass: ${names.join(', ')} — at least one page failed to audit, which fails every check by design.`
        : `${K} of ${J} agent checks pass: ${names.join(', ')}.`;

  return {
    name: 'Agentic Browsing',
    value: String(K),
    maximum: String(J),
    status,
    description,
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

// ---------------------------------------------------------------------------
// Commentary validation (spec §5.1 rule 7): a run's commentary must read
// correctly forever, not just at the moment it was published.
// ---------------------------------------------------------------------------

/**
 * Words that describe the commentary's position in the run list ("currently
 * the latest," "as of now") rather than a fact about the run itself.
 * Case-insensitive, whole-word — flags "Currently" but not
 * "current-ly-published-scorecard.tsx". Tunable: add a word here if a new
 * present-relative phrasing slips through, never remove one to let a
 * specific commentary pass.
 *
 * **"baseline" is deliberately not a bare word here.** A run can factually
 * describe itself as "the first live-network baseline" forever — that is a
 * permanent fact about *that run*, not a claim about what's currently
 * published. What must never appear is "baseline" doing duty for "the
 * currently-published one" (`current baseline`, `published baseline`),
 * which `PRESENT_RELATIVE_PHRASES` below catches without flagging the
 * legitimate historical label. ("Currently published Scorecard baseline," the
 * stale line this guard exists to catch, is still caught by "currently"
 * alone.)
 */
const PRESENT_RELATIVE_WORDS = ['currently', 'latest', 'now', 'today', 'at present'];

/** Multi-word phrasings that mean "the one currently in effect" without using any single word above. */
const PRESENT_RELATIVE_PHRASES = ['current baseline', 'published baseline', 'existing baseline'];

const PRESENT_RELATIVE_PATTERN = new RegExp(
  `\\b(${[...PRESENT_RELATIVE_WORDS, ...PRESENT_RELATIVE_PHRASES]
    .map((w) => w.replace(/\s+/g, '\\s+'))
    .join('|')})\\b`,
  'i',
);

export interface CommentaryValidation {
  ok: boolean;
  /** The present-relative words found, lowercased, in the order they appear. */
  matches: string[];
}

/**
 * Flags a commentary (or per-metric `description`) string that reads as
 * relative to *when it was written* rather than stating what the run
 * measured. Not a grammar check — a commentary can still be wrong in other
 * ways this does not catch; it only catches the specific failure mode rule 7
 * exists to prevent (scorecard-build-log.md's 15-Jul "Currently published...
 * baseline" line).
 */
export function validateCommentary(text: string): CommentaryValidation {
  const matches = [...text.matchAll(new RegExp(PRESENT_RELATIVE_PATTERN, 'gi'))].map((m) => m[0].toLowerCase());
  return { ok: matches.length === 0, matches };
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
