import { METRICS_API_KEY, NAMESPACE } from '../config.js';
import { sampleActionUsage } from '../lib/action-usage.js';
import { sendHealthPing, type HealthPingOutcome } from '../lib/health-ping.js';
import { log } from '../lib/logger.js';
import {
  ACTION_RATE_ALERT_PER_SECOND,
  CREDENTIAL_WARNING_DAYS,
  TRACKED_CREDENTIALS,
  actionUsageShape,
  actionUsageUnavailableShape,
  credentialExpiryShape,
  credentialsDueWithin,
  type HealthSignal,
  type RunShape,
} from '../lib/run-health.js';

/**
 * The three alerting activities (audit-stack-alerting-and-monitoring card, and
 * temporal-cloud-usage-alerting for the third).
 *
 * Activities rather than workflow code for the two usual reasons and one that is
 * specific to alerting: they make a network call, they read the environment, and
 * the thing they read — the ping base — must stay out of workflow history so it
 * can be changed without rewriting the past of an open run (spec §13).
 *
 * **None of them can fail a run.** `sendHealthPing` swallows every transport
 * failure by design; these wrappers add no throw of their own. An alert that
 * takes the run down with it is worse than no alert, and the dead-man's half of
 * the design already covers a ping that never arrives. `checkActionUsage` has to
 * work a little harder for the same property: it makes a second network call, to
 * a different vendor, and catches that one too.
 */

/** What the workflow asks for: a decided verdict, ready to send. */
export interface ReportRunHealthInput {
  signal: HealthSignal;
  shape: RunShape;
}

/**
 * Sends one already-decided signal.
 *
 * The verdict is computed by the caller — `scorecardRunShape` in the workflow,
 * `deepAuditShape` in assembly — rather than here, so the rule that defines a
 * bad run is one pure function with a unit test rather than something that only
 * happens on the way out the door.
 */
export async function reportRunHealth(input: ReportRunHealthInput): Promise<HealthPingOutcome> {
  return sendHealthPing(input.signal, input.shape);
}

export interface CredentialExpiryOutcome extends HealthPingOutcome {
  /** The verdict, so the workflow can log it whether or not the ping went out. */
  summary: string;
  /** How many tracked credentials sit inside the warning window. */
  dueCount: number;
}

/**
 * Checks every dated credential against today and signals the result.
 *
 * The list and the clock both live here rather than in the workflow: the list is
 * a module constant, and a workflow that read it would re-read it at replay,
 * which is the config-driven decision design rule 10 exists to prevent. Inside
 * an activity both are ordinary reads.
 *
 * The nightly scorecard owns the cadence (card, 2026-08-15). It is a daily run
 * that already exists, and a warning window measured in weeks does not need its
 * own schedule — one more thing to create is one more thing to notice has
 * stopped.
 */
export async function checkCredentialExpiry(): Promise<CredentialExpiryOutcome> {
  const now = Date.now();
  const shape = credentialExpiryShape(TRACKED_CREDENTIALS, now, CREDENTIAL_WARNING_DAYS);
  const dueCount = credentialsDueWithin(TRACKED_CREDENTIALS, now, CREDENTIAL_WARNING_DAYS).length;
  log.info(
    { activity: 'checkCredentialExpiry', ok: shape.ok, tracked: TRACKED_CREDENTIALS.length },
    shape.ok ? 'no tracked credential is near expiry' : 'a tracked credential is near expiry',
  );
  const outcome = await sendHealthPing('credential-expiry', shape);
  return { ...outcome, summary: shape.summary, dueCount };
}

export interface ActionUsageOutcome extends HealthPingOutcome {
  /** The verdict, so the workflow can log it whether or not the ping went out. */
  summary: string;
  /**
   * Foreground actions per second in the sampled minute, or null when the
   * sample could not be taken. Returned as a number so the workflow's log line
   * carries the rate without anybody parsing prose out of `summary`.
   */
  foregroundPerSecond: number | null;
}

/**
 * Samples the namespace's Temporal Cloud action rate and signals the result
 * (temporal-cloud-usage-alerting card).
 *
 * The one spend surface on this account that bills past its credits rather than
 * refusing, and Temporal Cloud's own UI offers no alert on it. The Cloud usage
 * page shows what was spent; nothing there says "this is happening now", which
 * is what a runaway loop needs somebody to be told.
 *
 * **A sample that could not be taken is a fail ping, not a skip** (card decision
 * 4). An endpoint that stopped answering, a key that expired, a role that lost
 * its permission: each of those retires the check silently unless it says so,
 * and a monitor that goes quiet when it breaks is worse than no monitor, because
 * its silence reads as good news.
 *
 * **Unconfigured is the one case that stays quiet**, and it is the exception
 * that has to be written out rather than folded into the failure path above. An
 * unset key means the check is switched off, which is the documented state of a
 * fresh clone and of every test process — exactly the contract
 * `STEWARD_HEALTHCHECK_BASE` has in `lib/health-ping.ts`. Alerting about it
 * would train the operator to ignore this check, and pinging the slug green
 * would be worse still: it would hold the dead-man's switch down on a check
 * measuring nothing. So: an info log, no ping, and `sent: false` saying which.
 */
export async function checkActionUsage(): Promise<ActionUsageOutcome> {
  if (!METRICS_API_KEY) {
    const reason = 'TEMPORAL_METRICS_API_KEY is unset';
    log.info({ activity: 'checkActionUsage' }, `action usage not sampled — ${reason} (the check is off)`);
    return {
      signal: 'action-usage',
      ok: true,
      sent: false,
      reason,
      summary: `Action usage was not sampled: ${reason}, so the check is off.`,
      foregroundPerSecond: null,
    };
  }

  let shape: RunShape;
  let foregroundPerSecond: number | null = null;

  try {
    const sample = await sampleActionUsage();
    foregroundPerSecond = sample.foregroundPerSecond;
    shape = actionUsageShape(sample, ACTION_RATE_ALERT_PER_SECOND);
    log.info(
      {
        activity: 'checkActionUsage',
        ok: shape.ok,
        namespace: sample.namespace,
        foregroundPerSecond: sample.foregroundPerSecond,
        billableSeries: sample.billable.length,
        idle: sample.idle,
        threshold: ACTION_RATE_ALERT_PER_SECOND,
      },
      shape.ok ? 'action usage is within the alert threshold' : 'action usage is above the alert threshold',
    );
  } catch (err) {
    // One catch for every remaining failure path — a refused key, a 500, a
    // socket that never answers, a response this parser does not understand.
    // Deliberately not a list of the ones anticipated: the reason is prose in
    // the ping body either way, and a failure mode nobody thought of still
    // produces an alert rather than an exception out of an activity that
    // promised never to throw.
    const reason = err instanceof Error ? err.message : String(err);
    shape = actionUsageUnavailableShape(NAMESPACE, reason);
    log.warn(
      { activity: 'checkActionUsage', namespace: NAMESPACE, reason },
      'action usage could not be sampled',
    );
  }

  const outcome = await sendHealthPing('action-usage', shape);
  return { ...outcome, summary: shape.summary, foregroundPerSecond };
}
