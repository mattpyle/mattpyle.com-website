import { createRequire } from 'node:module';
import {
  excerpt,
  type CheckCategory,
  type CheckEvidence,
  type CheckMetric,
  type CheckResult,
  type CheckStatus,
  type DecisionClass,
  type Severity,
} from './result.js';
import { agenticChecks, type AgenticCheck, type AxeViolation, type LighthouseLike } from '../audit-map.js';

/**
 * The deep tier's arithmetic, separated from the browser that produces its
 * inputs.
 *
 * `deep.ts` renders pages and calls this; the per-page Temporal activity renders
 * one page and a later assembly activity calls this over all of them
 * (`workflows/audit-site.ts`). Both paths produce the same checks from the same
 * numbers, which is the property that keeps `steward audit-url` and a hosted
 * deep audit reporting one thing rather than two.
 *
 * Nothing here launches or imports a browser. Everything here is a pure function
 * of `RenderedPageOutcome`, which is the small, JSON-safe reduction of what
 * Lighthouse and axe returned — see its docblock for why the reduction happens at
 * the browser rather than here.
 */

/** Every deep check lives here. */
const CATEGORY: CheckCategory = 'rendered-experience';

/** Pages rendered per run, homepage included. Reported, never applied silently. */
export const DEFAULT_MAX_PAGES = 3;

/**
 * Wall-clock for one page: a Chrome launch, an axe run, and a Lighthouse run.
 *
 * Generous on purpose — the fast tier's 15s per-request cap is the right number
 * for one HTTP round trip and nowhere near enough for a browser rendering a
 * stranger's homepage. It is still bounded by the audit's shared budget, which
 * always wins: a page never starts unless the budget can pay for it.
 */
export const DEFAULT_PAGE_TIMEOUT_MS = 90_000;

/** Below this, the remaining budget cannot buy a page, so no page is started. */
export const MIN_PAGE_BUDGET_MS = 20_000;

/**
 * The floor a category score has to clear. Lighthouse's own boundary for a
 * "good" score, not a number invented here — see `deep.ts`'s module docblock on
 * why the scorecard's floor of 100 does not transfer to somebody else's site.
 *
 * Not applied to `agentic-browsing`: Chrome documents that category as a
 * fractional pass ratio with no weighted 0–100 score, so `agenticCheck` grades
 * its sub-audits instead.
 */
export const SCORE_FLOOR = 90;

interface AxisSpec {
  /** The Lighthouse category id. */
  key: string;
  id: string;
  title: string;
  /** Two or three words for the headline tile the HTML report leads with. */
  label: string;
  severity: Severity;
  /** How settled this check's subject is. See `DecisionClass` in result.ts. */
  decisionClass: DecisionClass;
}

/**
 * The Lighthouse categories reported as checks, and how hard each one is ranked.
 *
 * Severity is about agent readiness, not about web quality in general.
 * Accessibility is the highest because the accessibility tree is literally what
 * an agent reads off the page; `agentic-browsing` is Lighthouse 13's own
 * category for this, so it is here for the same reason. Best-practices is low:
 * it is real, and it is the least likely of the four to be why an agent came
 * away with nothing.
 *
 * Decision class is a second, independent axis (see `DecisionClass`): it says how
 * confidently a stranger can be told to act on a finding, not how hard the
 * finding bites. Accessibility is the one axis that is both high severity and a
 * proven blocker, because the accessibility tree is what an agent reads. The
 * other four are measured numbers whose link to any one agent journey is an
 * inference, which is a different claim and is graded as one.
 */
