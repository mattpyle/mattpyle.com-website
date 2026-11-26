import { ApplicationFailure, CancelledFailure, type Context, type Info } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  Next,
} from '@temporalio/worker';
import { sendHealthPing } from './health-ping.js';
import { log } from './logger.js';
import type { RunShape } from './run-health.js';

/**
 * The alarm for an activity that has been failing for two hours: the
 * `long-retry` signal (`lib/run-health.ts`). Temporal's Retry Alerting via
 * Metrics pattern, with a ping in place of the counter. An activity interceptor
 * on the hosted worker, so it covers every activity there, needs no GitHub and
 * adds no command to any history.
 *
 * ## Two clocks, because an activity's age is not how long it has failed
 *
 * **Every activity but a wait** is failing from its first attempt, so the clock
 * is the time since it was first scheduled (`scheduledTimestampMs`). No memory:
 * every failing attempt past the threshold pings `/fail`, and a success on a
 * second or later attempt past it pings success.
 *
 * **A wait** ({@link WAIT_ACTIVITY_TYPES}) lives for days by design, answering
 * "not yet". Its clock is the current streak of counted failures, kept in this
 * process: `/fail` when the streak is two hours old, and success only when this
 * process sent a `/fail` for that activity. A "not yet", a benign failure or a
 * success ends the streak. The memory has two costs:
 *
 * 1. A recycle or a deploy forgets the streak, so a wait's alarm comes up to two
 *    hours late.
 * 2. A wait that had alarmed before a recycle can leave the check down until
 *    another recovery pings it, or a person does.
 *
 * ## Both ends of a measurement are the server's
 *
 * "Now" is when the server scheduled this attempt
 * (`currentAttemptScheduledTimestampMs`), not this process's clock, so skipped
 * time on a test server is measured too. A dev server stamps the time a retry is
 * due; the time-skipping test server stamps the time it was decided, so an alarm
 * there comes one attempt later.
 *
 * ## What it does not see
 *
 * An attempt that hangs to its timeout (a cancellation, or no return at all),
 * and a dead worker. A non-retryable failure of an old activity pings `/fail`,
 * and no later attempt of that activity recovers it.
 *
 * ## One shared check
 *
 * When two activities fail at once and one recovers, the check goes up and the
 * other's next failing attempt takes it down again.
 */

/** How long an activity must have been failing before the alarm. */
export const LONG_RETRY_MS = 2 * 60 * 60 * 1000;

/** The polling waits' "not yet" answers. Retryable failures that are not faults. */
export const NOT_YET_FAILURE_TYPES: ReadonlySet<string> = new Set([
  'PrStillOpen',
  'FixPrNotOpen',
  'DeployNotLive',
  'PreviewNotReady',
  'FixNotLive',
]);

/**
 * The activities that wait: each answers "not yet" until what it polls for has
 * happened. `watchFinding` says it with a benign failure.
 */
export const WAIT_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'awaitFixPr',
  'awaitFixPrMerge',
  'awaitProductionDeploy',
  'awaitPrPreview',
  'readProductionDeploy',
  'watchFinding',
]);

/** How much of an error's message a ping body quotes. */
const MAX_ERROR_CHARS = 500;

export type LongRetryPing = (signal: 'long-retry', shape: RunShape) => Promise<unknown>;

type Outcome =
  | { kind: 'ok' | 'not-yet' | 'benign' | 'cancelled' }
  | { kind: 'failed'; error: unknown };

/** A wait's current streak of counted failures. */
interface Streak {
  since: number;
  alarmed: boolean;
}

function classify(ctx: Context, error: unknown): Outcome {
  if (error instanceof CancelledFailure || ctx.cancellationSignal.aborted) return { kind: 'cancelled' };
  if (error instanceof ApplicationFailure) {
    if (NOT_YET_FAILURE_TYPES.has(error.type ?? '')) return { kind: 'not-yet' };
    if (error.category === ApplicationFailureCategory.BENIGN) return { kind: 'benign' };
  }
  return { kind: 'failed', error };
}

