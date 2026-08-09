import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  type ScheduleOptions,
} from '@temporalio/client';
import { scorecardAuditWorkflow, type ScorecardAuditInput } from '../workflows/scorecard-audit.js';

/**
 * The Temporal Schedule that fires `scorecardAuditWorkflow` daily
 * (scorecard-audit-spec.md §7, card `scorecard-nightly-schedule`).
 *
 * Everything here is **client-side**: a Schedule is server machinery that starts
 * workflows, so nothing in this file runs inside a workflow, and adding it
 * changes no workflow history. The three policy choices below are the design
 * (the card argues them at length); the code is the easy part.
 *
 * **The honest limit, restated because it is the whole point (§7):** Steward's
 * server and worker are local. A Schedule only takes an action while that stack
 * is up, so this is a daily audit on a laptop, not unattended nightly auditing.
 * `steward/user-guide.md` says so to the operator; do not describe it otherwise.
 */

/** The one Schedule this system owns. Singular by design — one site, one audit. */
export const SCORECARD_SCHEDULE_ID = 'steward-scorecard-daily';

/**
 * The base workflow ID for scheduled starts. The scheduler appends the action's
 * nominal time to it, so each firing is its own execution rather than a
 * collision on one ID — matching the timestamped IDs `steward scorecard`
 * already uses, and readable in `temporal workflow list` as one family.
 *
 * Verified live 2026-08-09 (build log): the first real firing ran as
 * `steward-scorecard-scheduled-2026-08-09T...`.
 */
export const SCORECARD_SCHEDULE_WORKFLOW_ID = 'steward-scorecard-scheduled';

/**
 * Default firing time, local to {@link ScorecardScheduleParams.timeZone}.
 *
 * **Mid-morning, not a quiet 3am hour**, and the catchup window is why. A
 * schedule set for 03:30 on a laptop fires while the machine is asleep, and a
 * missed firing here is discarded rather than taken on wake — so the tidy
 * overnight default is the one setting guaranteed to produce zero runs. The
 * default has to be an hour the stack is plausibly up.
 */
export const SCORECARD_SCHEDULE_DEFAULT_AT = '10:00';

/**
 * Near zero, not the SDK's one-year default — the single most consequential
 * line in this file (card: "the catchup window is the important part").
 *
 * The audit measures the live site **at execution time**. A firing missed on
 * Monday and taken on Thursday measures Thursday's site, so a drained backlog
 * writes four near-identical points into what is supposed to be a time series.
 * That is not late data, it is fake data. Missed firings must drop.
 *
 * Ten seconds rather than zero because a firing that lands while the server is
 * momentarily busy is still that minute's firing; ten seconds cannot span a
 * laptop sleeping, which is the case this exists to discard.
 */
export const SCORECARD_SCHEDULE_CATCHUP_WINDOW = '10 seconds';

/** The five verbs `steward scorecard-schedule` accepts. */
export const SCORECARD_SCHEDULE_ACTIONS = ['create', 'pause', 'unpause', 'trigger', 'delete'] as const;
export type ScorecardScheduleAction = (typeof SCORECARD_SCHEDULE_ACTIONS)[number];

export function isScorecardScheduleAction(value: string): value is ScorecardScheduleAction {
  return (SCORECARD_SCHEDULE_ACTIONS as readonly string[]).includes(value);
}

/** A validated `HH:MM` time of day. */
export interface TimeOfDay {
  hour: number;
  minute: number;
}

/**
 * Parses `--at HH:MM`. Throws on anything else — a schedule that silently fires
 * at midnight because "3:5pm" parsed to zero is worse than a refusal.
 */
export function parseTimeOfDay(value: string): TimeOfDay {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`--at must be HH:MM in 24-hour form, got "${value}"`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`--at must be a real time of day (00:00–23:59), got "${value}"`);
  }
  return { hour, minute };
}

export interface ScorecardScheduleParams {
  /** When to fire, local to `timeZone`. */
  at: TimeOfDay;
  /** IANA zone the firing time is expressed in — `STEWARD_TIMEZONE`, resolved by the CLI. */
  timeZone: string;
  /** The workflow input every firing starts with, frozen at create time (design rule 3). */
  input: ScorecardAuditInput;
  taskQueue: string;
}

