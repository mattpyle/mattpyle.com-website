import { ApplicationFailure, Context } from '@temporalio/activity';
import { log } from '../lib/logger.js';
import {
  assembleResult,
  runFastAudit,
  runFetchChecks,
  type FetchChecksOutcome,
} from '../lib/agent-audit/checks.js';
import {
  blockedFrom,
  defaultRunners,
  producedNothing,
  refusalFor,
  renderPage,
} from '../lib/agent-audit/deep.js';
import {
  assembleDeepChecks,
  blockedNotes,
  capNote,
  coverageNotes,
  mergeBlocked,
  toolVersions,
  type RenderedPageOutcome,
  type SkippedPage,
} from '../lib/agent-audit/deep-assemble.js';
import { sendHealthPing } from '../lib/health-ping.js';
import { deepAuditShape } from '../lib/run-health.js';
import { startVettingProxy } from '../lib/agent-audit/vetting-proxy.js';
import { BlockedTargetError, DEFAULT_POLICY } from '../lib/agent-audit/safe-fetch.js';
import type { AuditResult } from '../lib/agent-audit/result.js';

/**
 * The audit as activities.
 *
 * The audit is I/O against a stranger's origin — the textbook activity — and
 * `lib/agent-audit/` stays plain testable TypeScript with no Temporal imports.
 * This file is the only place that knows about the runtime, the same split
 * `audit-engine.ts` and `activities/scorecard.ts` already use.
 *
 * ## Why the deep tier is three activities and the fast tier is one
 *
 * The fast tier is a dozen HTTP round trips that either all work or all fail the
 * same way, so `auditSiteFast` runs it whole. The deep tier is minutes of Chrome
 * over several pages, and stage 1 ran it as one activity with one attempt: a
 * worker that died mid-audit lost every page it had already rendered. Serving
 * strangers from a hosted worker, that is the wrong unit of work, so the deep
 * tier is decomposed into
 *
 * 1. `auditSiteFetchChecks` — every fetch-based check, plus the sampling
 *    decision the pages depend on,
 * 2. `auditRenderedPage` — **one page**, the unit that is retried and the unit a
 *    restarted worker does not have to redo,
 * 3. `assembleDeepAudit` — the arithmetic over what the pages returned.
 *
 * The workflow (`workflows/audit-site.ts`) owns the order and the budget.
 *
 * ## The retry rule, in the error types
 *
 * A site failing a check is a finding and never retries; an infrastructure
 * failure retries the smallest unit that owns its own network work. Those are
 * different *kinds* of outcome here rather than different messages: everything
 * this code can describe about a page comes back **on the return value**, and the
 * only throw a rendered page raises is `BrowserUnavailable`, which means no
 * browser started at all. A caller reading error types alone can tell the two
 * apart, which is what lets the retry policy be written without matching on text.
 *
 * ## Result size
 *
 * Bounded by construction. The fast document carries an excerpt per check rather
 * than any response body (11–17 KB in real runs). A rendered page is reduced to
 * its category scores and a violation tally *inside the activity*, because the
 * raw Lighthouse result is megabytes and every byte a page returns is written to
 * workflow history and read back out again by assembly. `deep-assemble.ts`'s
 * `RenderedPageOutcome` is that reduction.
 */

/** Heartbeat cadence. Comfortably inside the 30s `heartbeatTimeout` the stubs set. */
const HEARTBEAT_MS = 5_000;

/**
 * The activity boundary's options — deliberately narrower than `RunAuditOptions`.
 *
 * That type carries a `now()` clock and a `policy` object, both of which exist so
 * a test can inject a fake; neither survives serialisation, and an argument a
 * workflow cannot send is not an argument this boundary should advertise. Every
 * field here is JSON.
 */
export interface AuditActivityOptions {
  /** Total wall-clock budget for the whole audit, in milliseconds. */
  budgetMs?: number;
}

/** Translates the wire-safe options into the engine's own shape. */
function engineOptions(options: AuditActivityOptions) {
  return options.budgetMs === undefined ? {} : { policy: { totalBudgetMs: options.budgetMs } };
}

/**
 * Runs work under a heartbeat pump, the same discipline `auditLiveUrl` and
 * `buildAndAuditDraft` use: a deep page is a minute-plus of Chrome, and an
 * activity that never heartbeats can neither be detected as wedged nor told it
 * was cancelled.
 */
