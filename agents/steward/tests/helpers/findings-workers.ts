import { Worker, type WorkerOptions } from '@temporalio/worker';
import { QUEUE_FINDINGS_CHECKS } from '../../src/config.js';
import { bounded } from './test-env.js';

/**
 * A findings worker and, beside it, a worker on `steward-findings-checks`, as
 * the hosted container runs them (STW-716). The findings workflows schedule
 * `runFindingChecks` on the checks queue, so a test with one worker on
 * `steward-findings` would leave every check unclaimed.
 *
 * The checks worker takes `runFindingChecks` from the same activity map, so a
 * test's mock serves both queues. A map without it gets no checks worker.
 * `runUntil` runs both and stops both when the promise settles, bounded like
 * every other `runUntil` in the suite.
 */
export interface FindingsWorkers {
  readonly findings: Worker;
  readonly checks: Worker | undefined;
  runUntil<T>(promise: Promise<T>): Promise<T>;
}

export async function createFindingsWorkers(options: WorkerOptions): Promise<FindingsWorkers> {
  const findings = await Worker.create(options);
  const activities = options.activities as Record<string, unknown> | undefined;
  const runFindingChecks = activities?.runFindingChecks;
  const checks = runFindingChecks
    ? await Worker.create({
        connection: options.connection,
        ...(options.namespace ? { namespace: options.namespace } : {}),
        taskQueue: QUEUE_FINDINGS_CHECKS,
        activities: { runFindingChecks },
      })
    : undefined;
  return {
    findings,
    checks,
    runUntil: <T>(promise: Promise<T>) =>
      checks ? checks.runUntil(findings.runUntil(bounded(promise))) : findings.runUntil(bounded(promise)),
  };
}