/**
 * The Schedule spec, as a pure function so the policy choices are unit-testable
 * without a server.
 *
 * **The action's input is frozen when the Schedule is created**, which is the
 * same property design rule 3 gives a workflow input and for the same reason:
 * every firing runs with the arguments a human chose, not with whatever
 * `config.ts` says on the night it fires. The cost is that changing the sitemap
 * URL, the staleness threshold, or the timezone means `delete` then `create`,
 * and that trade is deliberate — a schedule whose meaning drifts under it
 * produces a run-log nobody can interpret afterwards.
 */
export function buildScorecardScheduleOptions(params: ScorecardScheduleParams): ScheduleOptions {
  return {
    scheduleId: SCORECARD_SCHEDULE_ID,
    spec: {
      // A calendar spec, not `intervals: [{ every: '1 day' }]`: an interval
      // fires relative to when it was created and drifts across the clock,
      // while the audit wants a fixed quiet hour that follows daylight saving.
      calendars: [{ hour: params.at.hour, minute: params.at.minute }],
      timezone: params.timeZone,
    },
    action: {
      type: 'startWorkflow',
      workflowType: scorecardAuditWorkflow,
      workflowId: SCORECARD_SCHEDULE_WORKFLOW_ID,
      taskQueue: params.taskQueue,
      args: [params.input],
      // The stop against the one way this design can fail silently. `SKIP`
      // suppresses a firing while the previous execution is still Running, and
      // an execution nobody ever completes — a firing started with the server
      // up but the worker dead, which is a routine state here — would stay
      // Running forever and suppress every firing after it. `pauseOnFailure`
      // cannot catch that, because nothing fails. A timeout well above a real
      // run (~12 min audit, 20 min publish deadline) turns the wedge into a
      // failed action the next firing recovers from.
      workflowExecutionTimeout: '2 hours',
    },
    policies: {
      // Never stack a second audit behind a slow one. The audit takes ~12
      // minutes and holds the worktree lock while publishing.
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: SCORECARD_SCHEDULE_CATCHUP_WINDOW,
      // Deliberately off. It sounds prudent, but a Chrome crash would then
      // silently stop all future auditing, and an audit that quietly turns
      // itself off is worse than one that fails loudly. Activity retries
      // handle transient failure.
      pauseOnFailure: false,
    },
  };
}

// ---------------------------------------------------------------------------
// The five actions
// ---------------------------------------------------------------------------

/**
 * The slice of `ScheduleHandle` these verbs use. Narrowed to an interface so the
 * verbs are testable against a fake — the real `client.schedule.getHandle(...)`
 * satisfies it structurally, and a test that needs a server tests Temporal
 * rather than this code.
 */
export interface ScorecardScheduleHandleLike {
  describe(): Promise<{
    state: { paused: boolean; note?: string };
    policies: { overlap: ScheduleOverlapPolicy; catchupWindow: number; pauseOnFailure: boolean };
    info: { nextActionTimes: Date[]; numActionsTaken: number };
  }>;
  pause(note?: string): Promise<void>;
  unpause(note?: string): Promise<void>;
  trigger(overlap?: ScheduleOverlapPolicy): Promise<void>;
  delete(): Promise<void>;
}

/** The slice of `ScheduleClient` these verbs use. `client.schedule` satisfies it. */
export interface ScorecardScheduleClientLike {
  create(options: ScheduleOptions): Promise<unknown>;
  getHandle(scheduleId: string): ScorecardScheduleHandleLike;
}

export interface ScorecardScheduleOutcome {
  action: ScorecardScheduleAction;
  scheduleId: string;
  /** One line per fact worth printing, in the order the operator should read them. */
  lines: string[];
}

const NEXT_FIRINGS_SHOWN = 3;

/**
 * Firing times in the schedule's own zone, not UTC. The operator typed `--at
 * 03:30` local and the repo's convention is local dates wherever a person reads
 * them; a UTC-only answer makes them do the arithmetic that the daylight-saving
 * edge then gets wrong.
 */
function describeNext(nextActionTimes: Date[], timeZone: string): string {
  if (nextActionTimes.length === 0) return 'next firings: none scheduled';
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  });
  // Joined with a middle dot, not a comma: the formatted stamp already contains
  // one ("2026-08-09, 00:23"), and a comma-joined list of those reads as six
  // items rather than three.
  const shown = nextActionTimes.slice(0, NEXT_FIRINGS_SHOWN).map((d) => format.format(d));
  return `next firings (${timeZone}): ${shown.join(' · ')}`;
}

