import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import {
  aggregate,
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

// Queue names duplicated here rather than imported from config.ts — the same
// reason review-post.ts does it: config.ts touches `node:path` and
// `process.env`, neither available in the workflow sandbox.
const QUEUE_LIGHT = 'steward-light';
const QUEUE_HEAVY = 'steward-heavy';

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
}

export interface ScorecardAuditResult {
  decision: 'open-pr' | 'no-op';
  reason: string;
  prUrl?: string;
  record: ScorecardRunRecord;
  perPage: Array<{ url: string; scores: Record<string, number>; axeViolations: number }>;
}

const light = {
  resolving: wf.proxyActivities<Pick<typeof activities, 'resolveAuditUrls' | 'resolveRunStamp'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 3 },
  }),
  reading: wf.proxyActivities<Pick<typeof activities, 'readPublishedScorecard'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  }),
  publishing: wf.proxyActivities<Pick<typeof activities, 'publishScorecardRun'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '5 minutes',
    retry: {
      maximumAttempts: 1,
      nonRetryableErrorTypes: ['AuthError', 'NotFound', 'UnprocessableRequest'],
    },
  }),
  archiving: wf.proxyActivities<Pick<typeof activities, 'archiveScorecardRun'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  }),
};

/**
 * Same heavy-queue shape `reviewPost` uses for `buildAndAuditDraft`: a
 * background heartbeat pump inside the activity keeps the channel alive
 * through a multi-ten-second Chrome + Lighthouse + axe run.
 */
const heavy = wf.proxyActivities<Pick<typeof activities, 'auditLiveUrl'>>({
  taskQueue: QUEUE_HEAVY,
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
  const urls = input.urls && input.urls.length > 0
    ? input.urls
    : await light.resolving.resolveAuditUrls(input.sitemapUrl);

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

  // --- Step 3: read the published run, decide -----------------------------
  //
  // Read and decide *before* building the candidate record so the commentary
  // (below) can fold in the change delta `decidePublish` already computed —
  // never re-derive it separately. This does not change the activity-call
  // order (readPublishedScorecard still fires after every auditLiveUrl and
  // before publishScorecardRun/archiveScorecardRun); it only moves where the
  // in-workflow object is assembled, which is not an activity call.
  const published = await light.reading.readPublishedScorecard();
  const decision = decidePublish({ iso, metrics }, published, input.maxAgeDays);

  const candidate: Omit<ScorecardRunRecord, 'id'> = {
    iso,
    timestamp,
    scope: `${urls.length} live page${urls.length === 1 ? '' : 's'}`,
    tools: ['Lighthouse 13.4', 'axe-core 4.12'],
    entry: input.triggeredBy === 'schedule' ? 'Nightly · automated' : 'Manual · intentional',
    commentary: buildCommentary(perPage, metrics, decision),
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
    const published = await light.publishing.publishScorecardRun({
      record: candidate,
      perPage: perPageSummary,
    });
    prUrl = published.prUrl;
    record = { ...candidate, id: published.id };
  }

  // --- Step 5: always archive ----------------------------------------------
  await light.archiving.archiveScorecardRun({
    ...record,
    perPage: perPageSummary,
    decision: decision.decision,
    reason: decision.reason,
    prUrl,
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

  return undefined;
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
