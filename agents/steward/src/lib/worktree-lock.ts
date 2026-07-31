import { log } from './logger.js';

/**
 * A FIFO async mutex guarding `WORKTREE_DIR`.
 *
 * Three activities drive destructive git against the one shared worktree —
 * `buildAndAuditDraft` (reset --hard, clean -fdx, npm ci, build), `publishPost`
 * and `publishScorecardRun` (both checkout -B, clean -fd) — and until this
 * existed nothing stopped two of them running at once. The failure is not
 * hypothetical: a nightly scorecard publishing while an interactive review is
 * mid-build resets the tree under the build, which then compiles a mix of two
 * commits and reports the result as if it were the draft.
 *
 * Cheap concurrent work (spellcheck, Vale, the editorial pass) is untouched;
 * it never goes near the worktree, and serialising it would cost the fan-out
 * that makes a review fast.
 *
 * **The assumption this depends on: every activity runs in the single worker
 * process `worker.ts` starts.** Today that holds by construction — one process
 * creates both the light and heavy `Worker`s against one activity registry
 * (see the comment at `worker.ts`'s `main`). A module-level variable is a
 * correct mutex only under that assumption. If workers are ever split across
 * processes or machines (the local/cloud separation the queue split exists to
 * allow), this mechanism silently stops protecting anything and has to be
 * replaced by something the OS or the server can see: a lockfile with
 * `wx`-mode create plus stale detection, a per-worktree task queue with
 * `maxConcurrentActivityTaskExecutions: 1`, or one worktree per worker.
 *
 * Deliberately Temporal-free, like the rest of `lib/`: callers own heartbeats
 * and cancellation. `buildAndAuditDraft` runs a heartbeat pump against its
 * `heartbeatTimeout: '30 seconds'`; the two publish activities set no
 * `heartbeatTimeout` at all, so a publish waiting here stays healthy from
 * Temporal's point of view for the whole wait and its `startToCloseTimeout` is
 * the only thing that can end it. If a `heartbeatTimeout` is ever added to a
 * publish stub, this wait becomes a wedged-activity signal and the waiting
 * caller has to heartbeat through it.
 */

interface Waiter {
  holder: string;
  grant: () => void;
}

let currentHolder: string | undefined;
const waiters: Waiter[] = [];

/** Snapshot of the lock, for diagnostics and tests. Never used to make decisions. */
export function worktreeLockState(): { holder?: string; waiting: string[] } {
  return { holder: currentHolder, waiting: waiters.map((w) => w.holder) };
}

/**
 * Runs `fn` with exclusive access to the worktree.
 *
 * FIFO, so a long queue cannot starve the activity that arrived first. The lock
 * is released in a `finally`, so a throwing or cancelled critical section hands
 * it on rather than wedging every later worktree activity for the life of the
 * worker.
 *
 * **The wait is unbounded, deliberately: the caller's `startToCloseTimeout` is
 * the only deadline.** An earlier version let the two publish activities give up
 * after four minutes with a `WorktreeBusyError`, because their scheduled
 * `startToCloseTimeout` was five minutes and a bounded failure at least named the
 * cause. That was choosing which failure the human saw, not avoiding one: a
 * publish arriving mid-build could not outlast a 15-minute build audit either
 * way, and the cost landed on the one step where failure costs an approve the
 * human already sent. Both publish stubs now carry a 20-minute
 * `startToCloseTimeout` (`workflows/review-post.ts`,
 * `workflows/scorecard-audit.ts`), which is past the build audit's bound, so
 * waiting here actually succeeds. If a bounded acquire is ever wanted again, it
 * belongs back in this module rather than in a caller's own timer, and it needs a
 * caller whose deadline is genuinely shorter than its patience.
 */
export async function withWorktreeLock<T>(holder: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquire(holder);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function acquire(holder: string): Promise<() => void> {
  if (currentHolder === undefined) {
    currentHolder = holder;
    return makeRelease(holder);
  }

  const blockedBy = currentHolder;
  const started = Date.now();
  log.info(
    { holder, heldBy: blockedBy, waiting: waiters.length },
    'waiting for the worktree lock',
  );

  await new Promise<void>((resolve) => {
    waiters.push({ holder, grant: resolve });
  });

  log.info({ holder, waitedMs: Date.now() - started }, 'acquired the worktree lock');
  return makeRelease(holder);
}

function makeRelease(holder: string): () => void {
  let released = false;
  return () => {
    // Idempotent: a double release would hand the lock to two waiters at once,
    // which is the one bug this module exists to prevent.
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) {
      currentHolder = next.holder;
      next.grant();
    } else {
      currentHolder = undefined;
    }
    log.debug({ holder, next: next?.holder }, 'released the worktree lock');
  };
}
