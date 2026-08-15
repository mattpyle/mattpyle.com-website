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
 * **The limit this file used to open with is gone (2026-08-14).** It read: the
 * server and worker are local, a Schedule only acts while that stack is up, so
 * this is a daily audit on a laptop rather than unattended nightly auditing.
 * Both halves of that moved. The Schedule lives in Temporal Cloud, and the
 * hosted Railway worker polls `steward-audit` continuously, so a firing is taken
 * on time and advanced to completion with the laptop shut
 * (always-on-audit-worker card).
 *
 * That is also why the two policy values below changed. They were both written
 * to compensate for a stack that was usually down, and compensating for it now
 * makes the run *worse* rather than safer — see each constant.
 *
 * The remaining honest limit is narrower and worth stating plainly: the run
 * depends on Temporal Cloud, on the Railway container, and on GitHub. None of
 * those is Matt's laptop, and none of them is monitored yet
 * (audit-stack-alerting-and-monitoring card). A silently dead container
 * produces no runs and, today, no alarm — `numActionsMissedCatchupWindow` and
 * the run-log's own dates are the only tells.
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
 * **03:30, and the reasoning inverted on 2026-08-14.** The old value was 20:00,
 * and its docblock said so explicitly: "the default has to be an hour the stack
 * is plausibly up, and on this machine that is the evening". That was a
 * constraint about Matt's laptop, not about the site, and the hosted worker
 * removed it.
 *
 * Freed of it, the right hour is the quiet one this comment used to rule out.
 * The audit measures the live site, so it should measure it settled: 03:30
 * Pacific is after any evening merge has deployed and long before the next
 * day's work starts, which makes consecutive runs comparable in a way an
 * evening sample taken mid-deploy is not.
 *
 * Not 03:00 or 04:00 exactly. Those are the hours every cron on the internet
 * picks, and GitHub's API and Vercel's edge are both quieter at :30.
 */
export const SCORECARD_SCHEDULE_DEFAULT_AT = '03:30';

/**
 * **One hour, down from 23 on 2026-08-14.** The window shrank because the thing
 * it was compensating for stopped existing.
 *
 * 23 hours was sized for a laptop: the dev server hosting the Schedule was off
 * most of the day, firings were missed routinely rather than exceptionally, and
 * a window nearly as long as the firing interval meant a missed evening run
 * could still be recovered on the next `steward up`. The trade it bought was
 * stated as "a late run or no run, and a late run is the more useful record".
 *
 * In Cloud the premise is gone. The server is always up, so it never misses a
 * firing, and the hosted worker claims the task immediately. The window now
 * covers exactly one case: Temporal Cloud itself being unreachable at 03:30. An
 * hour absorbs that and keeps a recovered firing on the same night, which is
 * what makes it the same data point. A 23-hour window in Cloud would only ever
 * fire in a scenario where the outage lasted most of a day, and it would then
 * run the audit in the middle of the following afternoon and stamp it as that
 * night's — a late run masquerading as an on-time one, which is the fake-data
 * failure the original 23-hour reasoning was itself written against.
 *
 * Still strictly shorter than the firing interval, so no two firings can ever be
 * outstanding at once. `overlap: SKIP` remains the backstop.
 */
export const SCORECARD_SCHEDULE_CATCHUP_WINDOW = '1 hour';

/**
 * The six verbs `steward scorecard-schedule` accepts.
 *
 * `status` is first because it is the only one that changes nothing. The other
 * five all mutate, which for a while made "is it still there, when does it fire
 * next" a question you answered by running `unpause` and reading what it printed
 * afterwards — a write chosen for its side effect of reporting.
 */
