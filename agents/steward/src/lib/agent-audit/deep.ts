import { createRequire } from 'node:module';
import { assertConnectableUrl, BlockedTargetError, type FetchPolicy } from './safe-fetch.js';
import {
  excerpt,
  type CheckCategory,
  type CheckEvidence,
  type CheckResult,
  type CheckStatus,
  type Severity,
} from './result.js';
import type { AxeViolation, LighthouseLike } from '../audit-map.js';

/**
 * The deep tier of `audit-url`: what a browser actually gets, rather than what
 * the site says about itself over HTTP.
 *
 * Lighthouse and axe against a small sample of the site's own pages, reported as
 * checks in the same canonical schema the fast tier writes. The tools are the
 * scorecard's — `runLighthouse` and `runAxe` from `lib/audit-engine.ts`, same
 * flags, same versions — so a number here and a number on /scorecard mean the
 * same thing. The *thresholds* are this tier's own: the scorecard holds this
 * site to a floor of 100 because it is this site, and holding a stranger's site
 * to that would report every site on the internet as failing. Lighthouse's own
 * published boundary for "good", 90, is the floor here.
 *
 * ## The subresource gap in the SSRF guard
 *
 * Stated rather than papered over, the same way `safe-fetch.ts` states DNS
 * rebinding. **The address guard only covers the top-level URL.** Every page
 * this module hands to Chrome is resolved and classified first, by the same
 * `assertConnectableUrl` the fetcher uses, and a page inside a private range is
 * refused before Chrome is launched. But a rendered page pulls in subresources —
 * images, scripts, stylesheets, `fetch()` from its own JavaScript — and Chrome
 * requests those itself, having consulted nothing here. A page that references
 * `http://169.254.169.254/latest/meta-data/` will have Chrome fetch it, and a
 * page that then reads the response and reports it back into the DOM can put
 * whatever it found in front of whoever runs this.
 *
 * That is an acceptable risk for a local CLI a person points at a site they
 * chose: the operator already trusts their own browser with the same URL, and
 * the audit runs on their machine, inside their own network, at their request.
 * It is **not** acceptable once stage 2 hosts this and the caller is a stranger,
 * because then the network being probed is the host's. Closing it means running
 * Chrome behind a proxy that classifies every request, or in a network namespace
 * with no route to anything private. Recorded on the `hosted-mcp-server` card as
 * a stage-2 precondition alongside DNS rebinding; a blocker for hosting, not for
 * this slice.
 */

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

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
const MIN_PAGE_BUDGET_MS = 20_000;

/**
 * The floor a category score has to clear. Lighthouse's own boundary for a
 * "good" score, not a number invented here — see the module docblock on why the
 * scorecard's floor of 100 does not transfer to somebody else's site.
 */
export const SCORE_FLOOR = 90;

