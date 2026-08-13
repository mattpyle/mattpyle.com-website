import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AuditResult } from '../lib/agent-audit/result.js';

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
 * waits on a human. The whole workflow is one activity plus a query.
 */

// Queue names duplicated here rather than imported from config.ts — the same
// reason review-post.ts and scorecard-audit.ts do it: config.ts touches
// `node:path` and `process.env`, neither available in the workflow sandbox.
const QUEUE_LIGHT = 'steward-light';
const QUEUE_HEAVY = 'steward-heavy';

export type AuditTier = 'fast' | 'deep';

export interface AuditSiteInput {
  /** Exactly what the caller typed — `https://example.com`, or just `example.com`. */
  url: string;
  /**
   * Which tier to run.
   *
   * **In the input, never in config** (design rule 10, spec §2). It picks which
   * activity is scheduled and on which task queue, both of which are recorded in
   * history as part of the command; a config-driven tier would send every open
   * execution's replay down the other branch the moment it flipped.
   */
  tier: AuditTier;
  /**
   * Total wall-clock budget for the audit, in seconds. Resolved by the caller
   * from the tier's default (`FAST_BUDGET_SECONDS` / `DEEP_BUDGET_SECONDS` in
   * cli.ts), never re-read here.
   *
   * It rides in the input for the same reason the tier does, one step weaker:
   * it does not change *which* activity runs, but it does change what the
   * finished document says — a run that exhausts its budget reports the
   * remaining checks as `error`, and that verdict has to be reproducible from
   * history rather than from whatever the constant says today.
   */
  budgetSeconds: number;
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
  /** The canonical result document. Present once `phase` is `complete`. */
  result?: AuditResult;
}

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

/**
 * The deep tier's `startToCloseTimeout`. Generously past `DEEP_BUDGET_SECONDS`
 * (420) because the budget bounds the audit's own checks, not the Chrome
 * launches and teardowns around them, and an activity killed at its deadline
 * loses a document the budget would have returned.
 */
const DEEP_TIMEOUT = '20 minutes';

/** The fast tier's. Past `FAST_BUDGET_SECONDS` (120) by the same reasoning. */
const FAST_TIMEOUT = '6 minutes';

/**
 * Heartbeats every 5s from inside the activity (see `activities/agent-audit.ts`),
 * so a 30-second heartbeat timeout detects a wedged Chrome long before either
 * `startToCloseTimeout` above.
 *
 * **One attempt, both tiers.** A retry would re-run the whole audit against
 * somebody else's origin from the beginning, which is a dozen-plus requests and,
 * on the deep tier, three more browser page loads. The audit is already built so
 * that a failure it can describe comes back as a check rather than a throw
 * (`result.ts`'s `error` status), so an activity that actually threw hit
 * something a second identical run would hit too — and being polite to a
 * stranger's server outranks a second chance at a document nobody is waiting
 * synchronously for.
 */
const deep = wf.proxyActivities<Pick<typeof activities, 'auditSiteDeep'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: DEEP_TIMEOUT,
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

const fast = wf.proxyActivities<Pick<typeof activities, 'auditSiteFast'>>({
  taskQueue: QUEUE_LIGHT,
  startToCloseTimeout: FAST_TIMEOUT,
  heartbeatTimeout: '30 seconds',
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

export async function auditSiteWorkflow(input: AuditSiteInput): Promise<AuditResult> {
  const state: AuditSiteState = {
    url: input.url,
    tier: input.tier,
    phase: 'auditing',
    note:
      input.tier === 'deep'
        ? `rendering pages of ${input.url} — this takes minutes`
        : `checking ${input.url} over HTTP`,
  };
  wf.setHandler(getAuditState, () => state);

  const options = { budgetMs: input.budgetSeconds * 1000 };
  const audit =
    input.tier === 'deep'
      ? await deep.auditSiteDeep(input.url, options)
      : await fast.auditSiteFast(input.url, options);

  state.phase = 'complete';
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
