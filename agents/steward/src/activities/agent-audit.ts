import { ApplicationFailure, Context } from '@temporalio/activity';
import { log } from '../lib/logger.js';
import { runAudit, runFastAudit } from '../lib/agent-audit/checks.js';
import { BlockedTargetError } from '../lib/agent-audit/safe-fetch.js';
import type { AuditResult } from '../lib/agent-audit/result.js';

/**
 * The two tiers as activities, one per tier.
 *
 * The audit is I/O against a stranger's origin — the textbook activity — and
 * `lib/agent-audit/` stays plain testable TypeScript with no Temporal imports.
 * This file is the only place that knows about the runtime, the same split
 * `audit-engine.ts` and `activities/scorecard.ts` already use.
 *
 * Two functions rather than one with a `deep` flag, because the tier decides the
 * task queue: the deep tier launches Chrome and belongs on the heavy queue, the
 * fast tier is a dozen HTTP round trips and belongs on the light one. A workflow
 * routes by calling a different stub, and a stub is per activity name — see
 * `workflows/audit-site.ts`.
 *
 * Result size is bounded by construction: the document carries an excerpt per
 * check rather than any response body, which is what keeps it inside Temporal's
 * payload limits. Real deep-tier documents run 11–17 KB. If a later tier wants
 * full bodies, they go to disk and the result carries the path.
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
 * Runs one tier under a heartbeat pump, the same discipline `auditLiveUrl` and
 * `buildAndAuditDraft` use: a deep audit is minutes of Chrome, and an activity
 * that never heartbeats can neither be detected as wedged nor told it was
 * cancelled.
 *
 * A refused target is converted to a **non-retryable** failure. `runAudit`
 * throws only for a target it cannot audit at all, and the SSRF guard refusing a
 * private address is a verdict about the request, not a transient fault — three
 * attempts would produce the same refusal three times and bury the reason under
 * a retry history.
 */
async function withHeartbeat(
  tier: 'fast' | 'deep',
  input: string,
  run: () => Promise<AuditResult>,
): Promise<AuditResult> {
  const ctx = Context.current();
  const beat = () => ctx.heartbeat(`${tier} audit of ${input}`);
  const pump = setInterval(beat, HEARTBEAT_MS);
  try {
    beat();
    const audit = await run();
    log.info(
      {
        activity: tier === 'fast' ? 'auditSiteFast' : 'auditSiteDeep',
        origin: audit.target.origin,
        requests: audit.requests,
        browserPages: audit.browserPages,
        durationMs: audit.durationMs,
        failed: audit.checks.filter((c) => c.status === 'fail').map((c) => c.id),
      },
      `${tier} agent-readiness audit complete`,
    );
    return audit;
  } catch (err) {
    if (err instanceof BlockedTargetError) {
      throw ApplicationFailure.nonRetryable(
        `refused to audit ${err.url}: ${err.reason}`,
        'BlockedTarget',
      );
    }
    throw err;
  } finally {
    clearInterval(pump);
  }
}

/** The fast tier: the agent surfaces over plain HTTP. No browser, light queue. */
export async function auditSiteFast(
  input: string,
  options: AuditActivityOptions = {},
): Promise<AuditResult> {
  return withHeartbeat('fast', input, () => runFastAudit(input, engineOptions(options)));
}

/**
 * Both tiers: the fast checks plus Lighthouse and axe over a sample of rendered
 * pages. Launches Chrome, so it runs on the heavy queue.
 */
export async function auditSiteDeep(
  input: string,
  options: AuditActivityOptions = {},
): Promise<AuditResult> {
  return withHeartbeat('deep', input, () => runAudit(input, engineOptions(options)));
}
