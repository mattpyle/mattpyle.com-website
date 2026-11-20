import { Context } from '@temporalio/activity';

/** Heartbeat cadence. Comfortably inside the 30s `heartbeatTimeout` the stubs set. */
export const HEARTBEAT_MS = 5_000;

/**
 * Runs work under a heartbeat pump, the same discipline `auditLiveUrl` and
 * `buildAndAuditDraft` use: a deep page is a minute-plus of Chrome, and an
 * activity that never heartbeats can neither be detected as wedged nor told it
 * was cancelled.
 *
 * `what` is the heartbeat's details and is written to the run's pending
 * activity, so keep it short and the caller's own words.
 */
export async function withHeartbeat<T>(what: string, run: () => Promise<T>): Promise<T> {
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
