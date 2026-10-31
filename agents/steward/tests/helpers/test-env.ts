import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';

/**
 * Where the time-skipping test server binary is cached.
 *
 * `createTimeSkipping()` defaults to the system temp directory with a **1-day**
 * TTL, which is why the workflow suites' "no network" comment was only
 * accidentally true: the binary is downloaded on first use, and after 24 hours
 * — or on any fresh machine, or any CI runner — it is downloaded again. That is
 * a real network dependency at the front of the suite, and it is where the
 * observed flaky first run (`Failed to start ephemeral server`, passing on the
 * retry) came from.
 *
 * The home is per user, not per checkout: a path inside the checkout gave
 * every git worktree its own 57 MB download, and on Windows a firewall prompt
 * per worktree, because firewall rules are keyed to the executable's path.
 * CI restores it with `actions/cache` (`ci.yml`), so the download happens once
 * per runner image rather than once per run. `STEWARD_TEST_SERVER_DIR`
 * overrides it.
 */
export const TEST_SERVER_DIR =
  process.env.STEWARD_TEST_SERVER_DIR ??
  path.join(
    process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'),
    'steward',
    'temporal-test-server',
  );

/**
 * The time-skipping environment every workflow suite shares.
 *
 * The long TTL is deliberate: the binary is pinned to the installed
 * `@temporalio/*` version, so re-downloading it on a timer buys nothing. A real
 * SDK upgrade changes the resolved version and re-downloads on its own.
 */
export function createTestEnv(): Promise<TestWorkflowEnvironment> {
  // The SDK does not create `downloadDir` — it fails with the deeply unhelpful
  // `Failed to start ephemeral server: The system cannot find the path
  // specified. (os error 3)`, which reads like a server problem rather than a
  // missing directory. This is almost certainly the same message the earlier
  // review recorded as a mystery "flaky first run". The default works only
  // because the system temp directory always exists.
  fs.mkdirSync(TEST_SERVER_DIR, { recursive: true });

  return TestWorkflowEnvironment.createTimeSkipping({
    server: {
      executable: { type: 'cached-download', downloadDir: TEST_SERVER_DIR, ttl: '365 days' },
    },
  });
}

/**
 * How long a test's worker may run before the harness stops it: under the
 * suite's 60-second `--test-timeout`, with room for the worker to drain.
 */
export const WORKER_BOUND_MS = 50_000;

/**
 * Rejects when `promise` has not settled within {@link WORKER_BOUND_MS}.
 * Pass it to `worker.runUntil(bounded(fn()))`, never a bare `fn()`.
 *
 * `runUntil` shuts the worker down only when its promise settles, and a
 * node:test timeout settles nothing: it marks the test failed and moves on.
 * The worker then keeps polling, the file's `env.teardown()` throws
 * `Cannot close connection while Workers hold a reference to it`, and the
 * process never exits. On CI that is a job cancelled at its 15-minute limit
 * with no test summary. Bounded, a stalled test fails with this message, its
 * worker drains, and the file ends.
 */
export function bounded<T>(promise: Promise<T>, ms = WORKER_BOUND_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The test's workflows did not finish within ${ms / 1000} s; the harness stopped its worker.`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Waits until the run's pending `activityType` has failed an attempt and sits
 * in its retry backoff, so no attempt is in flight. Call it before terminating
 * or cancelling a run whose activity retries, and close the run straight after.
 *
 * The test server reports a retrying activity as `STARTED` even during the
 * backoff, so the sign is `attempt` 2 or more with `lastFailure` set. The
 * next attempt is a whole retry interval away: time does not skip while no
 * time-skipping client awaits a result, so that interval passes in wall time.
 *
 * The time-skipping server takes a time lock while an activity attempt runs.
 * If the run closes during that attempt, the worker's completion is refused
 * and the lock is never released: from then on the server's clock advances
 * only in real time, for every workflow in the environment, so a later test
 * that relies on skipping waits until its timeout. Observed on 2026-10-30
 * with the server `@temporalio/testing` 1.20.3 downloads: a run terminated
 * mid-attempt, then 170 s with the clock at wall time and nothing pending on
 * any open run.
 */
export async function untilBetweenAttempts(
  handle: { describe(): Promise<{ raw: { pendingActivities?: PendingActivityLike[] | null } }>; workflowId: string },
  activityType: string,
  ms = 20_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const pending = (await handle.describe()).raw.pendingActivities ?? [];
    const activity = pending.find((a) => a.activityType?.name === activityType);
    if (activity && (activity.attempt ?? 1) >= 2 && activity.lastFailure) return;
    if (Date.now() > deadline) throw new Error(`${handle.workflowId}'s ${activityType} never reached its retry backoff.`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface PendingActivityLike {
  activityType?: { name?: string | null } | null;
  attempt?: number | null;
  lastFailure?: unknown;
}