export const SCORECARD_SCHEDULE_ACTIONS = ['status', 'create', 'pause', 'unpause', 'trigger', 'delete'] as const;
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
      // an execution nobody ever completes — a firing taken with the server up
      // but no worker polling `steward-audit`, which is now exactly what a dead
      // Railway container looks like — would stay Running forever and suppress
      // every firing after it. `pauseOnFailure` cannot catch that, because
      // nothing fails. The timeout turns the wedge into a failed action the
      // next firing recovers from.
      //
      // **Kept at 2 hours even though the publish leg's own deadline fell from
      // 20 minutes to 2.** A healthy run is ~15 minutes, so 2 hours looks
      // generous, but the figure that has to fit here is the pathological one:
      // ~18 pages each allowed two attempts at a 5-minute `auditLiveUrl`. That
      // worst case already exceeded the old 2 hours and tightening toward the
      // healthy run would start killing real, slow runs to detect a wedge a few
      // minutes sooner. Detection is the alerting card's job, not this
      // constant's.
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
// The six actions
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
    info: {
      nextActionTimes: Date[];
      numActionsTaken: number;
      /** Firings the server dropped for landing outside {@link SCORECARD_SCHEDULE_CATCHUP_WINDOW}. */
      numActionsMissedCatchupWindow: number;
      /** Firings suppressed by `overlap: SKIP` because a run was still going. */
      numActionsSkippedOverlap: number;
    };
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
 * clamp or a changed SDK default. Printing it after every action makes either
 * failure visible on the next command an operator runs — a widening to the SDK's
 * one-year default, which would queue the missed firings, and a clamp or revert
 * back down to near-zero, which would silently restore the discard behaviour.
 * 23 hours reads as `82800000ms`; any other number is the server disagreeing
 * with what the CLI sent.
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
 * The two counters that measure the laptop limit, both straight from
 * `describe()` and neither printed anywhere before this.
 *
 * `numActionsMissedCatchupWindow` is the one that matters, and what it measures
 * changed on 2026-08-14 along with everything else here. It used to count the
 * nights the laptop slept through, and a number climbing daily was the evidence
 * that argued for the always-on worker in the first place.
 *
 * In Cloud, with a one-hour window, it should sit at zero permanently: the
 * server never misses a firing. So any non-zero value now means Temporal Cloud
 * itself was unreachable for over an hour at 03:30 — a much rarer and much more
 * interesting event than the one this counter used to report. Read a rising
 * number as an outage, not as a habit.
 *
 * `numActionsSkippedOverlap` sits beside it to say whether `overlap: SKIP` has
 * ever dropped a real run or has never once fired in anger.
 */
function describeCounters(info: {
  numActionsMissedCatchupWindow: number;
  numActionsSkippedOverlap: number;
}): string {
  return (
    // Interpolated from the constant rather than written out. This line read
    // "down >23h" for the first hours the one-hour window was live, because the
    // policy moved and the label did not — a stale number in the one place an
    // operator reads to decide whether firings are being lost.
    `firings missed (unreachable >${SCORECARD_SCHEDULE_CATCHUP_WINDOW}): ${info.numActionsMissedCatchupWindow} · ` +
    `skipped for overlap: ${info.numActionsSkippedOverlap}`
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
    /** Required by `create`; ignored by the other five verbs. */
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
      'It fires in Temporal Cloud and runs on the hosted worker, so it does not need this ' +
        'machine. It does need the Railway container to be alive — nothing alerts on that yet.',
    );
    return { action, scheduleId: SCORECARD_SCHEDULE_ID, lines };
  }

  const handle = schedule.getHandle(SCORECARD_SCHEDULE_ID);

  try {
    switch (action) {
      // Deliberately empty. `status` exists to reach the shared reporting block
      // below without taking an action first, and the one thing it must never
      // acquire is a side effect — a read-only verb that quietly unpauses is the
      // bug it was written to remove.
      case 'status':
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

    // Inside the try, not after it, because `status` takes no action at all:
    // for that verb `describe()` is the only call that can raise
    // `ScheduleNotFoundError`, and a raw SDK error is not the answer to "does
    // this schedule exist".
    const description = await handle.describe();
    if (action === 'status') lines.push('exists');
    const pausedNote = description.state.note ? ` (${description.state.note})` : '';
    lines.push(`paused: ${description.state.paused}${pausedNote}`);
    lines.push(`actions taken so far: ${description.info.numActionsTaken}`);
    lines.push(describeCounters(description.info));
    lines.push(describePolicies(description.policies));
    lines.push(describeNext(description.info.nextActionTimes, timeZone));
    return { action, scheduleId: SCORECARD_SCHEDULE_ID, lines };
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) {
      throw new Error(
        `No schedule "${SCORECARD_SCHEDULE_ID}" exists. Create it with ` +
          `\`steward scorecard-schedule create\`.`,
      );
    }
    throw err;
  }
}
