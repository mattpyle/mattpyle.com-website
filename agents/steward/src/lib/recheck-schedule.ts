import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  type ScheduleOptions,
} from '@temporalio/client';
import { recheckFindingsWorkflow } from '../workflows/recheck-findings.js';
import type { RecheckFindingsInput } from './findings-recheck.js';
import type { ScorecardScheduleClientLike } from './scorecard-schedule.js';

/**
 * The daily Temporal Schedule that runs `recheckFindingsWorkflow` for one site
 * (STW-543). One Schedule per site, since the site is frozen into its action.
 *
 * A sibling of `findings-schedule.ts`, with the same shape: a calendar spec,
 * `overlap: SKIP`, frozen arguments and a `trigger` that cannot bypass SKIP.
 * Client-side only: nothing here runs in a workflow.
 */

export function recheckScheduleId(site: string): string {
  return `steward-findings-recheck-${site}`;
}

/** The base ID for scheduled starts; the server appends the nominal time. */
export function recheckScheduledWorkflowId(site: string): string {
  return `steward-findings-recheck-scheduled-${site}`;
}

/** 06:20 in America/Vancouver: the day's `live_on` is written before Matt's day starts. */
export const RECHECK_SCHEDULE_HOUR = 6;
export const RECHECK_SCHEDULE_MINUTE = 20;
export const RECHECK_SCHEDULE_TIMEZONE = 'America/Vancouver';

/** A firing missed during an outage is taken late within six hours, or dropped for the next day's. */
export const RECHECK_SCHEDULE_CATCHUP_WINDOW = '6 hours';

export const RECHECK_SCHEDULE_ACTIONS = ['create', 'describe', 'pause', 'unpause', 'trigger'] as const;
export type RecheckScheduleAction = (typeof RECHECK_SCHEDULE_ACTIONS)[number];

export function isRecheckScheduleAction(value: string): value is RecheckScheduleAction {
  return (RECHECK_SCHEDULE_ACTIONS as readonly string[]).includes(value);
}

export interface RecheckScheduleParams {
  /** Frozen into every firing: the repository and the site. */
  input: RecheckFindingsInput;
  taskQueue: string;
}

export function buildRecheckScheduleOptions(params: RecheckScheduleParams): ScheduleOptions {
  return {
    scheduleId: recheckScheduleId(params.input.site),
    spec: {
      calendars: [{ hour: RECHECK_SCHEDULE_HOUR, minute: RECHECK_SCHEDULE_MINUTE }],
      timezone: RECHECK_SCHEDULE_TIMEZONE,
    },
    action: {
      type: 'startWorkflow',
      workflowType: recheckFindingsWorkflow,
      workflowId: recheckScheduledWorkflowId(params.input.site),
      taskQueue: params.taskQueue,
      args: [params.input],
      // A run is one finding after another, the browser ones up to a minute
      // each. The timeout turns a run no worker picks up into a failed action
      // instead of a Running execution that SKIP would let suppress every
      // later firing.
      workflowExecutionTimeout: '1 hour',
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: RECHECK_SCHEDULE_CATCHUP_WINDOW,
      pauseOnFailure: false,
    },
  };
}

export interface RecheckScheduleOutcome {
  action: RecheckScheduleAction;
  scheduleId: string;
  lines: string[];
}

function describeNext(nextActionTimes: Date[], timeZone: string): string {
  if (nextActionTimes.length === 0) return 'next firings: none scheduled';
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short', timeStyle: 'short', hour12: false });
  return `next firings (${timeZone}): ${nextActionTimes.slice(0, 3).map((d) => format.format(d)).join(' · ')}`;
}

export async function runRecheckScheduleAction(
  action: RecheckScheduleAction,
  deps: {
    site: string;
    schedule: ScorecardScheduleClientLike;
    options?: ScheduleOptions;
    note?: string;
    /** The zone firing times are printed in. */
    timeZone: string;
  },
): Promise<RecheckScheduleOutcome> {
  const { schedule, note, timeZone } = deps;
  const scheduleId = recheckScheduleId(deps.site);
  const lines: string[] = [];

  if (action === 'create') {
    if (!deps.options) throw new Error('create needs the schedule options');
    try {
      await schedule.create(deps.options);
    } catch (err) {
      if (err instanceof ScheduleAlreadyRunning) {
        throw new Error(
          `A schedule "${scheduleId}" already exists. Its arguments are frozen at creation; ` +
            'delete it in the Temporal Cloud UI (or with `temporal schedule delete`) and create it again to change them.',
        );
      }
      throw err;
    }
    lines.push('created');
  }

  const handle = schedule.getHandle(scheduleId);
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
        await handle.trigger(ScheduleOverlapPolicy.SKIP);
        lines.push('triggered one recheck now (skipped if one is already running)');
        break;
    }
    const d = await handle.describe();
    lines.push(`paused: ${d.state.paused}${d.state.note ? ` (${d.state.note})` : ''}`);
    lines.push(`actions taken so far: ${d.info.numActionsTaken}`);
    lines.push(
      `firings missed (unreachable >${RECHECK_SCHEDULE_CATCHUP_WINDOW}): ${d.info.numActionsMissedCatchupWindow} · ` +
        `skipped for overlap: ${d.info.numActionsSkippedOverlap}`,
    );
    lines.push(
      `policies: overlap ${d.policies.overlap} · catchup window ${d.policies.catchupWindow}ms · ` +
        `pauseOnFailure ${d.policies.pauseOnFailure}`,
    );
    lines.push(describeNext(d.info.nextActionTimes, timeZone));
    return { action, scheduleId, lines };
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) {
      throw new Error(
        `No schedule "${scheduleId}" exists. Create it with \`steward finding recheck-schedule create --site ${deps.site}\`.`,
      );
    }
    throw err;
  }
}
