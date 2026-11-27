import { ApplicationFailure, CancelledFailure, type Context } from '@temporalio/activity';
import { ApplicationFailureCategory, type MetricGauge } from '@temporalio/common';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  Next,
} from '@temporalio/worker';
import { log } from './logger.js';

/**
 * The last-failure gauge: an activity interceptor on the hosted worker that
 * records when an activity last failed, so it covers every activity there and
 * adds no command to any history. The Grafana rule on the gauge is the alarm
 * for an activity that keeps failing; the alarm's state lives there, and this
 * module keeps none between attempts.
 *
 * The names `long-retry.ts` and `longRetryAlarm`, the ready line's field among
 * them, are historical: the interceptor raised that alarm itself until STW-693,
 * and it sends nothing now.
 *
 * Every counted failure, from the first attempt, sets the gauge
 * `createLastFailureGauge` (`lib/temporal-logger.ts`) makes: this process's
 * clock in whole Unix seconds, labelled `activity_type` and `kind` (`wait` or
 * `call`). A reader asks whether the value changed, so two failures a second or
 * more apart differ. A success, a cancellation, a benign failure and a wait's
 * "not yet" write nothing.
 *
 * The export runs every 60 seconds and nothing flushes it at exit, so a failure
 * in a process's last minute can go unrecorded. An attempt that never returns,
 * and a dead worker, write nothing.
 */

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

export type LastFailureGauge = Pick<MetricGauge, 'set'>;

/** True for a failure the gauge records. */
function isCounted(ctx: Context, error: unknown): boolean {
  if (error instanceof CancelledFailure || ctx.cancellationSignal.aborted) return false;
  if (error instanceof ApplicationFailure) {
    if (NOT_YET_FAILURE_TYPES.has(error.type ?? '')) return false;
    if (error.category === ApplicationFailureCategory.BENIGN) return false;
  }
  return true;
}

/**
 * The `WorkerOptions.interceptors.activity` entry. It never changes what the
 * activity returns or throws.
 *
 * With no `lastFailure` gauge (no metrics export) nothing is recorded.
 */
export function longRetryAlarm(lastFailure?: LastFailureGauge): ActivityInterceptorsFactory {
  const recordFailure = (ctx: Context): void => {
    try {
      const { activityType } = ctx.info;
      lastFailure?.set(Math.floor(Date.now() / 1000), {
        activity_type: activityType,
        kind: WAIT_ACTIVITY_TYPES.has(activityType) ? 'wait' : 'call',
      });
    } catch (err) {
      log.warn({ err }, 'last-failure gauge write failed — the activity is unaffected');
    }
  };

  return (ctx: Context) => ({
    inbound: {
      async execute(
        input: ActivityExecuteInput,
        next: Next<ActivityInboundCallsInterceptor, 'execute'>,
      ): Promise<unknown> {
        try {
          return await next(input);
        } catch (error) {
          if (isCounted(ctx, error)) recordFailure(ctx);
          throw error;
        }
      },
    },
  });
}
