import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import {
  aggregate,
  checkAuditSet,
  decidePublish,
  type PageAuditOutcome,
  type PublishDecision,
  type ScorecardRunRecord,
} from '../lib/scorecard-aggregate.js';

/**
 * `scorecardAuditWorkflow` (scorecard-audit-spec.md §4.2) — audits the live
 * site, aggregates the four public Scorecard metrics, and opens a PR when the
 * result is worth a human's attention. No durable park, no signals: the
 * publish decision is known entirely from activity results, and the human
 * gate is the PR merge, not a workflow wait (spec §4.2, end).
 *
 * A sibling of `reviewPost`, not a variant — see spec §2. It never reads
 * `buildAndAuditDraft`'s numbers, never reuses its thresholds, and never
 * self-merges (design rule 2).
 */

// Queue name duplicated here rather than imported from config.ts — the same
// reason review-post.ts does it: config.ts touches `node:path` and
// `process.env`, neither available in the workflow sandbox.
//
// **One queue, and it is the hosted one** (2026-08-14, always-on-audit-worker
// card leg 2b). Every activity this workflow schedules now reaches the site over
// the network and the repository over the GitHub API, so none of them needs a
// checkout, so all of them can run in a container. That is the whole point: the
// Schedule moved to Temporal Cloud, where the server never misses a firing, and
// a firing the laptop has to advance is a run that dies on its execution
// timeout rather than one that catches up later.
//
// The split is still by locality (config.ts's `QUEUE_AUDIT` docblock). What
// changed is which side of it the scorecard falls on, and it changed because
// `activities/scorecard.ts` stopped touching the filesystem — not because the
// rule was relaxed.
const QUEUE_AUDIT = 'steward-audit';

export interface ScorecardAuditInput {
  /** Manual `--urls` override. Omitted -> resolved from the live sitemap (spec §4.2 step 0). */
  urls?: string[];
  /** The live origin's sitemap index, e.g. `https://www.mattpyle.com/sitemap-index.xml`. Resolved by the CLI from config, never re-read here (design rule 3). */
  sitemapUrl: string;
  publishMode: 'pr' | 'dry-run';
  /** Freshness threshold for the staleness rule (spec §6). */
  maxAgeDays: number;
  triggeredBy: 'schedule' | 'manual';
  /** IANA timezone `resolveRunStamp` computes the run's calendar date in — resolved by the CLI from `config.ts` (design rule 3), never read here directly. */
  timeZone: string;
  /**
   * `--date` override (spec §5.1's timezone amendment): pins the run's `iso`
   * to a specific `YYYY-MM-DD`, for backfilling a run to the day the audit
   * actually happened rather than the day the workflow executed. The
   * `timestamp` field still carries the real audit instant — only the
   * calendar-day label is overridden.
   */
  date?: string;
  /**
   * `--allow-shrink`: accept an audit set smaller than the previous published
   * run's page count (spec §5.4's guard). A decision, so it rides in the input
   * and is frozen into history (design rule 3) — never read from config.
   */
  allowShrink?: boolean;
  /**
   * `--note`: run commentary supplied by the human who started the run, folded
   * into `commentary` ahead of the machine draft so a manual run reads the way
   * it would after a hand-edit of the PR, without the hand-edit.
   *
   * A decision about what this run *says*, so it rides in the input and is
   * frozen into history like every other one (design rule 3). Optional and
   * absent from every execution before it existed, so replay of an existing
   * history takes the same branch it always took and no `patched()` is needed —
   * that property is what keeps this a one-field change rather than a
   * workflow-versioning exercise.
   *
   * Subject to the same timeless-commentary rule as the machine draft (spec
   * §5.1 rule 7). The CLI checks it before starting the run so a present-relative
   * note fails in milliseconds rather than after a twelve-minute audit;
   * `publishScorecardRun`'s `assertTimelessCommentary` remains the backstop.
   */
  note?: string;
}

export interface ScorecardAuditResult {
  decision: 'open-pr' | 'no-op';
  reason: string;
  prUrl?: string;
  record: ScorecardRunRecord;
  perPage: Array<{ url: string; scores: Record<string, number>; axeViolations: number }>;
}