async function withHeartbeat<T>(what: string, run: () => Promise<T>): Promise<T> {
  const ctx = Context.current();
  const beat = () => ctx.heartbeat(what);
  const pump = setInterval(beat, HEARTBEAT_MS);
  try {
    beat();
    return await run();
  } finally {
    clearInterval(pump);
  }
}

/**
 * A refused target is a **non-retryable** failure. `runAudit` throws only for a
 * target it cannot audit at all, and the SSRF guard refusing a private address is
 * a verdict about the request, not a transient fault — three attempts would
 * produce the same refusal three times and bury the reason under a retry history.
 */
function asBlockedFailure(err: unknown): never {
  if (err instanceof BlockedTargetError) {
    throw ApplicationFailure.nonRetryable(`refused to audit ${err.url}: ${err.reason}`, 'BlockedTarget');
  }
  throw err;
}

function logAudit(activity: string, audit: AuditResult, tier: string): void {
  log.info(
    {
      activity,
      origin: audit.target.origin,
      requests: audit.requests,
      browserPages: audit.browserPages,
      durationMs: audit.durationMs,
      failed: audit.checks.filter((c) => c.status === 'fail').map((c) => c.id),
    },
    `${tier} agent-readiness audit complete`,
  );
}

/** The fast tier: the agent surfaces over plain HTTP. No browser, one activity. */
export async function auditSiteFast(
  input: string,
  options: AuditActivityOptions = {},
): Promise<AuditResult> {
  return withHeartbeat(`fast audit of ${input}`, async () => {
    try {
      const audit = await runFastAudit(input, engineOptions(options));
      logAudit('auditSiteFast', audit, 'fast');
      return audit;
    } catch (err) {
      return asBlockedFailure(err);
    }
  });
}

export interface FetchChecksOptions extends AuditActivityOptions {
  /** How many pages the deep tier may render. The cap, applied and reported. */
  maxPages: number;
}

/**
 * Step 1 of a deep audit: every fetch-based check, and the list of pages to
 * render.
 *
 * **One attempt**, unlike the per-page activity below. This is a dozen-plus
 * requests against a stranger's origin, and re-running them from the beginning is
 * exactly what the stage-1 one-attempt decision refused. It is also nearly
 * unnecessary: this code already reports a failure it can describe as a check
 * with `error` status rather than throwing, so an activity that actually threw
 * hit something a second identical run would hit too.
 */
export async function auditSiteFetchChecks(
  input: string,
  options: FetchChecksOptions,
): Promise<FetchChecksOutcome> {
  return withHeartbeat(`fetch checks for ${input}`, async () => {
    try {
      const outcome = await runFetchChecks(input, {
        ...engineOptions(options),
        maxPages: options.maxPages,
      });
      logAudit('auditSiteFetchChecks', outcome.result, 'fetch-pass');
      return outcome;
    } catch (err) {
      return asBlockedFailure(err);
    }
  });
}

export interface RenderPageInput {
  url: string;
  /** This page's slice of the audit's budget, in milliseconds. */
  timeoutMs: number;
}

/**
 * One page, rendered: axe then Lighthouse, behind a vetting proxy of this
 * activity's own.
 *
 * The retry unit of the deep tier. It returns for everything it can describe —
 * a tool that timed out, a tool that errored, a page the address guard would not
 * open — and throws exactly one thing, `BrowserUnavailable`, for the case where
 * neither tool produced anything and neither ran out of time. That is the
 * signature of a browser that will not start, which is an infrastructure failure
 * and worth a second attempt; everything else is a fact about the page, and a
 * second attempt would spend another browser launch to learn it again.
 *
 * The proxy's lifetime is this call, closed in a `finally` even on the paths
 * where no browser ran: a listening socket left behind by a failed page is a
 * socket somebody else's page could later be pointed at.
 */