interface AxisSpec {
  /** The Lighthouse category id. */
  key: string;
  id: string;
  title: string;
  severity: Severity;
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
 */
const AXES: AxisSpec[] = [
  {
    key: 'agentic-browsing',
    id: 'lighthouse-agentic-browsing',
    title: "Lighthouse's Agentic Browsing score clears 90 on the sampled pages",
    severity: 'high',
  },
  {
    key: 'accessibility',
    id: 'lighthouse-accessibility',
    title: 'Lighthouse accessibility clears 90 on the sampled pages',
    severity: 'high',
  },
  {
    key: 'seo',
    id: 'lighthouse-seo',
    title: 'Lighthouse SEO clears 90 on the sampled pages',
    severity: 'medium',
  },
  {
    key: 'performance',
    id: 'lighthouse-performance',
    title: 'Lighthouse performance clears 90 on the sampled pages',
    severity: 'medium',
  },
  {
    key: 'best-practices',
    id: 'lighthouse-best-practices',
    title: 'Lighthouse best-practices clears 90 on the sampled pages',
    severity: 'low',
  },
];

const AXE_CHECK = {
  id: 'axe-violations',
  title: 'axe-core finds no accessibility violations on the sampled pages',
  severity: 'high' as Severity,
};

// ---------------------------------------------------------------------------
// Injection points
// ---------------------------------------------------------------------------

/**
 * The two tool invocations, injectable so the tests can run the whole tier — the
 * sampling, the caps, the budget, the Chrome-unavailable path — without a
 * browser. The default implementation is the scorecard's.
 */
export interface DeepRunners {
  lighthouse(url: string, timeoutMs: number): Promise<LighthouseLike>;
  axe(url: string, timeoutMs: number): Promise<AxeViolation[]>;
}

export interface DeepOptions {
  maxPages?: number;
  pageTimeoutMs?: number;
  runners?: DeepRunners;
}

/** What the deep tier needs from the audit around it. */
export interface DeepContext {
  /** Page URLs worth rendering, homepage first, before the cap is applied. */
  candidates: string[];
  /** Milliseconds left in the audit's one shared time budget. */
  remainingMs(): number;
  /** The fetch policy, so the address guard runs with the audit's own settings. */
  policy: FetchPolicy;
  /** `null` when the auditor may fetch this URL; the deciding rule when it may not. */
  robotsDetail(url: string): Promise<string | null>;
}

function defaultRunners(): DeepRunners {
  return {
    async lighthouse(url, timeoutMs) {
      const { runLighthouse } = await import('../audit-engine.js');
      // `maxWaitForLoad` is Lighthouse's own give-up timer. It is what keeps a
      // page that never finishes loading from holding the run open: the outer
      // race below reports the timeout, but only this stops Chrome waiting.
      return runLighthouse(url, new AbortController().signal, { maxWaitForLoad: timeoutMs });
    },
    async axe(url, timeoutMs) {
      const { runAxe } = await import('../audit-engine.js');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`axe exceeded ${timeoutMs}ms`)), timeoutMs);
      try {
        return (await runAxe(url, controller.signal)).violations;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The versions quoted in evidence. Read from the installed packages, not guessed. */
function toolVersions(): { axe: string } {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('axe-core/package.json') as { version?: string };
    return { axe: pkg.version ?? 'unknown version' };
  } catch {
    return { axe: 'unknown version' };
  }
}

/**
 * Bounds a tool run that does not take a deadline of its own.
 *
 * `runLighthouse` is the case: it accepts an `AbortSignal` for symmetry and does
 * not wire it into the Lighthouse call, which was never cancellable mid-run. A
 * losing race leaves Chrome to be torn down by `runLighthouse`'s own `finally`
 * when the underlying run eventually settles, which `maxWaitForLoad` guarantees
 * it does. What the race buys is that the *audit* does not wait for it.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} exceeded ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** One sampled page's outcome. `null` on either tool means it did not produce one. */
interface PageResult {
  url: string;
  lhr: LighthouseLike | null;
  lighthouseError: string | null;
  violations: AxeViolation[] | null;
  axeError: string | null;
}

/** A page that was never rendered, and why. */
interface SkippedPage {
  url: string;
  reason: string;
  /** True when the site refused the auditor, rather than the auditor failing. */
  robots: boolean;
}

function check(
  spec: { id: string; title: string; severity: Severity },
  status: CheckStatus,
  observed: string,
  evidence: CheckEvidence[] = [],
  fix?: string,
): CheckResult {
  return { ...spec, category: CATEGORY, status, observed, evidence, ...(fix ? { fix } : {}) };
}

export interface DeepOutcome {
  checks: CheckResult[];
  notes: string[];
  /** Pages a browser was actually launched against. Part of the run's cost line. */
  renderedPages: number;
}

/**
 * Runs the deep tier and returns its checks plus any run-level notes.
 *
 * Never throws. A refused page, a browser that will not start and a spent budget
 * are all reported: `error` for the auditor failing to reach a verdict,
 * `not-applicable` for a page the site told it not to look at. The fast tier's
 * results are already written by the time this runs and are never disturbed by
 * anything in here.
 */
export async function runDeepChecks(ctx: DeepContext, opts: DeepOptions = {}): Promise<DeepOutcome> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const pageTimeoutMs = opts.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const runners = opts.runners ?? defaultRunners();
  const versions = toolVersions();

