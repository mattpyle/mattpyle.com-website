import {
  assertConnectableUrl,
  AUDIT_USER_AGENT,
  BlockedTargetError,
  type FetchPolicy,
} from './safe-fetch.js';
import { startVettingProxy, type VettingProxy } from './vetting-proxy.js';
import { excerpt, type CheckResult } from './result.js';
import {
  assembleDeepChecks,
  blockedNotes,
  capNote,
  coverageNotes,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_TIMEOUT_MS,
  MAX_BLOCKED_LISTED,
  MIN_PAGE_BUDGET_MS,
  reduceLighthouse,
  reduceViolations,
  toolVersions,
  type BlockedRequests,
  type RenderedPageOutcome,
  type SkippedPage,
} from './deep-assemble.js';
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
 * This file owns the browser. The arithmetic that turns what the browser said
 * into checks lives in `deep-assemble.ts`, because a second caller runs one page
 * per Temporal activity and assembles the checks somewhere else entirely
 * (`workflows/audit-site.ts`). `renderPage` below is the unit both share.
 *
 * ## One identity across three clients
 *
 * Both browsers send `AUDIT_USER_AGENT`, the same string the fast tier's fetcher
 * sends. Three different HTTP clients make the requests of one audit, and from
 * the audited site's logs they are one visitor: a person looking at their access
 * log sees a single product token, and the `steward-audit` robots.txt token
 * that refuses the fast tier refuses the rendered pages too. An auditor that
 * arrived under Chrome's own UA for the expensive half would be unattributable
 * for exactly the requests that cost the site the most.
 *
 * ## How the address guard reaches the requests Chrome makes
 *
 * **Every request of a rendered page is vetted, not only the URL handed over.**
 * That takes two things, because they cover different moments:
 *
 * 1. The sampled page is resolved and classified before Chrome starts, by the
 *    same `assertConnectableUrl` the fetcher uses, so a page inside a private
 *    range is refused without spending a browser launch and the refusal reads as
 *    a fact about that page.
 * 2. Chrome runs behind `vetting-proxy.ts`: launched with `--proxy-server`, with
 *    the loopback bypass removed, and with non-proxied WebRTC UDP disabled,
 *    every request it makes — subresources, `fetch()` calls, and the target of
 *    any redirect the page answers with — arrives at a proxy that classifies the
 *    address and pins the upstream socket to it. A refused request comes back as
 *    a 403 to the page and as a line in the audit's notes. The proxy's docblock
 *    is the place that says precisely what "every request" covers and what the
 *    WebRTC flag is doing there.
 *
 * Those were two separate open gaps (subresources, and top-level redirects) and
 * they closed together, which was always the expectation: a proxy sees the
 * redirect hop and the subresource alike, because both are just requests.
 *
 * The proxy is what fits the machine this runs on. A Linux network namespace
 * with no route to anything private is the other way to do it and is not
 * available on the Windows desktop the worker uses. The cost is that a proxy
 * sits in the path of every request Lighthouse measures; the delta that adds to
 * the scores is measured and recorded in the build log rather than assumed to be
 * nothing.
 *
 * What the proxy does not do is re-check robots.txt for a redirect target. See
 * its docblock: robots governs which pages this tier chooses to sample, and it
 * is not the thing standing between a stranger's URL and the host's network.
 */

export {
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_TIMEOUT_MS,
  MIN_PAGE_BUDGET_MS,
  SCORE_FLOOR,
} from './deep-assemble.js';

// ---------------------------------------------------------------------------
// Injection points
// ---------------------------------------------------------------------------

/**
 * The two tool invocations, injectable so the tests can run the whole tier — the
 * sampling, the caps, the budget, the Chrome-unavailable path — without a
 * browser. The default implementation is the scorecard's.
 *
 * `proxy` is not optional to either real runner: a browser launched without
 * those flags reaches the network directly, which is the gap this tier closed.
 * A test runner ignores it, or asserts on it to hold the wiring in place.
 */