export async function auditRenderedPage(input: RenderPageInput): Promise<RenderedPageOutcome> {
  return withHeartbeat(`rendering ${input.url}`, async () => {
    // The default policy, not the audit's: the only field of it this path reads
    // is the address guard's, and `allowedPrivateHosts` is empty everywhere but
    // the tests. The audit's time budget is already spent as `timeoutMs`.
    const policy = DEFAULT_POLICY;
    const refusal = await refusalFor(input.url, policy);
    if (refusal) {
      throw ApplicationFailure.nonRetryable(
        `refused to render ${input.url}: ${refusal}`,
        'BlockedTarget',
      );
    }

    const proxy = await startVettingProxy(policy);
    try {
      const outcome = await renderPage(input.url, input.timeoutMs, proxy, defaultRunners());
      outcome.blocked = blockedFrom(proxy);
      if (producedNothing(outcome) && !outcome.timedOut) {
        throw ApplicationFailure.create({
          message:
            outcome.lighthouseError ?? outcome.axeError ?? 'the browser produced no result',
          type: 'BrowserUnavailable',
        });
      }
      log.info(
        {
          activity: 'auditRenderedPage',
          url: input.url,
          scored: outcome.scores !== null,
          violations: outcome.violations?.length ?? null,
          timedOut: outcome.timedOut,
        },
        'rendered one page of a deep audit',
      );
      return outcome;
    } finally {
      await proxy.close();
    }
  });
}

export interface AssembleDeepAuditInput {
  /** The document `auditSiteFetchChecks` returned. */
  fast: AuditResult;
  /** The pages a browser was pointed at, in render order. */
  pages: RenderedPageOutcome[];
  /** The sampled pages that were never rendered, and why. */
  skipped: SkippedPage[];
  /** Every URL in the sample, capped, in order — rendered and skipped alike. */
  sample: string[];
  /** How many pages were eligible before the cap. */
  available: number;
  /** Set when the browser itself never produced a result, so later pages were abandoned. */
  browserFailure: string | null;
  /** Notes the workflow wrote as the fan-out ran: a browser failure, a page that outran its slice. */
  progressNotes: string[];
}

/**
 * Step 3: the finished document.
 *
 * Pure arithmetic over values the workflow already holds, so it could in
 * principle run in the workflow itself. It is an activity because the assembly
 * reads the installed axe-core version off disk and because the finished
 * document's `finishedAt` is a wall-clock reading — both are things a workflow
 * may not do, and splitting the honest half from the deterministic half would
 * put the report's assembly in two places.
 */
export async function assembleDeepAudit(input: AssembleDeepAuditInput): Promise<AuditResult> {
  const { fast, pages, skipped } = input;
  const checks = [
    ...fast.checks,
    ...assembleDeepChecks({
      pages,
      skipped,
      sampled: input.sample.length,
      browserFailure: input.browserFailure,
      axeVersion: toolVersions().axe,
    }),
  ];
  // The order the in-process tier writes them in, and the order a reader
  // follows: what was skipped by the cap, what happened while the fan-out ran,
  // what ended up rendered, then what the address guard refused. The workflow
  // supplies only the middle group, because only it saw the fan-out happen.
  const cap = capNote(input.available, input.sample.length);
  const notes = [
    ...fast.notes,
    ...(cap ? [cap] : []),
    ...input.progressNotes,
    ...coverageNotes({ sample: input.sample, rendered: pages.length, skipped }),
    ...blockedNotes(mergeBlocked(pages)),
  ];

  const audit = assembleResult({
    input: fast.target.input,
    origin: fast.target.origin,
    startedAt: fast.startedAt,
    finishedAt: new Date().toISOString(),
    requests: fast.requests,
    browserPages: pages.length,
    checks,
    notes,
  });
  logAudit('assembleDeepAudit', audit, 'deep');

  // The deep tier's result-shape alert (audit-stack-alerting-and-monitoring
  // card). Fail-only: a healthy audit sends nothing, because a deep audit is ad
  // hoc and "none ran today" is not news the way a missing nightly run is.
  //
  // **Here rather than in the workflow**, which is where the scorecard's
  // equivalent lives, for one reason: `auditSiteWorkflow` has a committed replay
  // fixture and scheduling another activity after assembly would strand it,
  // buying a fixture re-export to move a call one frame up the stack. This is
  // the frame where the record takes its final shape either way, and the alert
  // reads that record without changing it.
  const shape = deepAuditShape({
    origin: audit.target.origin,
    sampled: input.sample.length,
    rendered: pages.length,
  });
  if (!shape.ok) await sendHealthPing('run-shape', shape);

  return audit;
}