  const notes: string[] = [];
  const sample = ctx.candidates.slice(0, maxPages);
  if (ctx.candidates.length > sample.length) {
    // Said out loud, per the same rule the sitemap and llms.txt caps follow: a
    // tier that stopped looking has to report that it stopped looking.
    notes.push(
      `Deep tier: ${ctx.candidates.length} page(s) were available to sample and the first ` +
        `${sample.length} were rendered (the cap). The scores below describe those pages, not the site.`,
    );
  }

  const results: PageResult[] = [];
  const skipped: SkippedPage[] = [];
  let browserFailure: string | null = null;

  for (const url of sample) {
    // Checked before anything that costs a request: with no budget left there is
    // no point resolving the name either.
    const remaining = ctx.remainingMs();
    if (remaining < MIN_PAGE_BUDGET_MS) {
      skipped.push({
        url,
        reason:
          `the audit's shared time budget had ${(remaining / 1000).toFixed(1)}s left, ` +
          `less than the ${MIN_PAGE_BUDGET_MS / 1000}s a page needs`,
        robots: false,
      });
      continue;
    }

    const robots = await ctx.robotsDetail(url);
    if (robots) {
      skipped.push({ url, reason: robots, robots: true });
      continue;
    }
    // The top-level URL goes through the same resolve-and-classify path the
    // fetcher uses, because Chrome is about to navigate to it on its own. The
    // subresources it then pulls in are the documented gap — see the docblock.
    try {
      await assertConnectableUrl(url, ctx.policy);
    } catch (err) {
      skipped.push({
        url,
        reason: err instanceof BlockedTargetError ? err.reason : String(err),
        robots: false,
      });
      continue;
    }

    // Both tools share the page's slice, and the slice never outlives the audit.
    const slice = Math.min(pageTimeoutMs, ctx.remainingMs());

    const page: PageResult = { url, lhr: null, lighthouseError: null, violations: null, axeError: null };
    const started = Date.now();
    try {
      page.violations = await withDeadline(runners.axe(url, slice), slice, 'axe');
    } catch (err) {
      page.axeError = err instanceof Error ? err.message : String(err);
    }
    const left = Math.max(0, slice - (Date.now() - started));
    if (left <= 0) {
      page.lighthouseError = 'no time left in this page\'s slice of the budget after axe';
    } else {
      try {
        page.lhr = await withDeadline(runners.lighthouse(url, left), left, 'Lighthouse');
      } catch (err) {
        page.lighthouseError = err instanceof Error ? err.message : String(err);
      }
    }
    results.push(page);

    // A browser that will not start fails identically on every page, so trying
    // the other two spends the budget to learn the same thing three times.
    if (results.length === 1 && !page.lhr && page.violations === null) {
      browserFailure = page.lighthouseError ?? page.axeError ?? 'the browser produced no result';
      notes.push(
        `Deep tier: neither tool produced a result for the first sampled page (${excerpt(browserFailure, 160)}), ` +
          'so the remaining pages were not attempted. The fast-tier checks above are unaffected.',
      );
      break;
    }
  }

  if (sample.length > 0) {
    notes.push(
      `Deep tier: rendered ${results.length} of ${sample.length} sampled page(s) — ` +
        `${sample.map((u) => new URL(u).pathname).join(', ')}.`,
    );
  }
  for (const s of skipped) {
    notes.push(`Deep tier: ${s.url} was not rendered — ${s.reason}`);
  }

