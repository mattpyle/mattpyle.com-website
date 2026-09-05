import type { AuditResult, CheckStatus } from './result.js';

/**
 * The deep tier's wire contract: the names a caller needs to start one and read
 * it back, and the shape of what it answers with.
 *
 * The second entry `@mattpyle/steward`'s exports map publishes, and the argument
 * for it is the same one the first entry's docblock makes, applied to a different
 * consumer. The site's `/mcp` function starts `auditSiteWorkflow` on the Cloud
 * namespace and polls its query; to do that it needs a workflow type name, a task
 * queue, a query name, a workflow-ID scheme, a budget, and the type of what comes
 * back. Every one of those already exists somewhere in this workspace, and every
 * one of them is a string or a type — so the choice is between publishing them
 * and typing a second copy of them into the site, where the two can silently
 * drift apart on the day one of them changes.
 *
 * **Nothing here imports anything at runtime, and that is the whole entry.** The
 * one import is `import type`, erased before any bundler sees it. So this entry
 * adds no package to the site's function bundle: the Temporal client the function
 * needs is the site's own dependency, called with names from here rather than
 * with names re-typed there. `tests/steward-deep-contract-packaging.test.mjs` in
 * the site repo walks this graph and fails on any value import at all, which is a
 * stricter rule than the fast entry's denylist and is the reason a second entry
 * was affordable.
 *
 * It is also sandbox-safe by the same property, which is why
 * `workflows/audit-site.ts` reads its own types from here rather than declaring
 * them and leaving the site to copy them: a module that touches no `node:` API
 * and no clock is a module a workflow may import.
 */

/** The workflow the deep tier runs. Started by type name, so no client loads the workflow module. */
export const AUDIT_WORKFLOW_TYPE = 'auditSiteWorkflow';

/**
 * The audit's own task queue. The hosted worker polls this and nothing else, which
 * is what makes a deep audit finish without Matt's desktop being on.
 *
 * `config.ts` re-exports this as `QUEUE_AUDIT`; `workflows/audit-site.ts` still
 * writes the literal, because the workflow sandbox rule there is about the module
 * it used to import from rather than about this one, and a test holds the two equal.
 */
export const AUDIT_TASK_QUEUE = 'steward-audit';

/** The query `getAuditState` is registered under. Queried by name, for the reason above. */
export const AUDIT_STATE_QUERY = 'getAuditState';

/** The per-tier wall-clock budgets, matching `audit-url`'s defaults in cli.ts. */
export const FAST_BUDGET_SECONDS = 120;
export const DEEP_BUDGET_SECONDS = 420;

export type AuditTier = 'fast' | 'deep';

/**
 * The workflow ID for one `auditSiteWorkflow` execution.
 *
 * Host, then tier, then a random suffix. The host and tier are there so the
 * Temporal UI's workflow list is readable without opening anything — an audit's
 * ID is the only label a poller ever sees — and the suffix is there because two
 * audits of the same site are two runs, not one. Deliberately **not** derived
 * from the URL alone: a re-audit must never collide with, or be mistaken for,
 * the earlier run's result.
 *
 * `id` is supplied by the caller rather than generated here so this stays a pure
 * function; both MCP surfaces pass `randomUUID().slice(0, 8)`.
 */
export function auditWorkflowIdFor(origin: string, tier: AuditTier, id: string): string {
  const host = new URL(origin).host.replace(/[^a-z0-9.-]/gi, '-');
  return `steward-audit-${host}-${tier}-${id}`;
}

export interface AuditSiteInput {
  /** Exactly what the caller typed — `https://example.com`, or just `example.com`. */
  url: string;
  /**
   * Which tier to run.
   *
   * **In the input, never in config** (design rule 10, spec §2). It picks which
   * activities are scheduled, all of which are recorded in history as part of
   * the command; a config-driven tier would send every open execution's replay
   * down the other branch the moment it flipped.
   */
  tier: AuditTier;
  /**
   * Total wall-clock budget for the audit, in seconds. Resolved by the caller
   * from the tier's default above, never re-read inside the workflow.
   *
   * It rides in the input for the same reason the tier does, one step weaker:
   * it does not change *which* activity runs, but it does change what the
   * finished document says — a run that exhausts its budget reports the
   * remaining checks as `error` and its unrendered pages as skipped, and that
   * verdict has to be reproducible from history rather than from whatever the
   * constant says today.
   */
  budgetSeconds: number;
}

/**
 * What one unit of durable work is doing.
 *
 * `pending` and `running` are the workflow's own account; `done` and `failed`
 * are what it observed the activity return or throw. Nothing here is inferred
 * from a timer, and nothing here is a retry count — an attempt number lives in
 * `DescribeWorkflowExecution`'s pending-activity info, which is the server's to
 * report and a client's to combine with this.
 */
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface AuditStep {
  /** Stable within one run: `fetch`, `page:<url>`, `assembly`. */
  id: string;
  kind: 'fetch' | 'page' | 'assembly';
  /** One line naming what this step covers, for a human reading the status. */
  label: string;
  state: StepState;
  /** Why a step is `failed` or `skipped`. Absent otherwise. */
  detail?: string;
}

