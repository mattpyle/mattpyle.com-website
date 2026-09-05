import type { Context } from '@temporalio/activity';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  Next,
} from '@temporalio/worker';

/**
 * When the hosted worker should stop polling, drain, and exit 0.
 *
 * ## Why a worker would ever exit on purpose
 *
 * Railway bills memory residency, not work. After a deep audit or the nightly
 * scorecard the container holds 1.4 to 1.7 GB at under 1% CPU until something
 * redeploys it, and that residency is the whole bill: about $10.80 a month for
 * about eight minutes of work a day, against a $3 fresh-container baseline.
 * Lighthouse traces, Chromium profiles and page cache are all counted by the
 * cgroup, and nothing in this process can hand them back. A new container can.
 *
 * `railway.json` sets `restartPolicyType: ALWAYS`, so a clean exit is a restart
 * from the cached image in seconds, at the 0.29 GB baseline. The recycle is the
 * cheapest way to release memory whose owner we never had to identify.
 *
 * ## What the policy is careful about
 *
 * - **Never mid-activity.** A worker that exits with work in flight cancels it,
 *   which is correct but wasteful; the in-flight count gates everything.
 * - **Never on a worker that has done no browser work.** A container that has
 *   only answered fast audits is already at baseline, so recycling it buys
 *   nothing and costs a restart. Only `auditRenderedPage` and `auditLiveUrl`
 *   launch Chrome, so only they arm the policy.
 * - **Never straight after the last activity.** A workflow between two
 *   activities has no activity in flight, and exiting there would drop the
 *   queue for the seconds it takes to come back. The idle window is what waits
 *   out the rest of a run.
 *
 * The decision is a pure function of four numbers so the four cases are
 * testable without a worker, a clock, or Temporal.
 */

/**
 * The activities that launch Chrome. Recycling is for the memory these leave
 * behind, so a worker that has run neither of them never recycles.
 *
 * Kept as a set here rather than as a check inside the activities because the
 * activities are shared with the laptop worker and must not learn about hosting.
 */
export const BROWSER_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'auditRenderedPage',
  'auditLiveUrl',
]);

/**
 * How long after the last activity of any kind the worker counts as idle.
 *
 * Sized against a workflow's gaps, not against a page render. `auditSiteWorkflow`
 * moves from one activity to the next in well under a second, and
 * `scorecardAuditWorkflow` is a fan-out with the same shape, so five minutes is
 * two orders of magnitude more than any real gap. It costs five minutes of
 * residency per burst, which is about a cent a month.
 */
export const RECYCLE_IDLE_MS = 5 * 60 * 1000;

/** What the policy needs to know about the worker, and nothing else. */
export interface RecycleState {
  /** When a browser activity last started, or `null` if none has. */
  lastBrowserActivityAt: number | null;
  /** When an activity of any kind last finished, or `null` if none has. */
  lastActivityFinishedAt: number | null;
  /** Activities currently executing in this process. */
  inFlight: number;
}

export interface RecycleDecision {
  recycle: boolean;
  /** One clause, written to be read in a deploy log next to the RSS. */
  reason: string;
}

/**
 * Given the worker's state and the current time, answer "recycle" or "keep
 * running". Pure: the caller supplies `now`.
 */
export function shouldRecycle(state: RecycleState, now: number): RecycleDecision {
  if (state.lastBrowserActivityAt === null) {
    return { recycle: false, reason: 'no browser activity has run in this container' };
  }
  if (state.inFlight > 0) {
    return { recycle: false, reason: `${state.inFlight} activity in flight` };
  }
  if (state.lastActivityFinishedAt === null) {
    // A browser activity started and nothing has finished, with nothing in
    // flight: the interceptor's `finally` did not run, so the accounting is
    // wrong. Keep polling rather than exiting on a state we cannot explain.
    return { recycle: false, reason: 'no activity has finished yet' };
  }
  const idleMs = now - state.lastActivityFinishedAt;
  if (idleMs < RECYCLE_IDLE_MS) {
    return { recycle: false, reason: `last activity finished ${Math.round(idleMs / 1000)}s ago` };
  }
  return {
    recycle: true,
    reason: `browser activity has run and the worker has been idle for ${Math.round(idleMs / 1000)}s`,
  };
}

/**
 * The worker's running account of what the policy reads.
 *
 * Deliberately not a module-level singleton: the worker owns one, and a test
 * owns its own.
 */
export class ActivityTracker {
  #lastBrowserActivityAt: number | null = null;
  #lastActivityFinishedAt: number | null = null;
  #inFlight = 0;

  constructor(private readonly now: () => number = Date.now) {}

  start(activityType: string): void {
    this.#inFlight += 1;
    if (BROWSER_ACTIVITY_TYPES.has(activityType)) {
      this.#lastBrowserActivityAt = this.now();
    }
  }

  finish(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.#lastActivityFinishedAt = this.now();
  }

  state(): RecycleState {
    return {
      lastBrowserActivityAt: this.#lastBrowserActivityAt,
      lastActivityFinishedAt: this.#lastActivityFinishedAt,
      inFlight: this.#inFlight,
    };
  }
}

/**
 * The `WorkerOptions.interceptors.activity` entry that feeds the tracker.
 *
 * An interceptor rather than a line in each activity: the activities are shared
 * with the laptop worker, where the recycle must never happen, and observing
 * from outside keeps them ignorant of it. It wraps every activity execution on
 * this worker, so the count is the SDK's own view of in-flight work rather than
 * a second one that can drift.
 *
 * `finally` and not `then`: a failed or cancelled activity ends too, and an end
 * this misses is a worker that never recycles again.
 */
export function trackActivityExecution(tracker: ActivityTracker): ActivityInterceptorsFactory {
  return (ctx: Context) => ({
    inbound: {
      async execute(
        input: ActivityExecuteInput,
        next: Next<ActivityInboundCallsInterceptor, 'execute'>,
      ): Promise<unknown> {
        tracker.start(ctx.info.activityType);
        try {
          return await next(input);
        } finally {
          tracker.finish();
        }
      },
    },
  });
}