const light = {
  // A minute rather than thirty seconds: this fetches the live sitemap index and
  // every sitemap under it, which is a handful of round trips rather than one.
  resolving: wf.proxyActivities<Pick<typeof activities, 'resolveAuditUrls' | 'resolveRunStamp'>>({
    taskQueue: QUEUE_AUDIT,
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 3 },
  }),
  // Was 30 seconds when this read a local file. It is two GitHub calls now, so
  // it gets a network-shaped deadline and keeps its three attempts — a 5xx from
  // the API here would otherwise fail the run before it measured anything.
  reading: wf.proxyActivities<Pick<typeof activities, 'readPublishedScorecard'>>({
    taskQueue: QUEUE_AUDIT,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 3 },
  }),
  // **Two minutes, down from twenty.** The old figure was not about how long
  // publishing takes; it was about how long publishing might have to *wait*.
  // The activity took the shared worktree lock, `buildAndAuditDraft` could hold
  // that lock for its full 15 minutes, and the publish leg had to be able to
  // wait a build out rather than die on a deadline it could not meet.
  //
  // There is no worktree and no lock any more (`activities/scorecard.ts`), so
  // there is nothing to wait behind: this is four GitHub calls. Leaving it at 20
  // minutes would mean a wedged publish sat undetected for twenty minutes of a
  // run whose whole point is to be finished overnight.
  //
  // One attempt still, and the same non-retryable set: a rejected credential or
  // a 422 fails identically on a second try, and the retry that matters here is
  // the operator re-running the scorecard.
  publishing: wf.proxyActivities<Pick<typeof activities, 'publishScorecardRun'>>({
    taskQueue: QUEUE_AUDIT,
    startToCloseTimeout: '2 minutes',
    retry: {
      maximumAttempts: 1,
      nonRetryableErrorTypes: ['AuthError', 'NotFound', 'UnprocessableRequest'],
    },
  }),
  // Three attempts, and that is safe to keep now for a reason worth stating: the
  // archive write is a *create* with no `sha`, so a retry that follows a commit
  // the workflow never saw succeed collides, is caught, and takes the next
  // filename rather than overwriting the record it just wrote.
  archiving: wf.proxyActivities<Pick<typeof activities, 'archiveScorecardRun'>>({
    taskQueue: QUEUE_AUDIT,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 3 },
  }),
};

/**
 * The per-page audit. A background heartbeat pump inside the activity keeps the
 * channel alive through a multi-ten-second Chrome + Lighthouse + axe run.
 *
 * On the audit queue rather than `steward-heavy` since 2026-08-14. It always
 * measured the *live* site rather than the working copy, so the only thing it
 * ever needed from the laptop was a browser, and the hosted image has one.
 */
const heavy = wf.proxyActivities<Pick<typeof activities, 'auditLiveUrl'>>({
  taskQueue: QUEUE_AUDIT,
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});

/**
 * How many pages are audited concurrently. A flat cap, not a queue —
 * deterministic and replay-safe. Fixed at 1 (serial) because Lighthouse is
 * not safe to run concurrently in a single Node process: `marky` (the timing
 * library `lighthouse-logger` uses) keys its marks off Node's *global*
 * `performance.mark`/`measure` namespace, not per-invocation. Two concurrent
 * Lighthouse runs in this worker corrupt each other's timing marks, which
 * failed 100% of `auditLiveUrl` activities at `= 2` with `DOMException: The
 * "start lh:runner:gather" performance mark has not been set` /
 * `LanternError: Could not find any top level events` (Phase 1.5/1.6,
 * scorecard-build-log.md). This is a correctness constraint, not a stability
 * tune — do not raise it without isolating Lighthouse per worker
 * thread/process first (a Phase 3 lever, spec §5.4's runtime note). At ~18
 * pages × ~40s serially, a full run is ~10-12 minutes, which is fine for a
 * nightly job.
 */
const AUDIT_CONCURRENCY = 1;

/** Digs the real error out of a failed activity — same helper `reviewPost` uses. */
function describeActivityError(err: unknown): string {
  let current: unknown = err;
  let best = '';
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.message && current.message !== 'Activity task failed') best = current.message;
    current = (current as Error).cause;
  }
  return best || (err instanceof Error ? err.message : String(err));
}

/**
 * Audits every URL, capped at `AUDIT_CONCURRENCY` in flight at once — plain
 * chunked `Promise.all`, not a real work-stealing pool, because the URL list
 * is fixed for the life of the execution (spec §5.4's "the replay tripwire
 * for *this* workflow") and a fixed batch order is trivially deterministic.
 * A URL whose activity exhausts its own retries is guarded into an `ok:
 * false` marker (design rule 4) rather than failing the whole workflow.
 */
async function auditAll(urls: string[]): Promise<PageAuditOutcome[]> {
  const results: PageAuditOutcome[] = [];
  for (let i = 0; i < urls.length; i += AUDIT_CONCURRENCY) {
    const batch = urls.slice(i, i + AUDIT_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<PageAuditOutcome> => {
        try {
          return await heavy.auditLiveUrl(url);
        } catch (err) {
          return { url, ok: false, error: describeActivityError(err) };
        }
      }),
    );
    results.push(...batchResults);
  }
  return results;
}