  const checks = [
    ...AXES.map((axis) => axisCheck(axis, results, skipped, browserFailure, sample.length)),
    axeCheck(results, skipped, browserFailure, sample.length, versions.axe),
  ];
  return { checks, notes, renderedPages: results.length };
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
  spec: { id: string; title: string; severity: Severity },
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

function axisCheck(
  axis: AxisSpec,
  results: PageResult[],
  skipped: SkippedPage[],
  browserFailure: string | null,
  sampled: number,
): CheckResult {
  const spec = { id: axis.id, title: axis.title, severity: axis.severity };
  const scored = results
    .filter((r) => r.lhr)
    .map((r) => ({
      url: r.url,
      version: r.lhr?.lighthouseVersion ?? 'unknown version',
      score: categoryScore(r.lhr as LighthouseLike, axis.key),
    }));

  const failedToRun = results.filter((r) => !r.lhr);
  if (scored.length === 0) {
    return noVerdict(spec, skipped, browserFailure, sampled, {
      observed: 'not measured — Lighthouse produced no result for any rendered page',
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
    // Lighthouse ran and did not score this category — `agentic-browsing` on a
    // Lighthouse older than 13, or a category that did not apply to the page.
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
    );
  }
  return check(
    spec,
    'fail',
    `${axis.key} scored ${worst.score} on ${new URL(worst.url).pathname}, below 90 ` +
      `(${withScores.length} page(s) rendered: ${listing})`,
    evidence,
    axisFix(axis.key),
  );
}

function categoryScore(lhr: LighthouseLike, key: string): number | null {
  const score = lhr.categories?.[key]?.score;
  return typeof score === 'number' ? Math.round(score * 100) : null;
}

function axisFix(key: string): string {
  const shared =
    'Run Lighthouse against the page yourself for the audit list behind the score — the number is ' +
    'the summary, the failing audits are the work.';
  switch (key) {
    case 'agentic-browsing':
      return (
        "Lighthouse 13's Agentic Browsing category is the one written for this: it checks that the " +
        'page exposes a usable accessibility tree, that the layout does not shift under an agent ' +
        'mid-read, and that llms.txt is there. It is the closest thing to a second opinion on this ' +
        `whole report. ${shared}`
      );
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
  results: PageResult[],
  skipped: SkippedPage[],
  browserFailure: string | null,
  sampled: number,
  axeVersion: string,
): CheckResult {
  const ran = results.filter((r) => r.violations !== null);
  if (ran.length === 0) {
    return noVerdict(AXE_CHECK, skipped, browserFailure, sampled, {
      observed: 'not measured — axe produced no result for any rendered page',
      evidence: results.map((r) => ({ url: r.url, note: r.axeError ?? 'axe produced no result' })),
    });
  }

  const evidence: CheckEvidence[] = [
    ...ran.map((r) => {
      const violations = r.violations as AxeViolation[];
      const rules = violations
        .map((v) => `${v.id}${v.impact ? ` (${v.impact})` : ''} × ${(v.nodes ?? []).length}`)
        .join(', ');
      return {
        url: r.url,
        note: `axe-core ${axeVersion}: ${violations.length} violation(s)${rules ? ` — ${rules}` : ''}`,
      };
    }),
    ...results
      .filter((r) => r.violations === null)
      .map((r) => ({ url: r.url, note: r.axeError ?? 'axe produced no result' })),
    ...skipped.map((s) => ({ url: s.url, note: s.reason })),
  ];

  const total = ran.reduce((n, r) => n + (r.violations as AxeViolation[]).length, 0);
  if (total === 0) {
    return check(AXE_CHECK, 'pass', `axe-core ${axeVersion} found no violations on ${ran.length} rendered page(s)`, evidence);
  }
  const pagesWith = ran.filter((r) => (r.violations as AxeViolation[]).length > 0).length;
  return check(
    AXE_CHECK,
    'fail',
    `axe-core ${axeVersion} found ${total} violation(s) on ${pagesWith} of ${ran.length} rendered page(s)`,
    evidence,
    'Each violation names the rule and the elements that broke it; the rule ids in the evidence ' +
      'link to axe-core\'s own explanation of what to change. These are the automatable subset of ' +
      'WCAG, so a clean run is a floor rather than a pass mark — but a violation here is a fact ' +
      'about the page, not a judgement call, and an agent reading the page through the ' +
      'accessibility tree hits the same missing names and labels a screen reader does.',
  );
}