export interface DeepRunners {
  lighthouse(url: string, timeoutMs: number, proxy: VettingProxy): Promise<LighthouseLike>;
  axe(url: string, timeoutMs: number, proxy: VettingProxy): Promise<AxeViolation[]>;
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

export function defaultRunners(): DeepRunners {
  return {
    async lighthouse(url, timeoutMs, proxy) {
      const { runLighthouse } = await import('../audit-engine.js');
      // `maxWaitForLoad` is Lighthouse's own give-up timer. It is what keeps a
      // page that never finishes loading from holding the run open: the outer
      // race below reports the timeout, but only this stops Chrome waiting.
      //
      // The identity goes on twice, because Lighthouse sends requests from two
      // places: `emulatedUserAgent` for the page it renders, and the launch flag
      // for the fetches its own gatherers make (robots.txt and llms.txt, for the
      // SEO and agentic-browsing audits). Setting only the first left those two
      // arriving as `HeadlessChrome`, which was found by pointing this at a
      // server that logged what it was asked by whom.
      //
      // It costs something real — a site that serves a different page to a
      // non-browser UA is measured on that page — and that is the right trade
      // here. An agent arriving at the site gets the same treatment, so the page
      // the auditor is shown is the page the audit is about.
      return runLighthouse(url, new AbortController().signal, {
        flags: { maxWaitForLoad: timeoutMs, emulatedUserAgent: AUDIT_USER_AGENT },
        // The proxy flags ride alongside the identity flag, and for the same
        // reason: what Chrome does off its own bat has to carry the audit's
        // rules, not the browser's defaults.
        chromeFlags: [`--user-agent=${AUDIT_USER_AGENT}`, ...proxy.chromeFlags],
      });
    },
    async axe(url, timeoutMs, proxy) {
      const { runAxe } = await import('../audit-engine.js');
      const controller = new AbortController();
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        controller.abort(new Error(`axe exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      try {
        return reportableViolations(
          await runAxe(url, controller.signal, {
            userAgent: AUDIT_USER_AGENT,
            chromeOptions: proxy.chromeOptions,
          }),
        );
      } catch (err) {
        // Our own abort, surfaced as the deadline it was, so the loop can tell a
        // page that took too long from a browser that never started.
        if (expired) throw new DeadlineExceededError(`axe exceeded ${Math.round(timeoutMs / 1000)}s`);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Which of `runAxe`'s two lists the deep tier reports: `raw`, every violation
 * axe found.
 *
 * `runAxe` also returns a filtered list, and taking it — which this did first —
 * applies `isExpectedDraftNonFinding` to a stranger's site. That filter exists
 * for one narrow reason inside this repo: an unpublished draft of Matt's has no
 * generated OG image yet, so its `og:image` points at a PNG that does not exist,
 * and the `image-alt`/`meta-viewport` violations that follow are an artifact of
 * auditing a draft rather than a defect in the post.
 *
 * Applied outward it is a rule that says "an `image-alt` violation whose markup
 * mentions an OG image does not count", and somebody else's site can trip that
 * on a real, live, broken image. Their audit would report a clean axe run while
 * axe had found something. A filter written for one site's known non-issue must
 * not silently edit another site's findings.
 */
export function reportableViolations(result: { violations: AxeViolation[]; raw: AxeViolation[] }): AxeViolation[] {
  return result.raw;
}

/**
 * A tool run that was still going when its slice of the budget ran out.
 *
 * Distinct from every other failure on purpose: "this page took too long" and
 * "no browser started" look identical in a stack trace and mean opposite things
 * about what to do next. One is a fact about the page, and the next page may be
 * fine; the other is a fact about this machine, and every remaining page will
 * fail the same way.
 */
export class DeadlineExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineExceededError';
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
        timer = setTimeout(
          () => reject(new DeadlineExceededError(`${what} exceeded ${Math.round(ms / 1000)}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

/**
 * Both tools against one page, inside one slice of the budget.
 *
 * The unit both callers share: the in-process loop below runs it once per
 * sampled page behind one proxy, and `activities/agent-audit.ts` runs it once
 * per Temporal activity behind a proxy of its own. Everything large that the
 * tools return is reduced here, in the process that has the browser, so what
 * leaves this function is the small JSON document `deep-assemble.ts` reasons
 * about.
 *
 * Never throws. Every way a page can fail to produce a number — a tool that
 * died, a tool that outran the slice, no time left after the first one — comes
 * back on the outcome, because at this level none of them is exceptional.
 */
export async function renderPage(
  url: string,
  slice: number,
  proxy: VettingProxy,
  runners: DeepRunners,
  now: () => number = Date.now,
): Promise<RenderedPageOutcome> {
  const outcome: RenderedPageOutcome = {
    url,
    scores: null,
    lighthouseVersion: null,
    lighthouseError: null,
    violations: null,
    axeError: null,
    timedOut: false,
    blocked: { listed: [], total: 0 },
  };
  let axeExpired = false;
  let lighthouseExpired = false;

  const started = now();
  try {
    outcome.violations = reduceViolations(await withDeadline(runners.axe(url, slice, proxy), slice, 'axe'));
  } catch (err) {
    outcome.axeError = err instanceof Error ? err.message : String(err);
    axeExpired = err instanceof DeadlineExceededError;
  }

  const left = Math.max(0, slice - (now() - started));
  if (left <= 0) {
    outcome.lighthouseError = "no time left in this page's slice of the budget after axe";
    lighthouseExpired = true;
  } else {
    try {
      const lhr = await withDeadline(runners.lighthouse(url, left, proxy), left, 'Lighthouse');
      const reduced = reduceLighthouse(lhr);
      outcome.scores = reduced.scores;
      outcome.lighthouseVersion = reduced.version;
    } catch (err) {
      outcome.lighthouseError = err instanceof Error ? err.message : String(err);
      lighthouseExpired = err instanceof DeadlineExceededError;
    }
  }

  outcome.timedOut = producedNothing(outcome) && axeExpired && lighthouseExpired;
  return outcome;
}

/** Did this page produce nothing at all? The test for a browser that will not start. */
export function producedNothing(outcome: RenderedPageOutcome): boolean {
  return !outcome.scores && outcome.violations === null;
}

/** What the proxy refused, bounded for the trip through workflow history. */
export function blockedFrom(proxy: VettingProxy): BlockedRequests {
  return {
    listed: proxy.blocked.slice(0, MAX_BLOCKED_LISTED).map((b) => ({ url: b.url, reason: b.reason })),
    total: proxy.blocked.length,
  };
}

/**
 * The sampled page's own address check, run before a browser is spent on it.
 *
 * What Chrome does after that — following a redirect, fetching the page's
 * subresources — is covered by the vetting proxy rather than here; see the
 * module docblock. This check earns its place by being cheap and by wording the
 * refusal as a fact about the sampled page, which a 403 from the proxy could not.
 *
 * Returns the refusal rather than throwing it: a page the guard will not open is
 * a skipped page in the report, not an error the caller has to catch.
 */
export async function refusalFor(url: string, policy: FetchPolicy): Promise<string | null> {
  try {
    await assertConnectableUrl(url, policy);
    return null;
  } catch (err) {
    return err instanceof BlockedTargetError ? err.reason : String(err);
  }
}

// ---------------------------------------------------------------------------
// The in-process run
// ---------------------------------------------------------------------------

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
 *
 * The vetting proxy's lifetime is this call. It is started before the first page
 * and closed in a `finally`, including on the paths where no browser ever ran:
 * a listening socket left behind by a failed audit is a socket somebody else's
 * page could later be pointed at.
 */
export async function runDeepChecks(ctx: DeepContext, opts: DeepOptions = {}): Promise<DeepOutcome> {
  const proxy = await startVettingProxy(ctx.policy);
  try {
    const outcome = await renderSample(ctx, opts, proxy);
    return { ...outcome, notes: [...outcome.notes, ...blockedNotes(blockedFrom(proxy))] };
  } finally {
    await proxy.close();
  }
}

async function renderSample(ctx: DeepContext, opts: DeepOptions, proxy: VettingProxy): Promise<DeepOutcome> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const pageTimeoutMs = opts.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const runners = opts.runners ?? defaultRunners();
  const versions = toolVersions();

  const notes: string[] = [];
  const sample = ctx.candidates.slice(0, maxPages);
  const cap = capNote(ctx.candidates.length, sample.length);
  if (cap) notes.push(cap);

  const results: RenderedPageOutcome[] = [];
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
    const refusal = await refusalFor(url, ctx.policy);
    if (refusal) {
      skipped.push({ url, reason: refusal, robots: false });
      continue;
    }

    // Both tools share the page's slice, and the slice never outlives the audit.
    const slice = Math.min(pageTimeoutMs, ctx.remainingMs());
    const outcome = await renderPage(url, slice, proxy, runners);
    const nothing = producedNothing(outcome);
    results.push(outcome);

    // A browser that will not start fails identically on every page, so trying
    // the other two spends the budget to learn the same thing three times.
    //
    // A page that merely ran out of its slice is the opposite case and is not
    // grounds to stop: the slice is bounded, the next page gets its own, and one
    // pathological page says nothing about the next one. Conflating the two —
    // which this did first — reported "the browser did not produce a result"
    // about a browser that was working fine.
    if (results.length === 1 && nothing && !outcome.timedOut) {
      browserFailure = outcome.lighthouseError ?? outcome.axeError ?? 'the browser produced no result';
      notes.push(
        `Deep tier: neither tool produced a result for the first sampled page (${excerpt(browserFailure, 160)}), ` +
          'so the remaining pages were not attempted. The fast-tier checks above are unaffected.',
      );
      break;
    }
    if (outcome.timedOut) {
      notes.push(
        `Deep tier: ${url} did not finish rendering inside its ${Math.round(slice / 1000)}s slice of ` +
          'the budget. That is a fact about this page, not about the browser, so the remaining ' +
          'pages were still attempted.',
      );
    }
  }

  notes.push(...coverageNotes({ sample, rendered: results.length, skipped }));

  const checks = assembleDeepChecks({
    pages: results,
    skipped,
    sampled: sample.length,
    browserFailure,
    axeVersion: versions.axe,
  });
  return { checks, notes, renderedPages: results.length };
}