export async function scorecardAuditWorkflow(input: ScorecardAuditInput): Promise<ScorecardAuditResult> {
  // --- Step 0: resolve the audit set --------------------------------------
  const overridden = Boolean(input.urls && input.urls.length > 0);
  const resolved = overridden
    ? (input.urls as string[])
    : await light.resolving.resolveAuditUrls(input.sitemapUrl);
  const urls = [...resolved].sort();

  // --- Step 0.5: guard the audit set ---------------------------------------
  //
  // Read the published run *before* the fan-out, not at step 3 where the
  // publish decision needs it, so a broken audit set fails in seconds instead
  // of after ~12 minutes of Chrome launches. The same activity result is
  // reused for `decidePublish` below — one call, one history event.
  const published = await light.reading.readPublishedScorecard();
  const guard = checkAuditSet({
    resolvedCount: urls.length,
    previousCount: published?.pageCount,
    overridden,
    allowShrink: input.allowShrink === true,
  });
  // Logged at info, sorted, every run: the audited set and the sitemap are
  // identical by construction, so this list is the only artifact that makes an
  // after-the-fact "what did that run actually cover" diff possible.
  wf.log.info('scorecard audit set resolved', {
    count: urls.length,
    previousCount: published?.pageCount,
    overridden,
    allowShrink: input.allowShrink === true,
    guard: guard.reason,
    urls,
  });
  if (!guard.ok) {
    throw wf.ApplicationFailure.nonRetryable(guard.reason, 'AuditSetGuard');
  }

  // --- Step 1: fan out --------------------------------------------------
  const perPage = await auditAll(urls);

  // --- Step 2: aggregate (pure, deterministic) ---------------------------
  const metrics = aggregate(perPage);
  // `resolveRunStamp` runs as an activity (not the sandboxed `Date`) because
  // converting an instant to a calendar day in a named timezone depends on
  // the host's tz database — see the activity's own doc comment. `--date`
  // only overrides the calendar-day label; `timestamp` still carries the
  // real audit instant.
  const stamp = await light.resolving.resolveRunStamp(input.timeZone);
  const iso = input.date ?? stamp.iso;
  const timestamp = stamp.timestamp;
  const perPageSummary = perPage.map((p) =>
    p.ok
      ? { url: p.url, scores: p.scores, axeViolations: p.axeViolations }
      : { url: p.url, scores: {}, axeViolations: 0 },
  );

  // --- Step 3: decide ------------------------------------------------------
  //
  // `published` was already read at step 0.5 (the guard needs it before the
  // fan-out); it is deliberately not re-read here — a second call would be a
  // second history event for the same fact. Decide *before* building the
  // candidate record so the commentary (below) can fold in the change delta
  // `decidePublish` already computed, rather than re-deriving it.
  //
  // `scope` and `tools` are resolved above the decision rather than inline in
  // `candidate`, because the gate compares them (spec §6, trigger 3): they
  // describe what was measured, and a change in coverage is news even when
  // every number held.
  const scope = `${urls.length} live page${urls.length === 1 ? '' : 's'}`;
  const tools = ['Lighthouse 13.4', 'axe-core 4.12'];
  const decision = decidePublish({ iso, metrics, scope, tools }, published, input.maxAgeDays);

  const candidate: Omit<ScorecardRunRecord, 'id'> = {
    iso,
    timestamp,
    scope,
    tools,
    entry: input.triggeredBy === 'schedule' ? 'Nightly · automated' : 'Manual · intentional',
    commentary: withNote(input.note, buildCommentary(perPage, metrics, decision)),
    metrics,
  };

  // --- Step 4: publish, unless dry-run -------------------------------------
  //
  // `dry-run` skips this step entirely, regardless of the decision (spec
  // §4.2 step 4) — the dry-run mode exists so `steward scorecard --dry-run`
  // can validate the live audit numbers themselves (spec §9.6's smoke test)
  // without ever touching GitHub, not to open a throwaway PR.
  let prUrl: string | undefined;
  let record: ScorecardRunRecord = { ...candidate, id: iso };
  if (decision.decision === 'open-pr' && input.publishMode === 'pr') {
    const opened = await light.publishing.publishScorecardRun({
      record: candidate,
      perPage: perPageSummary,
    });
    prUrl = opened.prUrl;
    record = { ...candidate, id: opened.id };
  }

  // --- Step 5: always archive ----------------------------------------------
  await light.archiving.archiveScorecardRun({
    ...record,
    perPage: perPageSummary,
    decision: decision.decision,
    reason: decision.reason,
    prUrl,
    // Carried explicitly rather than inferred: the archive commits through the
    // GitHub API now, so this is what keeps spec §4.2 step 4's "a dry run never
    // touches GitHub" true of the archive as well as the publish leg.
    dryRun: input.publishMode === 'dry-run',
  });

  return { decision: decision.decision, reason: decision.reason, prUrl, record, perPage: perPageSummary };
}

