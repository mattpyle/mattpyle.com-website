import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AuditResult } from '../lib/agent-audit/result.js';
// The wire contract, declared once and shared with the site's /mcp function.
// Safe to import here despite the sandbox: `deep-contract.ts` has no runtime
// import of its own, touches no `node:` API and reads no clock.
import type {
  AuditSiteInput,
  AuditSiteState,
  AuditStep,
  AuditTier,
} from '../lib/agent-audit/deep-contract.js';
// Type-only, so the sandbox never loads that module — it reads the installed
// axe-core version off disk, which a workflow may not do.
import type { RenderedPageOutcome, SkippedPage } from '../lib/agent-audit/deep-assemble.js';

/**
 * `auditSiteWorkflow` — one agent-readiness audit of one site, run durably.
 *
 * The second door to the same engine, not a replacement for the first:
 * `steward audit-url` still calls `runAudit` in-process with no worker and no
 * Temporal, and nothing here changes what the audit checks. What this adds is
 * the async shape a remote caller needs — start it, get a handle back in
 * milliseconds, poll for the result — which is what the MCP server in
 * `src/mcp/` fronts (hosted-mcp-stage-1 card).
 *
 * No signals and no park: an audit takes the time it takes and nothing about it
 * waits on a human.
 *
 * ## The deep tier is a fan-out (stage 3)
 *
 * Stage 1 ran the whole deep tier as one activity with one attempt, which was
 * fine on Matt's desktop and wrong for a hosted worker serving strangers: a
 * worker that died three minutes in lost every page it had already rendered.
 * The deep tier is now
 *
 *   `auditSiteFetchChecks` → `auditRenderedPage` × N (serially) → `assembleDeepAudit`
 *
 * so a restarted worker resumes at the page it was on, and each page is its own
 * retry unit. **Not parallelism**: Lighthouse is serial per worker process
 * (`marky`, see `scorecard-audit.ts`'s concurrency docblock), so the pages run
 * one at a time and the fan-out buys durability and progress rather than speed.
 *
 * The fast tier is unchanged and is still one activity, because a dozen HTTP
 * round trips is not a thing worth checkpointing.
 */

// Queue names duplicated here rather than imported from config.ts — the same
// reason review-post.ts and scorecard-audit.ts do it: config.ts touches
// `node:path` and `process.env`, neither available in the workflow sandbox.
// `steward-audit` is the audit's own queue (always-on-audit-worker card): the
// hosted worker polls it and nothing else, and `reviewPost`, which reads the
// working copy and writes local files, stays on the queues a laptop serves.
const QUEUE_AUDIT = 'steward-audit';

/**
 * The three deep-tier constants, duplicated from `lib/agent-audit/deep-assemble.ts`
 * for the same sandbox reason as the queue name — that module reads the
 * installed axe-core version off disk and cannot be imported here.
 *
 * `tests/workflows/audit-site.test.ts` asserts the two copies are equal, so a
 * change to one that is not made to the other fails a test rather than quietly
 * giving the workflow a different budget from the tier it is driving.
 */
const MAX_PAGES = 3;
const PAGE_TIMEOUT_MS = 90_000;
const MIN_PAGE_BUDGET_MS = 20_000;

/**
 * The input, the progress shape and the state a query answers with all live in
 * `lib/agent-audit/deep-contract.ts` since 2026-08-15, and are re-exported here
 * so every existing importer of this module is unchanged.
 *
 * They moved because they stopped being this workflow's private business: the
 * site's `/mcp` function polls this query from a Vercel function and has to hold
 * the same types, and it may not import a workflow module. Declaring them where
 * both sides can read them is the alternative to a hand-copy on the site that
 * drifts the day a field is added.
 */
export type {
  AuditProgress,
  AuditSiteInput,
  AuditSiteState,
  AuditStep,
  AuditTier,
  StepState,
} from '../lib/agent-audit/deep-contract.js';

/**
 * The whole status-and-report contract in one query.
 *
 * One query rather than a `getStatus` / `getResult` pair: the result *is* the
 * terminal status, and two handlers would let a caller see `complete` from one
 * and `undefined` from the other. A query on a closed execution is answered from
 * replayed history, so this keeps serving the finished document after the
 * workflow completes, for as long as the retention period keeps the history.
 */
export const getAuditState = wf.defineQuery<AuditSiteState>('getAuditState');

/** The fast tier's `startToCloseTimeout`. Past `FAST_BUDGET_SECONDS` (120). */
const FAST_TIMEOUT = '6 minutes';

/**
 * The fetch pass's. Past the deep budget's fetch half with room for the sampling
 * loop, and nowhere near the 20 minutes the whole deep tier used to need — the
 * pages have their own deadlines now.
 */
const FETCH_TIMEOUT = '8 minutes';

/**
 * One page's. `PAGE_TIMEOUT_MS` is 90s and the activity enforces it itself; this
 * is the outer bound that catches a page which wedged before its own deadline
 * could fire, plus the Chrome launch and teardown around it.
 */
const PAGE_TIMEOUT = '5 minutes';

