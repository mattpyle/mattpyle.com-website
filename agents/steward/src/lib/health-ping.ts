import { HEALTHCHECK_BASE } from '../config.js';
import { log } from './logger.js';
import {
  HEALTH_CHECK_SLUGS,
  healthPingUrl,
  type HealthSignal,
  type RunShape,
} from './run-health.js';

/**
 * The alert transport: one HTTP POST to an external dead-man's-switch service.
 *
 * `lib/run-health.ts` decides what to say; this says it. Split because the
 * decision is the part worth testing and the sending is the part that needs a
 * network.
 *
 * ## Three properties this file exists to hold
 *
 * **It never throws.** An alert is a side channel. A scorecard run that measured
 * the site correctly must not fail because a monitoring service was down, and an
 * activity that raised here would do exactly that. Every failure is logged and
 * swallowed, and the return value says what happened.
 *
 * **A lost ping is still an alert.** If the send fails, no ping arrives — and the
 * healthy path's ping does not arrive either, so the check's own period lapses
 * and the service emails about the silence. The transport failing degrades a
 * specific alert into a late alert rather than into no alert, which is the
 * property that makes it safe for this code to give up quietly.
 *
 * **The URL is configuration, never a workflow input** (spec §13). It is read
 * from the environment at execution time, in an activity, so it is never written
 * into workflow history and a change to it takes effect on the next run rather
 * than rewriting the past of an open one.
 */

/** What a ping attempt did. Returned rather than thrown; see the docblock. */
export interface HealthPingOutcome {
  signal: HealthSignal;
  ok: boolean;
  /** False when the ping was not sent: unconfigured, or every attempt failed. */
  sent: boolean;
  /** Why it was not sent. Absent on success. */
  reason?: string;
}

/** Per-attempt deadline. The service answers in tens of milliseconds when healthy. */
const PING_TIMEOUT_MS = 10_000;

/** Attempts before giving up. Three, because the failure ping is the one that matters. */
const PING_ATTEMPTS = 3;

/** Fixed backoff between attempts. Short: the caller is an activity with a one-minute deadline. */
const PING_RETRY_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one signal. `shape.ok` picks the success or the `/fail` endpoint, and
 * `shape.summary` is the body, which the service quotes in the notification
 * email — so the body is the alert a human reads, not a log line.
 */
export async function sendHealthPing(
  signal: HealthSignal,
  shape: RunShape,
  base: string = HEALTHCHECK_BASE,
): Promise<HealthPingOutcome> {
  if (!base) {
    // Info, not warn: running with no alerting configured is the documented
    // state of a fresh clone and of every test process, and a warning per run
    // would train the operator to ignore the logs this file writes.
    log.info(
      { signal, ok: shape.ok },
      'health signal not sent — STEWARD_HEALTHCHECK_BASE is unset (alerting is off)',
    );
    return { signal, ok: shape.ok, sent: false, reason: 'STEWARD_HEALTHCHECK_BASE is unset' };
  }

  let url: string;
  try {
    url = healthPingUrl(base, signal, shape.ok);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`ping base must be http(s), got ${parsed.protocol}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ signal, reason }, 'health signal not sent — the configured ping base is not a URL');
    return { signal, ok: shape.ok, sent: false, reason };
  }

  let lastReason = '';
  for (let attempt = 1; attempt <= PING_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        // The service records the body and quotes it in the email. Plain text:
        // it is prose for a person, and a JSON envelope would put punctuation
        // between them and the sentence.
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: shape.summary,
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (response.ok) {
        log.info({ signal, ok: shape.ok, attempt }, 'health signal sent');
        return { signal, ok: shape.ok, sent: true };
      }
      // A 404 here means the check does not exist under that slug, which is a
      // configuration mistake rather than an outage — worth naming, and worth
      // not retrying past the loop, because it will 404 every time.
      lastReason = `the alerting service answered ${response.status}`;
      if (response.status === 404) {
        lastReason += ` — there is no check with the slug "${HEALTH_CHECK_SLUGS[signal]}" under that ping key`;
        break;
      }
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }
    if (attempt < PING_ATTEMPTS) await sleep(PING_RETRY_MS);
  }

  log.error(
    { signal, ok: shape.ok, reason: lastReason },
    'health signal could not be sent — the check will go late instead',
  );
  return { signal, ok: shape.ok, sent: false, reason: lastReason };
}
