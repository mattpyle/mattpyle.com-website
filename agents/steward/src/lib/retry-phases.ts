// Workflow-safe: `@temporalio/common` only, so `findingWorkflow` and
// `verifyFindingWorkflow` both import it into their bundle.
import { ActivityFailure, ApplicationFailure } from '@temporalio/common';

/**
 * The slow phase of Temporal's Fast/Slow Retries (STW-653): a fixed interval
 * and no attempt limit, once an activity's fast retries are used up. The top
 * of the documented range ("1–15 minutes: long enough to avoid hammering a
 * down system; short enough to recover promptly"). An unreachable production
 * costs up to 30 seconds a check, so a twelve-check block holds one of the
 * hosted worker's two findings slots for up to six minutes; at a quarter of an
 * hour a stuck verify holds at most about 40 per cent of one slot.
 */
export const SLOW_INTERVAL = '15 minutes';

/**
 * True for a fast phase that ended on a failure the slow phase is for: its
 * attempts used up on a retryable failure, or a rejected credential, which
 * the GitHub client throws non-retryable but which a token rotation mends.
 */
export function slowPhaseFor(err: unknown): boolean {
  if (!(err instanceof ActivityFailure)) return false;
  if (err.retryState === 'MAXIMUM_ATTEMPTS_REACHED' || err.retryState === 'TIMEOUT') return true;
  return err.cause instanceof ApplicationFailure && err.cause.type === 'AuthError';
}