const AXES: AxisSpec[] = [
  {
    key: 'agentic-browsing',
    id: 'lighthouse-agentic-browsing',
    title: "Every applicable Lighthouse Agentic Browsing check passes on the sampled pages",
    label: 'Agentic browsing',
    severity: 'high',
    // Lighthouse 13's own category for this, and brand new. Graded per
    // sub-audit now, and each sub-audit is still a check Chrome describes as
    // written while agentic-web standards are emerging: an llms.txt or a WebMCP
    // schema is a convention, not a proven blocker.
    decisionClass: 'emergingConvention',
  },
  {
    key: 'accessibility',
    id: 'lighthouse-accessibility',
    title: 'Lighthouse accessibility clears 90 on the sampled pages',
    label: 'Accessibility',
    severity: 'high',
    // The accessibility tree is literally what a browser agent reads off the
    // page. A defect here is measured, not inferred, on any site.
    decisionClass: 'provenBlocker',
  },
  {
    key: 'seo',
    id: 'lighthouse-seo',
    title: 'Lighthouse SEO clears 90 on the sampled pages',
    label: 'SEO',
    severity: 'medium',
    // Settled practice with broad agreement. Not a blocker: a page an agent
    // already has the URL for renders whatever its SEO score says.
    decisionClass: 'bestPractice',
  },
  {
    key: 'performance',
    id: 'lighthouse-performance',
    title: 'Lighthouse performance clears 90 on the sampled pages',
    label: 'Performance',
    severity: 'medium',
    // A slow page can exhaust a budgeted fetcher, but that is an inference from
    // a number rather than an observed refusal. Established practice, not proof.
    decisionClass: 'bestPractice',
  },
  {
    key: 'best-practices',
    id: 'lighthouse-best-practices',
    title: 'Lighthouse best-practices clears 90 on the sampled pages',
    label: 'Best practices',
    severity: 'low',
    // Established web practice by construction; that is what the category is.
    decisionClass: 'bestPractice',
  },
];

/** The Lighthouse category keys this tier reports, in report order. */
export const AXIS_KEYS: readonly string[] = AXES.map((a) => a.key);

const AXE_CHECK = {
  id: 'axe-violations',
  title: 'axe-core finds no accessibility violations on the sampled pages',
  severity: 'high' as Severity,
  // Named defects in the rendered tree, each one reproducible on the page it was
  // found on. The most directly observed finding this tier produces.
  decisionClass: 'provenBlocker' as DecisionClass,
};

// ---------------------------------------------------------------------------
// What one rendered page reduces to
// ---------------------------------------------------------------------------

/**
 * One axe violation, reduced to the three fields the report ever quotes.
 *
 * A raw `AxeViolation` carries every matched node with its outer HTML, and a
 * Lighthouse result is megabytes. Neither may travel: when the deep tier runs as
 * a per-page Temporal activity, that value goes into workflow history and back
 * out again to the assembly activity, and history is not a place to put a
 * browser's raw output. The reduction happens where the browser is, so the large
 * value never leaves the process that made it.
 */
export interface ReducedViolation {
  id: string;
  impact: string | null;
  /** How many elements the rule fired on. */
  nodes: number;
}

/**
 * Everything the checks below need to know about one sampled page.
 *
 * JSON by construction: no `Error`, no `Date`, no class instance, because this
 * crosses an activity boundary. `null` on a field means the tool produced no
 * value for it, and the paired `*Error` string says why.
 */
export interface RenderedPageOutcome {
  url: string;
  /**
   * Lighthouse's category scores, 0–100, keyed by `AXIS_KEYS`. `null` for the
   * whole object means Lighthouse produced no result at all; `null` for one key
   * means it ran and did not score that category (an older Lighthouse has no
   * `agentic-browsing`).
   */
  scores: Record<string, number | null> | null;
  lighthouseVersion: string | null;
  lighthouseError: string | null;
  /**
   * The page's graded Agentic Browsing sub-audits, as `agenticChecks` in
   * `audit-map.ts` returns them. `null` when Lighthouse produced no result; an
   * empty array when it ran without the category.
   *
   * Optional on read: an outcome recorded in workflow history before this field
   * existed has no such key, and it still has to assemble.
   */
  agenticChecks?: AgenticCheck[] | null;
  violations: ReducedViolation[] | null;
  axeError: string | null;
  /** True when both tools failed and both failures were this page running out of time. */
  timedOut: boolean;
  /**
   * What the address guard refused the browser while this page rendered. Empty
   * on the usual page; see `blockedNotes`.
   */
  blocked: BlockedRequests;
}

