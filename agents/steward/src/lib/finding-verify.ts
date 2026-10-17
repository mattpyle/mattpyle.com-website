import { WorkflowNotFoundError } from '@temporalio/client';

/**
 * What `steward finding verify` does after a hand verify ends `resolved`: the
 * finding's open lifecycle run, `finding/<site>/<key>`, is cancelled.
 *
 * A `reopened` finding gets a fresh lifecycle run from the reconciler, parked
 * at its verdict. When a corrected check then resolves the finding by hand,
 * that run has nothing left to do, and `steward finding approve` on it would
 * open a fix issue for a fix that is already live. A `fixing` finding's run,
 * still waiting on the merge or the deploy, would run its own verify against a
 * finding that is no longer `fixing`. Either way the run is cancelled.
 *
 * After `reopened` the run is left where it is: the finding still needs a
 * verdict or a fix.
 */

/** The two calls this needs from a `WorkflowHandle`. */
export interface LifecycleRunHandle {
  workflowId: string;
  describe(): Promise<{ status: { name: string } }>;
  cancel(): Promise<unknown>;
  result(): Promise<unknown>;
}

export type LifecycleRunClosed =
  /** No run was open: none started, or it already ended. */
  | 'none'
  /** The run was cancelled and has closed. */
  | 'cancelled'
  /** Cancellation was requested and the run had not closed by the deadline. */
  | 'requested';

/** How long the CLI waits for a cancelled run to close before it says the request stands. */
export const LIFECYCLE_CANCEL_WAIT_MS = 60_000;

export async function cancelLifecycleRun(
  handle: LifecycleRunHandle,
  waitMs = LIFECYCLE_CANCEL_WAIT_MS,
): Promise<LifecycleRunClosed> {
  try {
    if ((await handle.describe()).status.name !== 'RUNNING') return 'none';
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return 'none';
    throw err;
  }
  await handle.cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    handle.result().then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    }),
  ]);
  clearTimeout(timer);
  return closed ? 'cancelled' : 'requested';
}
