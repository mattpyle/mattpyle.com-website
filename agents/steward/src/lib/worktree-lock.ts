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
 * and cancellation. Both activity call sites already run a heartbeat pump or
 * complete well inside their timeout, so a wait here does not look like a
 * wedged activity.
 */

interface Waiter {
  holder: string;
  grant: () => void;
  fail: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

let currentHolder: string | undefined;
const waiters: Waiter[] = [];

/** Snapshot of the lock, for diagnostics and tests. Never used to make decisions. */
export function worktreeLockState(): { holder?: string; waiting: string[] } {
  return { holder: currentHolder, waiting: waiters.map((w) => w.holder) };
}

export interface WorktreeLockOptions {
  /**
   * How long to wait for the lock before giving up, in milliseconds.
   *
   * Undefined means wait forever, which is right for a caller whose own
   * `startToCloseTimeout` is the real deadline. A caller with
   * `maximumAttempts: 1` wants a *shorter* deadline than its timeout, so the
   * failure names the actual cause ("worktree busy") instead of surfacing as an
   * opaque activity timeout minutes later.
   */
  acquireTimeoutMs?: number;
}

/**
 * How long the two publish activities wait for the lock before failing.
 *
 * Both run with `startToCloseTimeout: '5 minutes'` and `maximumAttempts: 1`,
 * and those workflow-side options may not change here: they are scheduled-command
 * attributes, and reviews park durably in `awaiting_verdict` where a changed
 * attribute risks non-determinism when those open histories replay. So a publish
 * that waits out a long build audit fails either way; giving up at four minutes
 * only chooses *which* failure the human sees — a `WorktreeBusyError` naming the
 * activity that held the tree, rather than a bare activity timeout. The remedy
 * is the same in both cases: re-approve (or re-run the scorecard's publish leg)
 * once the build finishes.
 */
export const PUBLISH_ACQUIRE_TIMEOUT_MS = 4 * 60_000;

/** Thrown when `acquireTimeoutMs` elapses before the lock is free. */
export class WorktreeBusyError extends Error {
  constructor(holder: string, waitedMs: number, heldBy?: string) {
    super(
      `worktree busy: ${holder} waited ${waitedMs}ms for WORKTREE_DIR` +
        (heldBy ? `, still held by ${heldBy}` : ''),
    );
    this.name = 'WorktreeBusyError';
  }
}

/**
 * Runs `fn` with exclusive access to the worktree.
 *
 * FIFO, so a long queue cannot starve the activity that arrived first. The lock
 * is released in a `finally`, so a throwing or cancelled critical section hands
 * it on rather than wedging every later worktree activity for the life of the
 * worker.
 */
export async function withWorktreeLock<T>(
  holder: string,
  fn: () => Promise<T>,
  options: WorktreeLockOptions = {},
): Promise<T> {
  const release = await acquire(holder, options.acquireTimeoutMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function acquire(holder: string, timeoutMs?: number): Promise<() => void> {
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

  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      holder,
      grant: () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        resolve();
      },
      fail: (err) => {
        if (waiter.timer) clearTimeout(waiter.timer);
        reject(err);
      },
    };
    if (timeoutMs !== undefined) {
      waiter.timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        waiter.fail(new WorktreeBusyError(holder, Date.now() - started, currentHolder));
      }, timeoutMs);
      // A pending acquisition must not be the reason the process stays alive.
      waiter.timer.unref?.();
    }
    waiters.push(waiter);
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