/**
 * Heartbeats every 5s from inside the activity (see `activities/agent-audit.ts`),
 * so a 30-second heartbeat timeout detects a wedged Chrome long before any
 * `startToCloseTimeout`.
 *
 * **One attempt for anything that fetches the site's own surfaces.** A retry
 * there re-runs a dozen-plus requests against a stranger's origin from the
 * beginning, and the audit is already built so that a failure it can describe
 * comes back as a check rather than a throw (`result.ts`'s `error` status) — an
 * activity that actually threw hit something a second identical run would hit
 * too, and being polite to a stranger's server outranks a second chance at a
 * document nobody is waiting synchronously for.
 */
const fetching = wf.proxyActivities<Pick<typeof activities, 'auditSiteFetchChecks'>>({
  taskQueue: QUEUE_AUDIT,
  startToCloseTimeout: FETCH_TIMEOUT,
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

const fast = wf.proxyActivities<Pick<typeof activities, 'auditSiteFast'>>({
  taskQueue: QUEUE_AUDIT,
  startToCloseTimeout: FAST_TIMEOUT,
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

/**
 * **Two attempts, and this is the one place in the audit that retries.**
 *
 * The card's rule: an infrastructure failure retries the smallest unit that owns
 * its own network work, and a site failing a check never retries. One page is
 * that smallest unit. The activity is written so those are different *kinds* of
 * outcome rather than different messages — everything it can describe about a
 * page comes back on the return value, and the only throw is
 * `BrowserUnavailable`, meaning no browser started. So the retry can only ever
 * fire on a wedged Chrome, which is exactly what a second attempt is for.
 *
 * `BlockedTarget` is listed non-retryable even though the same reasoning already
 * makes it a `nonRetryable` failure at the throw site: this is the policy a
 * reader checks first, and it should not depend on the activity to be right.
 */
const rendering = wf.proxyActivities<Pick<typeof activities, 'auditRenderedPage'>>({
  taskQueue: QUEUE_AUDIT,
  startToCloseTimeout: PAGE_TIMEOUT,
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2, nonRetryableErrorTypes: ['BlockedTarget'] },
});

/** Assembly touches no network. One attempt because a second would be identical. */
const assembling = wf.proxyActivities<Pick<typeof activities, 'assembleDeepAudit'>>({
  taskQueue: QUEUE_AUDIT,
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

/** Counts a document's findings for the one-line note. */
function summarise(audit: AuditResult): string {
  const failed = audit.checks.filter((c) => c.status === 'fail').length;
  const errored = audit.checks.filter((c) => c.status === 'error').length;
  const findings = failed === 0 ? 'no failing checks' : `${failed} failing check${failed === 1 ? '' : 's'}`;
  const unjudged = errored === 0 ? '' : `, ${errored} the auditor could not judge`;
  return `${audit.target.origin}: ${findings}${unjudged}`;
}

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
 * The failure's own type, from the `ApplicationFailure` the activity raised.
 *
 * The card's rule made concrete: "a page this auditor may not open" and "no
 * browser started" are told apart by `BlockedTarget` vs `BrowserUnavailable`,
 * never by matching on message text. A message is prose that gets reworded; a
 * type is a contract, and it is what the retry policy above already keys on.
 */
function failureType(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current instanceof wf.ApplicationFailure && current.type) return current.type;
    current = (current as Error).cause;
  }
  return undefined;
}

export async function auditSiteWorkflow(input: AuditSiteInput): Promise<AuditResult> {
  const state: AuditSiteState = {
    url: input.url,
    tier: input.tier,
    phase: 'auditing',
    note:
      input.tier === 'deep'
        ? `rendering pages of ${input.url} — this takes minutes`
        : `checking ${input.url} over HTTP`,
    progress: { phase: 'fetching', steps: [], checks: [] },
  };
  wf.setHandler(getAuditState, () => state);

  const budgetMs = input.budgetSeconds * 1000;
  const audit =
    input.tier === 'deep'
      ? await runDeep(input, budgetMs, state)
      : await runFast(input, budgetMs, state);

  state.phase = 'complete';
  state.progress.phase = 'complete';
  state.note = summarise(audit);
  state.result = audit;

  wf.log.info('agent-readiness audit complete', {
    url: input.url,
    tier: input.tier,
    origin: audit.target.origin,
    requests: audit.requests,
    durationMs: audit.durationMs,
  });

  return audit;
}

/** The fast tier: one activity, one step. */
async function runFast(
  input: AuditSiteInput,
  budgetMs: number,
  state: AuditSiteState,
): Promise<AuditResult> {
  const step: AuditStep = {
    id: 'fetch',
    kind: 'fetch',
    label: 'the fetch-based checks',
    state: 'running',
  };
  state.progress.steps.push(step);
  const audit = await fast.auditSiteFast(input.url, { budgetMs });
  step.state = 'done';
  state.progress.checks = audit.checks.map((c) => ({ id: c.id, title: c.title, status: c.status }));
  return audit;
}

/**
 * The deep tier: fetch pass, then one activity per sampled page, then assembly.
 *
 * The pages run **serially**, and the loop is a plain `for` rather than a capped
 * `Promise.all` because the cap would be 1: Lighthouse corrupts its own timing
 * marks when two runs share a Node process (`scorecard-audit.ts`'s
 * `AUDIT_CONCURRENCY` docblock has the failure and the evidence). A hosted worker
 * running two strangers' deep audits contends for the same reason, which is why
 * the deep tier gets its own rate limits rather than a higher concurrency.
 *
 * Every per-page failure is guarded into a skip rather than failing the run
 * (design rule 4), so a site that breaks one page still gets a report about the
 * rest.
 */
async function runDeep(
  input: AuditSiteInput,
  budgetMs: number,
  state: AuditSiteState,
): Promise<AuditResult> {
  const startedMs = Date.now();
  const fetchStep: AuditStep = {
    id: 'fetch',
    kind: 'fetch',
    label: 'the fetch-based checks',
    state: 'running',
  };
  state.progress.steps.push(fetchStep);

  const fetched = await fetching.auditSiteFetchChecks(input.url, {
    budgetMs,
    maxPages: MAX_PAGES,
  });
  fetchStep.state = 'done';
  state.progress.checks = fetched.result.checks.map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
  }));
  state.progress.phase = 'rendering';

  const pageSteps = fetched.sample.map(
    (candidate): AuditStep => ({
      id: `page:${candidate.url}`,
      kind: 'page',
      label: `${candidate.url} rendered in a browser`,
      state: 'pending',
    }),
  );
  state.progress.steps.push(...pageSteps);
  state.note = `rendering ${fetched.sample.length} page(s) of ${fetched.result.target.origin}`;

  const pages: RenderedPageOutcome[] = [];
  const skipped: SkippedPage[] = [];
  const progressNotes: string[] = [];
  let browserFailure: string | null = null;

  for (let i = 0; i < fetched.sample.length; i++) {
    const candidate = fetched.sample[i];
    const step = pageSteps[i];

    if (candidate.disallowedBy) {
      skipped.push({ url: candidate.url, reason: candidate.disallowedBy, robots: true });
      step.state = 'skipped';
      step.detail = candidate.disallowedBy;
      continue;
    }

    // The audit's one shared budget, read across activity boundaries rather than
    // from a fetcher this workflow does not have. `Date.now()` is the workflow
    // task's timestamp, which replay reproduces exactly, so this decision is
    // deterministic even though it is about elapsed time.
    const remaining = budgetMs - (Date.now() - startedMs);
    if (remaining < MIN_PAGE_BUDGET_MS) {
      const reason =
        `the audit's shared time budget had ${(remaining / 1000).toFixed(1)}s left, ` +
        `less than the ${MIN_PAGE_BUDGET_MS / 1000}s a page needs`;
      skipped.push({ url: candidate.url, reason, robots: false });
      step.state = 'skipped';
      step.detail = reason;
      continue;
    }

    const slice = Math.min(PAGE_TIMEOUT_MS, remaining);
    step.state = 'running';
    try {
      pages.push(await rendering.auditRenderedPage({ url: candidate.url, timeoutMs: slice }));
      step.state = 'done';
    } catch (err) {
      const detail = describeActivityError(err);
      step.state = 'failed';
      step.detail = detail;
      // A page the address guard would not open is a fact about that page, and
      // the next one may be fine. Read off the failure's type, never its wording.
      if (failureType(err) === 'BlockedTarget') {
        skipped.push({ url: candidate.url, reason: detail, robots: false });
        continue;
      }
      // A browser that will not start fails identically on every page, so trying
      // the rest spends the budget to learn the same thing three times. The
      // activity retried it already — this is the second attempt's verdict.
      browserFailure = detail;
      progressNotes.push(
        `Deep tier: neither tool produced a result for ${candidate.url} (${detail}), so the ` +
          'remaining pages were not attempted. The fast-tier checks above are unaffected.',
      );
      // Marked on the steps, not pushed into `skipped`: the report's skip list is
      // for pages this run made a decision about, and these were simply never
      // reached. `browserFailure` is what the checks report instead.
      for (const later of pageSteps.slice(i + 1)) {
        later.state = 'skipped';
        later.detail = 'the browser did not produce a result for an earlier page';
      }
      break;
    }

    const rendered = pages[pages.length - 1];
    if (rendered.timedOut) {
      progressNotes.push(
        `Deep tier: ${candidate.url} did not finish rendering inside its ${Math.round(slice / 1000)}s slice of ` +
          'the budget. That is a fact about this page, not about the browser, so the remaining ' +
          'pages were still attempted.',
      );
    }
  }

  const assemblyStep: AuditStep = {
    id: 'assembly',
    kind: 'assembly',
    label: 'assembling the report',
    state: 'running',
  };
  state.progress.steps.push(assemblyStep);
  state.progress.phase = 'assembling';

  const audit = await assembling.assembleDeepAudit({
    fast: fetched.result,
    pages,
    skipped,
    sample: fetched.sample.map((c) => c.url),
    available: fetched.available,
    browserFailure,
    progressNotes,
  });
  assemblyStep.state = 'done';
  state.progress.checks = audit.checks.map((c) => ({ id: c.id, title: c.title, status: c.status }));
  return audit;
}
