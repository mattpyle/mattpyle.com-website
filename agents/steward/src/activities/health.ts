import { sendHealthPing, type HealthPingOutcome } from '../lib/health-ping.js';
import { log } from '../lib/logger.js';
import {
  CREDENTIAL_WARNING_DAYS,
  TRACKED_CREDENTIALS,
  credentialExpiryShape,
  credentialsDueWithin,
  type HealthSignal,
  type RunShape,
} from '../lib/run-health.js';

/**
 * The two alerting activities (audit-stack-alerting-and-monitoring card).
 *
 * Activities rather than workflow code for the two usual reasons and one that is
 * specific to alerting: they make a network call, they read the environment, and
 * the thing they read — the ping base — must stay out of workflow history so it
 * can be changed without rewriting the past of an open run (spec §13).
 *
 * **Neither of them can fail a run.** `sendHealthPing` swallows every transport
 * failure by design; these wrappers add no throw of their own. An alert that
 * takes the run down with it is worse than no alert, and the dead-man's half of
 * the design already covers a ping that never arrives.
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