/** A page that was never rendered, and why. */
export interface SkippedPage {
  url: string;
  reason: string;
  /** True when the site refused the auditor, rather than the auditor failing. */
  robots: boolean;
}

/** Reduces a Lighthouse result to the scores, agentic checks and version the checks quote. */
export function reduceLighthouse(lhr: LighthouseLike): {
  scores: Record<string, number | null>;
  agenticChecks: AgenticCheck[];
  version: string;
} {
  const scores: Record<string, number | null> = {};
  for (const key of AXIS_KEYS) {
    const score = lhr.categories?.[key]?.score;
    scores[key] = typeof score === 'number' ? Math.round(score * 100) : null;
  }
  return { scores, agenticChecks: agenticChecks(lhr), version: lhr.lighthouseVersion ?? 'unknown version' };
}

/** Reduces axe's violations to the rule, impact and element count evidence quotes. */
export function reduceViolations(violations: AxeViolation[]): ReducedViolation[] {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    nodes: (v.nodes ?? []).length,
  }));
}

/** The versions quoted in evidence. Read from the installed packages, not guessed. */
export function toolVersions(): { axe: string } {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('axe-core/package.json') as { version?: string };
    return { axe: pkg.version ?? 'unknown version' };
  } catch {
    return { axe: 'unknown version' };
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function check(
  spec: { id: string; title: string; severity: Severity; decisionClass: DecisionClass },
  status: CheckStatus,
  observed: string,
  evidence: CheckEvidence[] = [],
  fix?: string,
  metric?: CheckMetric,
): CheckResult {
  return {
    ...spec,
    category: CATEGORY,
    status,
    observed,
    evidence,
    ...(fix ? { fix } : {}),
    // Only the branches that actually measured something carry a number. An
    // `error` or a `not-applicable` has none, and inventing a zero would put a
    // failing-looking tile at the top of a report about a browser that never ran.
    ...(metric ? { metric } : {}),
  };
}

export interface AssembleInput {
  /** The pages a browser was actually pointed at, in the order they were rendered. */
  pages: RenderedPageOutcome[];
  /** The pages in the sample that were never rendered, and why. */
  skipped: SkippedPage[];
  /** How many pages were in the sample: rendered plus skipped. */
  sampled: number;
  /** Set when the browser itself never produced a result, so later pages were abandoned. */
  browserFailure: string | null;
  axeVersion: string;
}

/**
 * The rendered-experience checks, from the reduced per-page outcomes.
 *
 * Six checks always, whatever happened: five Lighthouse axes and axe-core. A run
 * where no browser started returns six `error` checks rather than none, because
 * a missing check reads as a category nobody looked at and an `error` says the
 * auditor could not reach a verdict.
 */
export function assembleDeepChecks(input: AssembleInput): CheckResult[] {
  const { pages, skipped, sampled, browserFailure, axeVersion } = input;
  return [
    ...AXES.map((axis) =>
      axis.key === 'agentic-browsing'
        ? agenticCheck(axis, pages, skipped, browserFailure, sampled)
        : axisCheck(axis, pages, skipped, browserFailure, sampled),
    ),
    axeCheck(pages, skipped, browserFailure, sampled, axeVersion),
  ];
}

/**
 * The shared "there is nothing to report a score about" branch.
 *
 * `fallback` is the case where pages *were* rendered and this particular tool
 * still produced nothing — a Lighthouse that died on every page while axe ran
 * fine. Only the caller knows which tool it is asking about, so only the caller
 * can word it.
 */
function noVerdict(
  spec: { id: string; title: string; severity: Severity; decisionClass: DecisionClass },
  skipped: SkippedPage[],
  browserFailure: string | null,
  sampled: number,
  fallback: { observed: string; evidence: CheckEvidence[] },
): CheckResult {
  if (browserFailure) {
    return check(
      spec,
      'error',
      `not measured — the browser did not produce a result: ${excerpt(browserFailure, 200)}`,
      [{ note: browserFailure }],
    );
  }
  if (sampled === 0) {
    return check(spec, 'not-applicable', 'no page was available to render — the fast tier found none to sample');
  }
  if (skipped.length > 0 && skipped.every((s) => s.robots)) {
    return check(
      spec,
      'not-applicable',
      'every sampled page is disallowed to this auditor by robots.txt',
      skipped.map((s) => ({ url: s.url, note: s.reason })),
    );
  }
  return check(spec, 'error', fallback.observed, [
    ...fallback.evidence,
    ...skipped.map((s) => ({ url: s.url, note: s.reason })),
  ]);
}

/**
 * The "nothing was measured" line, worded from what actually happened.
 *
 * Every rendered page timing out and the tool dying on every page are both "no
 * result", and a reader deciding whether to re-run with a longer budget or to go
 * and fix their machine needs to be told which one it was.
 */
function nothingMeasured(pages: RenderedPageOutcome[], tool: string): string {
  if (pages.length > 0 && pages.every((r) => r.timedOut)) {
    return `not measured — every rendered page ran out of its slice of the time budget before ${tool} finished`;
  }
  return `not measured — ${tool} produced no result for any rendered page`;
}

function axisCheck(
  axis: AxisSpec,
  pages: RenderedPageOutcome[],
  skipped: SkippedPage[],
  browserFailure: string | null,
  sampled: number,
): CheckResult {
  const spec = { id: axis.id, title: axis.title, severity: axis.severity, decisionClass: axis.decisionClass };
  const metricOf = (value: number, count: number): CheckMetric => ({
    label: axis.label,
    value,
    unit: 'score',
    pages: count,
  });
  const scored = pages
    .filter((r) => r.scores)
    .map((r) => ({
      url: r.url,
      version: r.lighthouseVersion ?? 'unknown version',
      score: (r.scores as Record<string, number | null>)[axis.key] ?? null,
    }));

  const failedToRun = pages.filter((r) => !r.scores);
  if (scored.length === 0) {
    return noVerdict(spec, skipped, browserFailure, sampled, {
      observed: nothingMeasured(pages, 'Lighthouse'),
      evidence: failedToRun.map((r) => ({
        url: r.url,
        note: r.lighthouseError ?? 'Lighthouse produced no result',
      })),
    });
  }
  const evidence: CheckEvidence[] = [
    ...scored.map((s) => ({
      url: s.url,
      note:
        s.score === null
          ? `Lighthouse ${s.version} did not score the "${axis.key}" category for this page`
          : `Lighthouse ${s.version}: ${axis.key} ${s.score}`,
    })),
    ...failedToRun.map((r) => ({ url: r.url, note: r.lighthouseError ?? 'Lighthouse produced no result' })),
    ...skipped.map((s) => ({ url: s.url, note: s.reason })),
  ];

  const withScores = scored.filter((s) => typeof s.score === 'number') as Array<{ url: string; score: number }>;
  if (withScores.length === 0) {
    // Lighthouse ran and did not score this category for any page.
    return check(
      spec,
      'not-applicable',
      `Lighthouse ran but returned no "${axis.key}" score for any sampled page`,
      evidence,
    );
  }

  const worst = withScores.reduce((a, b) => (a.score <= b.score ? a : b));
  const listing = withScores.map((s) => `${new URL(s.url).pathname} ${s.score}`).join(', ');
  if (worst.score >= SCORE_FLOOR) {
    return check(
      spec,
      'pass',
      `${axis.key} ${worst.score} or better on all ${withScores.length} rendered page(s): ${listing}`,
      evidence,
      undefined,
      // The worst page, not the mean: the headline answers "what does an agent
      // get here at its worst", which is the same question the pass/fail asks.
      metricOf(worst.score, withScores.length),
    );
  }
  return check(
    spec,
    'fail',
    `${axis.key} scored ${worst.score} on ${new URL(worst.url).pathname}, below 90 ` +
      `(${withScores.length} page(s) rendered: ${listing})`,
    evidence,
    axisFix(axis.key),
    metricOf(worst.score, withScores.length),
  );
}

/**
 * The Agentic Browsing axis, graded as the pass ratio Chrome defines it as.
 *
 * Chrome's scoring page says the category "does not have a weighted average
 * score from 0 to 100" and reports "a fractional score" instead, so this check
 * reads the graded sub-audits (`agenticChecks` in `audit-map.ts`, the same
 * extraction /scorecard renders) rather than the category's `score`.
 *
 * Per page it reports `passed/applicable` and names each failing sub-audit. It
 * passes when every applicable sub-audit passes on every page that had one. A
 * page where no sub-audit applied is said to be that, and counts toward neither
 * verdict: nothing was graded on it.
 */
function agenticCheck(
  axis: AxisSpec,
  pages: RenderedPageOutcome[],
  skipped: SkippedPage[],
  browserFailure: string | null,
  sampled: number,
): CheckResult {
  const spec = { id: axis.id, title: axis.title, severity: axis.severity, decisionClass: axis.decisionClass };
  const ran = pages.filter((r) => r.scores);
  const failedToRun = pages.filter((r) => !r.scores);
  if (ran.length === 0) {
    return noVerdict(spec, skipped, browserFailure, sampled, {
      observed: nothingMeasured(pages, 'Lighthouse'),
      evidence: failedToRun.map((r) => ({
        url: r.url,
        note: r.lighthouseError ?? 'Lighthouse produced no result',
      })),
    });
  }

  const graded = ran.map((r) => {
    const version = r.lighthouseVersion ?? 'unknown version';
    // `undefined` is an outcome recorded before the field existed; it carries no
    // sub-audits to grade, which is a different fact from a category that is absent.
    const checks = r.agenticChecks ?? null;
    const applicable = (checks ?? []).filter((c) => c.applicable);
    const failing = applicable.filter((c) => !c.passed);
    return { url: r.url, version, checks, applicable: applicable.length, passed: applicable.length - failing.length, failing };
  });

  const noteFor = (g: (typeof graded)[number]): string => {
    if (g.checks === null) return `Lighthouse ${g.version}: no Agentic Browsing sub-audits were recorded for this page`;
    if (g.checks.length === 0) return `Lighthouse ${g.version} did not report the "agentic-browsing" category for this page`;
    if (g.applicable === 0) return `Lighthouse ${g.version}: agentic-browsing has 0 applicable checks on this page`;
    const failing = g.failing.length > 0 ? ` — failing: ${g.failing.map((c) => c.title).join('; ')}` : '';
    return `Lighthouse ${g.version}: agentic-browsing ${g.passed}/${g.applicable} checks passed${failing}`;
  };
  const evidence: CheckEvidence[] = [
    ...graded.map((g) => ({ url: g.url, note: noteFor(g) })),
    ...failedToRun.map((r) => ({ url: r.url, note: r.lighthouseError ?? 'Lighthouse produced no result' })),
    ...skipped.map((s) => ({ url: s.url, note: s.reason })),
  ];

  const scored = graded.filter((g) => g.applicable > 0);
  if (scored.length === 0) {
    const anyCategory = graded.some((g) => g.checks !== null && g.checks.length > 0);
    return check(
      spec,
      'not-applicable',
      anyCategory
        ? `Lighthouse ran but no "agentic-browsing" check applied to any sampled page`
        : `Lighthouse ran but returned no "agentic-browsing" checks for any sampled page`,
      evidence,
    );
  }

  const path = (url: string) => new URL(url).pathname;
  const unscored = graded.filter((g) => g.applicable === 0);
  const unscoredNote =
    unscored.length > 0 ? `; no applicable checks on ${unscored.map((g) => path(g.url)).join(', ')}` : '';
  const listing = scored.map((g) => `${path(g.url)} ${g.passed}/${g.applicable}`).join(', ');
  // The worst page, as the other axes report: the lowest share passed, and on a
  // tie the page with more failures.
  const worst = scored.reduce((a, b) => {
    const ra = a.passed / a.applicable;
    const rb = b.passed / b.applicable;
    return rb < ra || (rb === ra && b.failing.length > a.failing.length) ? b : a;
  });
  const metric: CheckMetric = {
    label: axis.label,
    value: worst.passed,
    unit: 'ratio',
    outOf: worst.applicable,
    pages: scored.length,
  };

  const failingPages = scored.filter((g) => g.failing.length > 0);
  if (failingPages.length === 0) {
    return check(
      spec,
      'pass',
      `every applicable agentic-browsing check passed on all ${scored.length} scored page(s): ${listing}${unscoredNote}`,
      evidence,
      undefined,
      metric,
    );
  }
  const failures = failingPages
    .map((g) => `${path(g.url)} ${g.passed}/${g.applicable} (failing: ${g.failing.map((c) => c.title).join('; ')})`)
    .join(', ');
  const failingTitles = [...new Set(failingPages.flatMap((g) => g.failing.map((c) => c.title)))];
  return check(
    spec,
    'fail',
    `agentic-browsing checks failed on ${failingPages.length} of ${scored.length} scored page(s): ${failures}${unscoredNote}`,
    evidence,
    agenticFix(failingTitles),
    metric,
  );
}

function agenticFix(failing: string[]): string {
  return (
    "Lighthouse's Agentic Browsing category is a set of pass/fail checks, not a weighted score: " +
    'it checks that the page exposes a usable accessibility tree, that the layout does not shift ' +
    'under an agent mid-read, that llms.txt is there, and that any WebMCP tools have valid schemas. ' +
    `The failing ${failing.length === 1 ? 'check is' : 'checks are'} ${failing.map((t) => `"${t}"`).join(', ')}; ` +
    'run Lighthouse against the page yourself for the details behind each one.'
  );
}

function axisFix(key: string): string {
  const shared =
    'Run Lighthouse against the page yourself for the audit list behind the score — the number is ' +
    'the summary, the failing audits are the work.';
  switch (key) {
    case 'accessibility':
      return (
        'An agent reads the page through the accessibility tree, so this score is not only about ' +
        'assistive technology: unlabelled controls, missing alt text and unnamed landmarks are ' +
        `missing information for every non-visual reader, human or not. ${shared}`
      );
    case 'seo':
      return (
        'The SEO audits cover the machine-readable basics an agent depends on too — a title, a ' +
        'meta description, crawlable links, a valid canonical, and not being blocked from ' +
        `indexing. ${shared}`
      );
    case 'performance':
      return (
        'A slow page is a page an agent may abandon: most fetchers hold a hard timeout in the ' +
        'single-digit seconds, and a page that renders its content client-side after that is a ' +
        `blank page to them. ${shared}`
      );
    default:
      return `${shared} Best-practices covers console errors, deprecated APIs and insecure requests.`;
  }
}

function axeCheck(
  pages: RenderedPageOutcome[],
  skipped: SkippedPage[],
  browserFailure: string | null,
  sampled: number,
  axeVersion: string,
): CheckResult {
  const ran = pages.filter((r) => r.violations !== null);
  if (ran.length === 0) {
    return noVerdict(AXE_CHECK, skipped, browserFailure, sampled, {
      observed: nothingMeasured(pages, 'axe'),
      evidence: pages.map((r) => ({ url: r.url, note: r.axeError ?? 'axe produced no result' })),
    });
  }

  const evidence: CheckEvidence[] = [
    ...ran.map((r) => {
      const violations = r.violations as ReducedViolation[];
      const rules = violations
        .map((v) => `${v.id}${v.impact ? ` (${v.impact})` : ''} × ${v.nodes}`)
        .join(', ');
      return {
        url: r.url,
        note: `axe-core ${axeVersion}: ${violations.length} violation(s)${rules ? ` — ${rules}` : ''}`,
      };
    }),
    ...pages
      .filter((r) => r.violations === null)
      .map((r) => ({ url: r.url, note: r.axeError ?? 'axe produced no result' })),
    ...skipped.map((s) => ({ url: s.url, note: s.reason })),
  ];

  const total = ran.reduce((n, r) => n + (r.violations as ReducedViolation[]).length, 0);
  // A count, not a score: zero is the good end of this one, and a renderer that
  // colours it needs to be told that rather than to guess from the name.
  const metric: CheckMetric = {
    label: 'axe violations',
    value: total,
    unit: 'count',
    pages: ran.length,
  };
  if (total === 0) {
    return check(
      AXE_CHECK,
      'pass',
      `axe-core ${axeVersion} found no violations on ${ran.length} rendered page(s)`,
      evidence,
      undefined,
      metric,
    );
  }
  const pagesWith = ran.filter((r) => (r.violations as ReducedViolation[]).length > 0).length;
  return check(
    AXE_CHECK,
    'fail',
    `axe-core ${axeVersion} found ${total} violation(s) on ${pagesWith} of ${ran.length} rendered page(s)`,
    evidence,
    'Each violation names the rule and the elements that broke it; the rule ids in the evidence ' +
      "link to axe-core's own explanation of what to change. These are the automatable subset of " +
      'WCAG, so a clean run is a floor rather than a pass mark — but a violation here is a fact ' +
      'about the page, not a judgement call, and an agent reading the page through the ' +
      'accessibility tree hits the same missing names and labels a screen reader does.',
    metric,
  );
}

// ---------------------------------------------------------------------------
// The run-level notes
// ---------------------------------------------------------------------------

/**
 * The notes a deep run adds about its own coverage. Shared for the same reason
 * the checks are: the in-process tier and the activity-per-page tier must say
 * the same things about the same run, and a second copy of this wording is a
 * second thing to keep in step.
 *
 * Split into two calls rather than one because the per-page notes a run writes
 * as it goes — a browser that never started, a page that outran its slice — sit
 * *between* these two in the finished document, and that order is what a reader
 * follows.
 */

/**
 * Said out loud, per the same rule the sitemap and llms.txt caps follow: a tier
 * that stopped looking has to report that it stopped looking.
 */
export function capNote(available: number, sampled: number): string | null {
  if (available <= sampled) return null;
  return (
    `Deep tier: ${available} page(s) were available to sample and the first ` +
    `${sampled} were rendered (the cap).`
  );
}

/** What was rendered, then why each unrendered page was not. */
export function coverageNotes(input: {
  sample: string[];
  rendered: number;
  skipped: SkippedPage[];
}): string[] {
  const notes: string[] = [];
  if (input.sample.length > 0) {
    notes.push(
      `Deep tier: rendered ${input.rendered} of ${input.sample.length} sampled page(s) — ` +
        `${input.sample.map((u) => new URL(u).pathname).join(', ')}.`,
    );
  }
  for (const s of input.skipped) {
    notes.push(`Deep tier: ${s.url} was not rendered — ${s.reason}`);
  }
  return notes;
}

/** How many refused requests are named individually before the note summarises. */
export const MAX_BLOCKED_LISTED = 10;

/**
 * What the address guard stopped the browser fetching, as run-level notes.
 *
 * Reported rather than swallowed, for the same reason the page cap is: a page
 * whose subresources were refused rendered differently from the page its owner
 * sees, and a score measured on it means something slightly different. The
 * reader is owed both facts.
 *
 * `listed` is already bounded where the requests were seen, because in the
 * per-page-activity path this value travels through workflow history and a page
 * that trips the guard on every subresource must not put thousands of URLs
 * there. `total` is what keeps the summary line honest about the ones dropped.
 */
export interface BlockedRequests {
  listed: Array<{ url: string; reason: string }>;
  total: number;
}

export function blockedNotes(blocked: BlockedRequests): string[] {
  if (blocked.total === 0) return [];
  const listed = blocked.listed.slice(0, MAX_BLOCKED_LISTED);
  const lines = listed.map((b) => `Deep tier: the browser was refused ${b.url} — ${b.reason}`);
  if (blocked.total > listed.length) {
    lines.push(
      `Deep tier: ${blocked.total - listed.length} further request(s) from the rendered ` +
        'pages were refused by the address guard and are not listed individually.',
    );
  }
  return lines;
}

/** Merges the per-page refusals of a fan-out run into one run-level tally. */
export function mergeBlocked(pages: Array<{ blocked: BlockedRequests }>): BlockedRequests {
  return {
    listed: pages.flatMap((p) => p.blocked.listed).slice(0, MAX_BLOCKED_LISTED),
    total: pages.reduce((n, p) => n + p.blocked.total, 0),
  };
}