/**
 * Describes a metric-level delta `decidePublish` already found, in words that
 * read correctly forever (spec §5.1 rule 7) — never the staleness reason
 * ("published run is Nd old") or the "no published run exists yet" reason,
 * both of which describe the run's position in the list rather than a fact
 * about this run, and so must never leak into the commentary.
 */
function describeChangeDelta(decision: PublishDecision): string | undefined {
  const { reason } = decision;

  const statusFlip = reason.match(/^(.+) (Pass|Partial|Fail)→(Pass|Partial|Fail)$/);
  if (statusFlip) {
    const [, name, from, to] = statusFlip;
    return `${name} moved from ${from} to ${to}`;
  }

  const performanceMove = reason.match(/^Performance (\d+(?:\.\d+)?)→(\d+(?:\.\d+)?)$/);
  if (performanceMove) {
    const [, from, to] = performanceMove;
    const verb = Number(to) > Number(from) ? 'rose' : Number(to) < Number(from) ? 'fell' : 'held';
    return `Performance ${verb} from ${from} to ${to}`;
  }

  const ratioMove = reason.match(/^(.+) (\d+)\/(\d+)→(\d+)\/(\d+)$/);
  if (ratioMove) {
    const [, name, prevValue, prevMax, nextValue, nextMax] = ratioMove;
    // Compare the numerator (checks/points passing), not the fraction — a
    // metric whose denominator also grew (e.g. a new applicable check) still
    // reads as a rise when what passes went up, even if K/J stayed maxed out.
    const verb = Number(nextValue) > Number(prevValue) ? 'rose' : Number(nextValue) < Number(prevValue) ? 'fell' : 'held';
    return `${name} ${verb} from ${prevValue}/${prevMax} to ${nextValue}/${nextMax}`;
  }

  const newMetric = reason.match(/^(.+) is a new metric$/);
  if (newMetric) {
    return `${newMetric[1]} is a new metric this run`;
  }

  // Spec §6's third trigger. Worth stating in the commentary for the same
  // reason it is worth publishing on: the page count is baked into every
  // metric description, so a reader deserves to know coverage moved even
  // though no score did.
  const coverageMove = reason.match(/^Coverage (\d+)→(\d+) pages$/);
  if (coverageMove) {
    const [, from, to] = coverageMove;
    const verb = Number(to) > Number(from) ? 'rose' : 'fell';
    return `Coverage ${verb} from ${from} to ${to} pages`;
  }

  const toolsMove = reason.match(/^Tools (.+)→(.+)$/);
  if (toolsMove) {
    const [, from, to] = toolsMove;
    return `Measured with ${to} rather than ${from}`;
  }

  return undefined;
}

/**
 * Puts a `--note` in front of the machine draft rather than in place of it.
 *
 * Replacing would lose the one thing the draft is good at — the delta and the
 * pass summary, stated in the same words every run states them — and the note is
 * commentary *about* the run, not a substitute for what it measured. Prefixing
 * gives the reader the human sentence first and the facts immediately after,
 * which is the shape a hand-edited PR ended up in anyway.
 *
 * Pure and inline (not an activity): the workflow already builds the machine
 * draft itself, and this is string handling on a value already in the input.
 */
function withNote(note: string | undefined, draft: string): string {
  const trimmed = note?.trim();
  if (!trimmed) return draft;
  // A note that already punctuates itself keeps its own ending; one that does
  // not gets a period, so the two sentences do not run together.
  const punctuated = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `${punctuated} ${draft}`;
}

/**
 * A machine first-draft `commentary` (rule 7) — human-editable in the PR
 * before merge. States, factually, what *this run* measured: the delta (if
 * `decidePublish` found one worth surfacing) plus the pass summary. Never a
 * present-relative word ("currently," "latest," "now," "baseline," "today")
 * — those describe the run's position in the list, which is exactly what
 * rule 7 forbids, and `validateCommentary`/`assertTimelessCommentary` block
 * a violation before it can publish.
 */
function buildCommentary(
  perPage: PageAuditOutcome[],
  metrics: ScorecardRunRecord['metrics'],
  decision: PublishDecision,
): string {
  const failedPages = perPage.filter((p) => !p.ok);
  if (failedPages.length > 0) {
    return `${failedPages.length} of ${perPage.length} page(s) could not be audited (${failedPages.map((p) => p.url).join(', ')}), which blocks a green Scorecard by design.`;
  }

  const worst = metrics.filter((m) => m.status !== 'Pass');
  const pageCount = perPage.length;
  const summary =
    worst.length === 0
      ? `all ${pageCount} page${pageCount === 1 ? '' : 's'} passed all four public metrics`
      : worst.map((m) => `${m.name}: ${m.value}/${m.maximum} (${m.status})`).join('; ');

  const delta = describeChangeDelta(decision);
  const combined = delta ? `${delta}; ${summary}` : summary;
  return `${combined.charAt(0).toUpperCase()}${combined.slice(1)}.`;
}