/** True when the server will schedule no further attempt after this failure, as far as the attempt can tell. */
function isLastAttempt(info: Info, error: unknown): boolean {
  const policy = info.retryPolicy;
  if (policy?.maximumAttempts && info.attempt >= policy.maximumAttempts) return true;
  if (!(error instanceof ApplicationFailure)) return false;
  return Boolean(error.nonRetryable) || Boolean(policy?.nonRetryableErrorTypes?.includes(error.type ?? ''));
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function names(info: Info): string {
  return `Activity ${info.activityType}, workflow ${info.workflowExecution?.workflowId ?? 'none'}, attempt ${info.attempt}.`;
}

function failing(info: Info, forMs: number, error: unknown): RunShape {
  const type = error instanceof ApplicationFailure ? error.type : error instanceof Error ? error.name : undefined;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS);
  return {
    ok: false,
    summary:
      `An activity has been failing for ${duration(forMs)} and is still being retried. ${names(info)} ` +
      `Last error: ${type ? `${type}: ` : ''}${message}`,
  };
}

function recovered(info: Info, afterMs: number): RunShape {
  return { ok: true, summary: `An activity recovered after ${duration(afterMs)}. ${names(info)}` };
}

/**
 * The `WorkerOptions.interceptors.activity` entry. Build **one** per process and
 * give it to each worker: the factory holds the waits' streaks.
 *
 * It never changes what the activity returns or throws, and it never waits for
 * the ping: a send can take half a minute, more than some activities'
 * start-to-close has left.
 */
export function longRetryAlarm(ping: LongRetryPing = sendHealthPing): ActivityInterceptorsFactory {
  const streaks = new Map<string, Streak>();

  const send = (shape: RunShape): void => {
    void Promise.resolve()
      .then(() => ping('long-retry', shape))
      .catch((err: unknown) => {
        log.warn({ err, ok: shape.ok }, 'long-retry ping failed and was dropped');
      });
  };

  const observeWait = (ctx: Context, outcome: Outcome): void => {
    const info = ctx.info;
    const run = info.workflowExecution
      ? `${info.workflowExecution.workflowId}/${info.workflowExecution.runId}`
      : `/${info.activityRunId}`;
    const key = `${run}/${info.activityId}`;
    const now = info.currentAttemptScheduledTimestampMs;
    const streak = streaks.get(key);

    if (outcome.kind === 'cancelled') {
      // A workflow that cancels the wait ends it. A timeout or a worker shutting
      // down does not: the activity is retried and the streak goes on.
      const details = ctx.cancellationDetails;
      if (details?.cancelRequested || details?.notFound) streaks.delete(key);
      return;
    }
    if (outcome.kind !== 'failed') {
      if (streak?.alarmed) send(recovered(info, now - streak.since));
      streaks.delete(key);
      return;
    }
    const current = streak ?? { since: now, alarmed: false };
    if (now - current.since >= LONG_RETRY_MS) {
      current.alarmed = true;
      send(failing(info, now - current.since, outcome.error));
    }
    if (isLastAttempt(info, outcome.error)) streaks.delete(key);
    else streaks.set(key, current);
  };

  const observe = (ctx: Context, outcome: Outcome): void => {
    try {
      const info = ctx.info;
      if (WAIT_ACTIVITY_TYPES.has(info.activityType)) {
        observeWait(ctx, outcome);
        return;
      }
      const age = info.currentAttemptScheduledTimestampMs - info.scheduledTimestampMs;
      if (age < LONG_RETRY_MS) return;
      if (outcome.kind === 'failed') send(failing(info, age, outcome.error));
      else if (outcome.kind === 'ok' && info.attempt > 1) send(recovered(info, age));
    } catch (err) {
      log.warn({ err }, 'long-retry alarm could not read an activity — the activity is unaffected');
    }
  };

  return (ctx: Context) => ({
    inbound: {
      async execute(
        input: ActivityExecuteInput,
        next: Next<ActivityInboundCallsInterceptor, 'execute'>,
      ): Promise<unknown> {
        let result: unknown;
        try {
          result = await next(input);
        } catch (error) {
          observe(ctx, classify(ctx, error));
          throw error;
        }
        observe(ctx, { kind: 'ok' });
        return result;
      },
    },
  });
}