/**
 * The progress contract, served to strangers by the public `get_audit(view: status)`.
 *
 * Two granularities, from two different sources, deliberately kept apart:
 *
 * - `steps` is the durable work — the fetch pass, each rendered page, assembly.
 *   One step is one activity, so this is exactly what workflow history knows and
 *   nothing more.
 * - `checks` is the audit's own verdicts, and it fills in as they are decided:
 *   empty while the fetch pass runs, then every fast-tier check with its status,
 *   then nothing further until the finished report supersedes it.
 *
 * A caller wanting "which check are we on" reads `checks`; a caller wanting
 * "how much is left" reads `steps`. Merging them into one list would mean
 * inventing a `pending` row per fast-tier check, which would be a guess about a
 * check list the workflow has not been told yet.
 */
export interface AuditProgress {
  phase: 'fetching' | 'rendering' | 'assembling' | 'complete' | 'failed';
  steps: AuditStep[];
  checks: Array<{ id: string; title: string; status: CheckStatus }>;
}

/**
 * What a poller sees. `phase` is the workflow's own account of itself; the
 * execution status a caller gets from `describe()` is the server's, and the two
 * answer different questions — `describe()` knows the workflow failed, this
 * knows the audit was mid-render when it did.
 */
export interface AuditSiteState {
  url: string;
  tier: AuditTier;
  phase: 'auditing' | 'complete';
  /** One line for a human watching: what the run is doing, or what it found. */
  note: string;
  /** Per-step and per-check detail. Additive since stage 3; see `AuditProgress`. */
  progress: AuditProgress;
  /** The canonical result document. Present once `phase` is `complete`. */
  result?: AuditResult;
}

/**
 * One activity Temporal reports as in flight, reduced to what a status view says
 * out loud.
 *
 * This is the half of the status the workflow cannot know about itself. An
 * attempt number is the server's account of how many times it has scheduled the
 * same activity, and it only exists in `DescribeWorkflowExecution`'s
 * pending-activity info — which is why "retrying, attempt 2" is assembled
 * client-side from Temporal rather than tracked by hand in the workflow, where it
 * would be a second, lagging copy of a fact the server already holds.
 */
export interface PendingActivity {
  /** The activity type, e.g. `auditRenderedPage`. */
  activityType: string;
  /** The activity id, which for the fan-out identifies which page. */
  activityId: string;
  /** 1 on the first try. Anything above 1 means this unit is being retried. */
  attempt: number;
  /**
   * `started` when a worker has this unit in hand, `scheduled` when it is waiting
   * for one. The difference is what tells a busy worker apart from an absent one,
   * which a progress query cannot do: rendering a page occupies the worker, so a
   * run that is very much being worked on will not answer a query either.
   */
  state: 'scheduled' | 'started';
  /** What the last attempt failed with, when there was one. */
  lastFailure?: string;
}

/**
 * The fast tier's activity type. Started standalone from the /mcp function, and
 * scheduled from `workflows/audit-site.ts` under the same name — one activity,
 * two ways of invoking it, which is the property standalone activities exist to
 * make true. The string is the exported function's name in
 * `activities/agent-audit.ts`, because that is how the SDK registers it.
 */
export const AUDIT_FAST_ACTIVITY_TYPE = 'auditSiteFast';

/**
 * The fast tier's own task queue, polled by a second worker in the hosted
 * container (`config.ts` re-exports it as `QUEUE_AUDIT_FAST`).
 *
 * Split from `AUDIT_TASK_QUEUE` for latency rather than for locality. The audit
 * queue's worker takes one activity at a time — the serial-Lighthouse rule in
 * `HOSTED_ACTIVITY_CONCURRENCY` — so a fast audit sharing that queue would sit
 * behind a 90-second page render, or behind the nightly scorecard's twelve
 * minutes, on a request a caller is holding open. A public tool cannot have that
 * as its p99. Its worker runs no browser, so its concurrency is a throughput
 * choice rather than a correctness one.
 */
export const AUDIT_FAST_TASK_QUEUE = 'steward-audit-fast';

/**
 * The activity ID for one standalone fast audit: `audit:<origin>:<UTC hour>`.
 *
 * The ID *is* the deduplication. Two agents asking about the same site in the
 * same hour name the same activity, so with `USE_EXISTING` the second attaches
 * to the first's run and with `REJECT_DUPLICATE` it reads the finished result
 * back instead of auditing the site again. That is one visit to a stranger's
 * origin per site per hour rather than one per caller, which is the courtesy
 * this auditor's whole public story rests on.
 *
 * UTC and hour-granularity, deliberately. UTC because the ID is a machine bucket
 * and a local-time bucket would repeat and skip an hour twice a year; hourly
 * because a site's agent surfaces do not change in minutes, and because an
 * agent-readiness answer an hour old is still a true answer about the site.
 *
 * `at` is passed in rather than read from the clock so this stays a pure
 * function, the same rule `auditWorkflowIdFor` follows.
 */
export function fastAuditActivityIdFor(origin: string, at: Date): string {
  const hour = at.toISOString().slice(0, 13);
  return `audit:${origin}:${hour}`;
}
