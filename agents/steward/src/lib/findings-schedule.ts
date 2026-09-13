import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  type ScheduleOptions,
} from '@temporalio/client';
import { FINDINGS_SCHEDULE_ID } from '../config.js';
import {
  reconcileFindingsWorkflow,
  type ReconcileFindingsInput,
} from '../workflows/reconcile-findings.js';
import type { ScorecardScheduleClientLike } from './scorecard-schedule.js';

/**
 * The Temporal Schedule that runs `reconcileFindingsWorkflow` every hour
 * (findings-loop design, decision 17).
 *
 * A sibling of `scorecard-schedule.ts` rather than a generalisation of it. The
 * two share their shape (a calendar spec, `overlap: SKIP`, frozen arguments, a
 * `trigger` that cannot bypass SKIP) but not their policy numbers or their
 * operator messages, and folding them together would turn every scorecard line
 * into a parameter. The client and handle interfaces are shared, which is the
 * part that is genuinely the same.
 *
 * Client-side only, like its sibling: nothing here runs in a workflow.
 */

/** The base ID for scheduled starts; the server appends the nominal time. */
export const FINDINGS_SCHEDULE_WORKFLOW_ID = 'steward-findings-reconcile-scheduled';

/**
 * Minute 5 of every hour. A calendar spec rather than `every: '1 hour'` so the
 * firing sits at a fixed clock minute, off the top of the hour where every other
 * cron on the internet lands.
 */
export const FINDINGS_SCHEDULE_MINUTE = 5;

/**
 * Shorter than the firing interval, so a firing missed during a Cloud outage is
 * taken late within the same hour or dropped, and two are never outstanding at
 * once. Dropping one costs an hour's delay on a file-path verdict and nothing else.
 */
export const FINDINGS_SCHEDULE_CATCHUP_WINDOW = '30 minutes';

export const FINDINGS_SCHEDULE_ACTIONS = ['create', 'describe', 'pause', 'unpause', 'trigger'] as const;
export type FindingsScheduleAction = (typeof FINDINGS_SCHEDULE_ACTIONS)[number];

export function isFindingsScheduleAction(value: string): value is FindingsScheduleAction {
  return (FINDINGS_SCHEDULE_ACTIONS as readonly string[]).includes(value);
}

export interface FindingsScheduleParams {
  /** Frozen into every firing (design rule 3): the repository the reconciler reads. */
  input: ReconcileFindingsInput;
  taskQueue: string;
}

export function buildFindingsScheduleOptions(params: FindingsScheduleParams): ScheduleOptions {
  return {
    scheduleId: FINDINGS_SCHEDULE_ID,
    spec: {
      // `hour` defaults to 0 in a calendar spec, so it has to say every hour.
      calendars: [{ hour: '*', minute: FINDINGS_SCHEDULE_MINUTE }],
      timezone: 'UTC',
    },
    action: {
      type: 'startWorkflow',
      workflowType: reconcileFindingsWorkflow,
      workflowId: FINDINGS_SCHEDULE_WORKFLOW_ID,
      taskQueue: params.taskQueue,
      args: [params.input],
      // A healthy run is seconds. The timeout turns a run no worker picks up
      // (a dead container) into a failed action instead of a Running execution
      // that SKIP would let suppress every later firing.
      workflowExecutionTimeout: '15 minutes',
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: FINDINGS_SCHEDULE_CATCHUP_WINDOW,
      // Off for the scorecard's reason: a reconciler that pauses itself on one
      // GitHub error stops carrying every later verdict. The health ping is the alarm.
      pauseOnFailure: false,
    },
  };
}

export interface FindingsScheduleOutcome {
  action: FindingsScheduleAction;
  scheduleId: string;
  lines: string[];
}

function describeNext(nextActionTimes: Date[], timeZone: string): string {
  if (nextActionTimes.length === 0) return 'next firings: none scheduled';
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  });
  return `next firings (${timeZone}): ${nextActionTimes.slice(0, 3).map((d) => format.format(d)).join(' · ')}`;
}

export async function runFindingsScheduleAction(
  action: FindingsScheduleAction,
  deps: {
    schedule: ScorecardScheduleClientLike;
    options?: ScheduleOptions;
    note?: string;
    /** The zone firing times are printed in. */
    timeZone: string;
  },
): Promise<FindingsScheduleOutcome> {
  const { schedule, note, timeZone } = deps;
  const lines: string[] = [];

  if (action === 'create') {
    if (!deps.options) throw new Error('create needs the schedule options');
    try {
      await schedule.create(deps.options);
    } catch (err) {
      if (err instanceof ScheduleAlreadyRunning) {
        throw new Error(
          `A schedule "${FINDINGS_SCHEDULE_ID}" already exists. Its arguments are frozen at creation; ` +
            'delete it in the Temporal Cloud UI (or with `temporal schedule delete`) and create it again to change them.',
        );
      }
      throw err;
    }
    lines.push('created');
  }

  const handle = schedule.getHandle(FINDINGS_SCHEDULE_ID);
  try {
    switch (action) {
      case 'create':
      case 'describe':
        break;
      case 'pause':
        await handle.pause(note);
        lines.push(`paused${note ? ` (${note})` : ''}`);
        break;
      case 'unpause':
        await handle.unpause(note);
        lines.push(`unpaused${note ? ` (${note})` : ''}`);
        break;
      case 'trigger':
        // SKIP, not the SDK's ALLOW_ALL default: a manual sync must not run
        // beside a reconcile already in flight.
        await handle.trigger(ScheduleOverlapPolicy.SKIP);
        lines.push('triggered one reconcile now (skipped if one is already running)');
        break;
    }
    const d = await handle.describe();
    lines.push(`paused: ${d.state.paused}${d.state.note ? ` (${d.state.note})` : ''}`);
    lines.push(`actions taken so far: ${d.info.numActionsTaken}`);
    lines.push(
      `firings missed (unreachable >${FINDINGS_SCHEDULE_CATCHUP_WINDOW}): ${d.info.numActionsMissedCatchupWindow} · ` +
        `skipped for overlap: ${d.info.numActionsSkippedOverlap}`,
    );
    lines.push(
      `policies: overlap ${d.policies.overlap} · catchup window ${d.policies.catchupWindow}ms · ` +
        `pauseOnFailure ${d.policies.pauseOnFailure}`,
    );
    lines.push(describeNext(d.info.nextActionTimes, timeZone));
    return { action, scheduleId: FINDINGS_SCHEDULE_ID, lines };
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) {
      throw new Error(
        `No schedule "${FINDINGS_SCHEDULE_ID}" exists. Create it with \`steward finding schedule create\`.`,
      );
    }
    throw err;
  }
}
