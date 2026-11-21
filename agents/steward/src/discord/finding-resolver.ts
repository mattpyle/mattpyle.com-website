import { randomUUID } from 'node:crypto';
import { ActivityExecutionFailedError } from '@temporalio/client';
import type { FindingRef } from '../lib/finding-ids.js';
import { RESOLVE_FINDING_IDS_ACTIVITY, type ResolveFindingIdsInput, type ResolvedFindingId } from '../lib/finding-resolve-contract.js';

/**
 * Which finding an id names, asked of the hosted worker.
 *
 * A short id lives in a finding file on GitHub, and this service holds no
 * GitHub credential. So it starts `resolveFindingIds` as a Standalone Activity
 * on the findings queue, an activity with no workflow around it, and the worker
 * that does hold the credential reads the repository and answers with the few
 * fields a command needs.
 *
 * The deadlines are short because a person is waiting on a phone: ten seconds
 * for a worker to take the task, twenty for one attempt, thirty in all. Past
 * any of them the caller gets {@link ResolverUnavailable} and sends nothing.
 */

/** No worker on the queue shows as this timeout. */
export const RESOLVE_SCHEDULE_TO_START_MS = 10_000;
/** One attempt. A worker that has just restarted reads every finding file once, a few seconds. */
export const RESOLVE_START_TO_CLOSE_MS = 20_000;
/** Everything, a retry included. */
export const RESOLVE_SCHEDULE_TO_CLOSE_MS = 30_000;

/** The slice of a Temporal `Client` this module uses, so a test can hand it a fake. */
export interface ResolverClient {
  activity: {
    execute<R>(
      activity: string,
      options: {
        id: string;
        taskQueue: string;
        args: [ResolveFindingIdsInput];
        scheduleToStartTimeout: number;
        startToCloseTimeout: number;
        scheduleToCloseTimeout: number;
        retry: { maximumAttempts: number };
      },
    ): Promise<R>;
  };
}

/**
 * The ids were not resolved. `timedOut` is true when no worker answered inside
 * the deadline, and false when the activity ran and failed, or could not be
 * started.
 */
export class ResolverUnavailable extends Error {
  constructor(
    readonly timedOut: boolean,
    cause: unknown,
  ) {
    super(timedOut ? 'the worker did not answer in time' : 'the worker could not resolve the ids', { cause });
    this.name = 'ResolverUnavailable';
  }
}

function isTimeout(err: unknown): boolean {
  for (let current = err, depth = 0; current instanceof Error && depth < 6; current = current.cause, depth++) {
    if (current.name === 'TimeoutFailure') return true;
  }
  return false;
}

export type FindingResolver = (refs: readonly FindingRef[]) => Promise<ResolvedFindingId[]>;

export interface FindingResolverOptions {
  client: ResolverClient;
  taskQueue: string;
  newId?: () => string;
  /** The three deadlines, for a test that cannot wait ten seconds. */
  timeouts?: { scheduleToStartMs: number; startToCloseMs: number; scheduleToCloseMs: number };
}

export function createFindingResolver(options: FindingResolverOptions): FindingResolver {
  const newId = options.newId ?? randomUUID;
  const timeouts = options.timeouts ?? {
    scheduleToStartMs: RESOLVE_SCHEDULE_TO_START_MS,
    startToCloseMs: RESOLVE_START_TO_CLOSE_MS,
    scheduleToCloseMs: RESOLVE_SCHEDULE_TO_CLOSE_MS,
  };
  return async (refs) => {
    try {
      const resolved = await options.client.activity.execute<ResolvedFindingId[]>(RESOLVE_FINDING_IDS_ACTIVITY, {
        // Unique per command: a lookup is never shared, since the files change between two of them.
        id: `resolve-finding-ids/${newId()}`,
        taskQueue: options.taskQueue,
        args: [{ ids: refs.map((ref) => ref.text) }],
        scheduleToStartTimeout: timeouts.scheduleToStartMs,
        startToCloseTimeout: timeouts.startToCloseMs,
        scheduleToCloseTimeout: timeouts.scheduleToCloseMs,
        retry: { maximumAttempts: 2 },
      });
      if (!Array.isArray(resolved) || resolved.length !== refs.length) {
        throw new Error('resolveFindingIds answered in a shape this service cannot read');
      }
      return resolved;
    } catch (err) {
      throw new ResolverUnavailable(err instanceof ActivityExecutionFailedError && isTimeout(err), err);
    }
  };
}