/**
 * The policies the **server** stored, echoed back from `describe()`.
 *
 * Not decoration: `catchupWindow` is the choice this whole design turns on, it
 * is the one the server may clamp, and nothing else in the system would show a
 * clamp or a changed SDK default. Printing it after every action makes a silent
 * revert to "queue the missed firings" visible on the next command an operator
 * runs.
 */
function describePolicies(policies: {
  overlap: ScheduleOverlapPolicy;
  catchupWindow: number;
  pauseOnFailure: boolean;
}): string {
  return (
    `policies: overlap ${policies.overlap ?? 'server default'} · ` +
    `catchup window ${policies.catchupWindow}ms · ` +
    `pauseOnFailure ${policies.pauseOnFailure}`
  );
}

/**
 * Runs one verb against the Schedule.
 *
 * Every verb reports the Schedule's state afterwards rather than just saying
 * "done": the operator's actual question is always "so when does it fire next",
 * and on a laptop stack that answer is the one that keeps expectations honest.
 */
export async function runScorecardScheduleAction(
  action: ScorecardScheduleAction,
  deps: {
    schedule: ScorecardScheduleClientLike;
    /** Required by `create`; ignored by the other four verbs. */
    options?: ScheduleOptions;
    note?: string;
    /** The zone firing times are reported in — `STEWARD_TIMEZONE`, resolved by the CLI. */
    timeZone: string;
  },
): Promise<ScorecardScheduleOutcome> {
  const { schedule, note, timeZone } = deps;
  const lines: string[] = [];

  if (action === 'create') {
    if (!deps.options) throw new Error('create needs the schedule options');
    try {
      await schedule.create(deps.options);
    } catch (err) {
      if (err instanceof ScheduleAlreadyRunning) {
        throw new Error(
          `A schedule "${SCORECARD_SCHEDULE_ID}" already exists. Its action arguments are frozen at ` +
            `creation, so changing them means \`steward scorecard-schedule delete\` then \`create\`.`,
        );
      }
      throw err;
    }
    lines.push('created');
    const description = await schedule.getHandle(SCORECARD_SCHEDULE_ID).describe();
    lines.push(describePolicies(description.policies));
    lines.push(describeNext(description.info.nextActionTimes, timeZone));
    lines.push(
      'It fires only while the Temporal dev server and worker are up (`steward up`) — ' +
        'a daily audit on this laptop, not unattended nightly auditing.',
    );
    return { action, scheduleId: SCORECARD_SCHEDULE_ID, lines };
  }

  const handle = schedule.getHandle(SCORECARD_SCHEDULE_ID);

  try {
    switch (action) {
      case 'pause':
        await handle.pause(note);
        lines.push(`paused${note ? ` (${note})` : ''}`);
        break;
      case 'unpause':
        await handle.unpause(note);
        lines.push(`unpaused${note ? ` (${note})` : ''}`);
        break;
      case 'trigger':
        // The SDK defaults a manual trigger to ALLOW_ALL, which would start an
        // audit alongside one already running — exactly what the Schedule's own
        // SKIP policy exists to prevent. Overridden so the verb cannot do what
        // the policy forbids.
        await handle.trigger(ScheduleOverlapPolicy.SKIP);
        lines.push('triggered one action now (skipped if an audit is already running)');
        lines.push('A triggered run is a Schedule action, so it records itself as "Nightly · automated".');
        break;
      case 'delete':
        await handle.delete();
        lines.push('deleted');
        return { action, scheduleId: SCORECARD_SCHEDULE_ID, lines };
    }
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) {
      throw new Error(
        `No schedule "${SCORECARD_SCHEDULE_ID}" exists. Create it with ` +
          `\`steward scorecard-schedule create\`.`,
      );
    }
    throw err;
  }

  const description = await handle.describe();
  lines.push(`paused: ${description.state.paused}`);
  lines.push(`actions taken so far: ${description.info.numActionsTaken}`);
  lines.push(describePolicies(description.policies));
  lines.push(describeNext(description.info.nextActionTimes, timeZone));
  return { action, scheduleId: SCORECARD_SCHEDULE_ID, lines };
}
