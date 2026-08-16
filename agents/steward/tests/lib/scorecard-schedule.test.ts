import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleAlreadyRunning, ScheduleNotFoundError, ScheduleOverlapPolicy, type ScheduleOptions } from '@temporalio/client';

import {
  SCORECARD_SCHEDULE_ACTIONS,
  SCORECARD_SCHEDULE_CATCHUP_WINDOW,
  SCORECARD_SCHEDULE_DEFAULT_AT,
  SCORECARD_SCHEDULE_ID,
  SCORECARD_SCHEDULE_WORKFLOW_ID,
  buildScorecardScheduleOptions,
  isScorecardScheduleAction,
  parseTimeOfDay,
  runScorecardScheduleAction,
  type ScorecardScheduleClientLike,
  type ScorecardScheduleHandleLike,
} from '../../src/lib/scorecard-schedule.js';
import type { ScorecardAuditInput } from '../../src/workflows/scorecard-audit.js';

/**
 * The Schedule (scorecard-audit-spec.md §7, card `scorecard-nightly-schedule`).
 *
 * Two halves, and neither needs a server. The first pins the policy choices the
 * cards argue for; the second drives the five verbs against a fake
 * `ScheduleClient`, which is where the CLI's behaviour actually lives.
 *
 * `catchupWindow` is the value both halves guard, and what it is guarding
 * against changed on 2026-08-14 with the move to Cloud and the hosted worker.
 * The old danger was a laptop that slept through most firings, so the window was
 * sized to recover one of them. The server is always up now, so the window's
 * only remaining job is to absorb a Temporal Cloud outage at the firing hour —
 * and a *long* window became the hazard rather than the safeguard, because a
 * firing recovered many hours late gets stamped as that night's run. One hour
 * keeps a recovered firing on the same night. The SDK's one-year default is
 * still the other bracket, and a silent revert either way has to fail here.
 */

const TZ = 'America/Vancouver';

const INPUT: ScorecardAuditInput = {
  sitemapUrl: 'https://www.mattpyle.com/sitemap-index.xml',
  publishMode: 'pr',
  maxAgeDays: 7,
  triggeredBy: 'schedule',
  timeZone: 'America/Vancouver',
};

function options(overrides: Partial<Parameters<typeof buildScorecardScheduleOptions>[0]> = {}) {
  return buildScorecardScheduleOptions({
    at: { hour: 3, minute: 30 },
    timeZone: 'America/Vancouver',
    taskQueue: 'steward-audit',
    input: INPUT,
    ...overrides,
  });
}

/**
 * The catchup window in milliseconds, so the "shorter than a day" property can
 * be asserted as arithmetic rather than as string equality. Deliberately narrow
 * — it parses the one duration shape this file uses and refuses anything else,
 * rather than half-reimplementing the SDK's `ms` parser and quietly returning a
 * wrong number for a form it does not really handle.
 */
function msOf(duration: string): number {
  // The singular forms were added on 2026-08-14, when the window became
  // `'1 hour'` — the SDK's `ms` parser has always taken both, and this helper
  // refusing one of them failed eight tests for a grammar reason rather than a
  // policy one.
  const match = /^(\d+) (seconds?|minutes?|hours?)$/.exec(duration);
  if (!match) throw new Error(`msOf does not parse "${duration}" — widen it deliberately`);
  const unit = { second: 1000, minute: 60_000, hour: 3_600_000 }[match[2].replace(/s$/, '') as 'second' | 'minute' | 'hour'];
  return Number(match[1]) * unit;
}

// ---------------------------------------------------------------------------
// The spec construction
// ---------------------------------------------------------------------------

test('the three policy choices are exactly the card\'s', () => {
  const policies = options().policies;
  assert.equal(policies?.overlap, ScheduleOverlapPolicy.SKIP);
  assert.equal(policies?.catchupWindow, SCORECARD_SCHEDULE_CATCHUP_WINDOW);
  assert.equal(policies?.pauseOnFailure, false);
});

test('the catchup window is one hour — an outage recovers, a late run cannot pose as on-time', () => {
  // Pinned as a value, not just "not undefined". Two failure modes bracket it.
  // The SDK's one-year default would drain days of missed firings at once. And
  // — the bracket that only appeared once the Schedule moved to Cloud — a long
  // window now recovers a firing in the middle of the following afternoon and
  // stamps it as that night's run, which is the fake-data failure the original
  // 23-hour reasoning was itself written against. An hour absorbs a Cloud
  // outage at 03:30 and keeps the recovered run on the same night.
  assert.equal(SCORECARD_SCHEDULE_CATCHUP_WINDOW, '1 hour');
});

test('the catchup window is strictly shorter than the daily firing interval', () => {
  // The property that bounds it: a missed firing must expire before the next one
  // is due, so at most one can ever be outstanding. Asserted in milliseconds
  // because that is the unit the server echoes back.
  assert.ok(
    msOf(SCORECARD_SCHEDULE_CATCHUP_WINDOW) < 24 * 60 * 60 * 1000,
    `${SCORECARD_SCHEDULE_CATCHUP_WINDOW} is not shorter than a day`,
  );
  assert.equal(msOf(SCORECARD_SCHEDULE_CATCHUP_WINDOW), 3_600_000);
});

test('the default firing time is 03:30 — the quiet hour, now that nothing local has to be awake', () => {
  // This replaced 20:00, and the swap is the clearest single marker of what the
  // hosted worker changed. The evening default existed because the stack had to
  // be up, which meant sampling the site mid-evening, sometimes mid-deploy.
  // 03:30 measures it settled, which is what makes consecutive runs comparable.
  assert.equal(SCORECARD_SCHEDULE_DEFAULT_AT, '03:30');
  assert.deepEqual(parseTimeOfDay(SCORECARD_SCHEDULE_DEFAULT_AT), { hour: 3, minute: 30 });
});

test('the spec is a daily calendar firing in the given timezone', () => {
  const spec = options({ at: { hour: 22, minute: 5 } }).spec;
  assert.deepEqual(spec.calendars, [{ hour: 22, minute: 5 }]);
  assert.equal(spec.timezone, 'America/Vancouver');
  // A calendar spec only. An interval would drift relative to creation time.
  assert.equal(spec.intervals, undefined);
  assert.equal(spec.cronExpressions, undefined);
});

test('the action starts the audit workflow on the hosted queue with a stable base id', () => {
  // `steward-audit`, and this assertion is load-bearing rather than descriptive.
  // A Schedule in Cloud fires whether or not the laptop is on, so an action
  // pointed at `steward-light` would start a workflow nothing polls; it would
  // sit until `workflowExecutionTimeout` killed it and produce no run at all.
  // Reverting this line silently converts the nightly scorecard into a nightly
  // timeout, which is why it is pinned by name.
  const action = options().action;
  assert.equal(action.type, 'startWorkflow');
  assert.equal((action.workflowType as { name: string }).name, 'scorecardAuditWorkflow');
  assert.equal(action.taskQueue, 'steward-audit');
  assert.equal(action.workflowId, SCORECARD_SCHEDULE_WORKFLOW_ID);
});

test('every firing carries triggeredBy: schedule — the run-log entry depends on it', () => {
  const [input] = options().action.args as [ScorecardAuditInput];
  assert.equal(input.triggeredBy, 'schedule');
  assert.equal(input.publishMode, 'pr');
  assert.equal(input.maxAgeDays, 7);
  assert.equal(input.sitemapUrl, INPUT.sitemapUrl);
  assert.equal(input.timeZone, 'America/Vancouver');
});

test('a firing carries an execution timeout, so a wedged run cannot suppress every later one', () => {
  // With overlap SKIP and pauseOnFailure off, an execution that never completes
  // (server up, worker dead) would suppress every subsequent firing forever and
  // nothing would report a failure. The timeout is what bounds that.
  assert.equal(options().action.workflowExecutionTimeout, '2 hours');
});

test('the default firing hour is a quiet one, and off the top of the hour', () => {
  // This test used to assert the opposite — `hour >= 8 && hour <= 22`, on the
  // grounds that a 3am default on a sleeping laptop turned every firing into a
  // recovery. The hosted worker removed the premise, so the guard inverts: the
  // audit should now sample the site when nothing else is touching it.
  const { hour, minute } = parseTimeOfDay(SCORECARD_SCHEDULE_DEFAULT_AT);
  assert.ok(hour >= 1 && hour <= 5, `default ${SCORECARD_SCHEDULE_DEFAULT_AT} is not a quiet hour`);
  // Off the hour, because every cron on the internet picks :00 and both GitHub's
  // API and Vercel's edge are measurably quieter between the peaks.
  assert.notEqual(minute, 0);
});

test('a dry-run schedule freezes dry-run into every firing', () => {
  const [input] = options({ input: { ...INPUT, publishMode: 'dry-run' } }).action.args as [
    ScorecardAuditInput,
  ];
  assert.equal(input.publishMode, 'dry-run');
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test('parseTimeOfDay accepts HH:MM and rejects everything else', () => {
  assert.deepEqual(parseTimeOfDay('03:30'), { hour: 3, minute: 30 });
  assert.deepEqual(parseTimeOfDay('3:30'), { hour: 3, minute: 30 });
  assert.deepEqual(parseTimeOfDay(' 23:59 '), { hour: 23, minute: 59 });
  for (const bad of ['24:00', '03:60', '3:5', '0330', '3.30pm', '', 'noon']) {
    assert.throws(() => parseTimeOfDay(bad), /--at must be/, `accepted "${bad}"`);
  }
});

test('the six actions are the five the spec names plus the read-only one', () => {
  assert.deepEqual(
    [...SCORECARD_SCHEDULE_ACTIONS],
    ['status', 'create', 'pause', 'unpause', 'trigger', 'delete'],
  );
  for (const action of SCORECARD_SCHEDULE_ACTIONS) assert.ok(isScorecardScheduleAction(action));
  assert.equal(isScorecardScheduleAction('describe'), false);
  assert.equal(isScorecardScheduleAction('Create'), false);
});

// ---------------------------------------------------------------------------
// The five verbs, against a fake ScheduleClient
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  args: unknown[];
}

function fakeClient(
  behaviour: { createThrows?: Error; handleThrows?: Error; describeThrows?: Error } = {},
) {
  const calls: Call[] = [];
  // Stateful on purpose: the verbs report the schedule's state *after* the
  // action, and a fake that always answers `paused: false` would let a verb
  // that reported the state it read before the call pass this suite.
  let paused = false;
  // The server records the pause note on the schedule's state; the fake has to
  // as well, or the verb that reads it back has nothing to read.
  let note: string | undefined;
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
    if (behaviour.handleThrows && method !== 'describe') throw behaviour.handleThrows;
  };

  const handle: ScorecardScheduleHandleLike = {
    async describe() {
      calls.push({ method: 'describe', args: [] });
      // `status` calls nothing else, so `describe` is the only place a missing
      // schedule can surface for that verb.
      if (behaviour.describeThrows) throw behaviour.describeThrows;
      return {
        state: { paused, note },
        policies: {
          overlap: ScheduleOverlapPolicy.SKIP,
          // Derived from the constant rather than hardcoded, so a revert of the
          // policy fails the echo assertion too rather than leaving this half of
          // the suite reporting a healthy 23-hour window.
          catchupWindow: msOf(SCORECARD_SCHEDULE_CATCHUP_WINDOW),
          pauseOnFailure: false,
        },
        info: {
        nextActionTimes: [new Date('2026-08-09T10:30:00Z')],
        numActionsTaken: 2,
        numActionsMissedCatchupWindow: 4,
        numActionsSkippedOverlap: 1,
      },
      };
    },
    async pause(pauseNote) {
      record('pause', pauseNote);
      paused = true;
      note = pauseNote;
    },
    async unpause(unpauseNote) {
      record('unpause', unpauseNote);
      paused = false;
      note = unpauseNote;
    },
    async trigger(overlap) {
      record('trigger', overlap);
    },
    async delete() {
      record('delete');
    },
  };

  const schedule: ScorecardScheduleClientLike = {
    async create(opts: ScheduleOptions) {
      calls.push({ method: 'create', args: [opts] });
      if (behaviour.createThrows) throw behaviour.createThrows;
      return undefined;
    },
    getHandle(scheduleId: string) {
      calls.push({ method: 'getHandle', args: [scheduleId] });
      return handle;
    },
  };

  return { schedule, calls };
}

test('status reads everything and writes nothing', async () => {
  const { schedule, calls } = fakeClient();
  const outcome = await runScorecardScheduleAction('status', { schedule, timeZone: TZ });

  // The whole point of the verb: the only call it may make is the read. A
  // regression that reached the shared reporting block via `unpause` — which is
  // literally how this state used to be inspected — has to fail here.
  assert.deepEqual(
    calls.map((c) => c.method),
    ['getHandle', 'describe'],
  );

  assert.ok(outcome.lines.includes('exists'), outcome.lines.join(' | '));
  assert.ok(outcome.lines.includes('paused: false'), outcome.lines.join(' | '));
  assert.ok(outcome.lines.some((l) => l.includes('actions taken so far: 2')));
  assert.ok(outcome.lines.some((l) => /catchup window 3600000ms/.test(l)));
  assert.ok(outcome.lines.some((l) => l.includes('America/Vancouver')));
});

test('status prints the two counters that measure whether firings are being lost', async () => {
  // Both come straight from `describe()` and neither was printed anywhere
  // before. The missed-catchup count used to measure how often the laptop being
  // asleep cost a run. Against Cloud it should sit at zero permanently, so a
  // non-zero value now reports a Temporal outage at the firing hour rather than
  // a habit — a rarer and more interesting signal from the same number.
  const { schedule } = fakeClient();
  const outcome = await runScorecardScheduleAction('status', { schedule, timeZone: TZ });
  const counters = outcome.lines.find((l) => l.includes('firings missed'));
  assert.ok(counters, outcome.lines.join(' | '));
  // The window, not a hardcoded number: this assertion passed while the label
  // said "23h" and the policy said one hour, which is the drift it now catches.
  assert.match(counters, /firings missed \(unreachable >1 hour\): 4/);
  assert.match(counters, /skipped for overlap: 1/);
});

test('status carries the pause note, so "why is this paused" is answered where it is asked', async () => {
  const { schedule } = fakeClient();
  await runScorecardScheduleAction('pause', { schedule, note: 'travelling', timeZone: TZ });
  const outcome = await runScorecardScheduleAction('status', { schedule, timeZone: TZ });
  assert.ok(outcome.lines.some((l) => l === 'paused: true (travelling)'), outcome.lines.join(' | '));
});

test('status on a schedule that does not exist says so, not `ScheduleNotFoundError`', async () => {
  const { schedule } = fakeClient({
    describeThrows: new ScheduleNotFoundError('gone', SCORECARD_SCHEDULE_ID),
  });
  await assert.rejects(
    () => runScorecardScheduleAction('status', { schedule, timeZone: TZ }),
    /No schedule[\s\S]*create/,
  );
});

test('every mutating verb now reports the counters too', async () => {
  // The counters ride the shared reporting block rather than the status verb, so
  // whichever verb an operator happens to run answers "have any firings been
  // lost" without a second command.
  for (const action of ['pause', 'unpause', 'trigger'] as const) {
    const { schedule } = fakeClient();
    const outcome = await runScorecardScheduleAction(action, { schedule, timeZone: TZ });
    assert.ok(
      outcome.lines.some((l) => l.includes('firings missed')),
      `${action}: ${outcome.lines.join(' | ')}`,
    );
  }
});

test('create sends the built options and reports the next firing', async () => {
  const { schedule, calls } = fakeClient();
  const built = options();
  const outcome = await runScorecardScheduleAction('create', {
    schedule,
    options: built,
    timeZone: 'America/Vancouver',
  });

  assert.equal(calls[0].method, 'create');
  assert.equal(calls[0].args[0], built);
  assert.equal(outcome.scheduleId, SCORECARD_SCHEDULE_ID);
  assert.ok(outcome.lines.includes('created'));
  // Local, not UTC: 10:30Z is 03:30 in Vancouver, which is what the operator typed.
  assert.ok(
    outcome.lines.some((l) => l.includes('America/Vancouver') && l.includes('03:30')),
    outcome.lines.join(' | '),
  );
  // The policies the server stored, echoed back — a clamped catchup window has
  // to be visible somewhere, and this is the only place it can show up. 1 hour
  // is 3600000ms; a different number here means the server did not keep what
  // the CLI sent.
  assert.ok(outcome.lines.some((l) => /catchup window 3600000ms/.test(l) && /overlap SKIP/.test(l)));
  // The remaining limit is stated by the tool itself, not only in the docs. It
  // is no longer "this needs `steward up`", and since 2026-08-15 it is no
  // longer "and nothing alerts on that yet" either — it is "this needs the
  // hosted container, and you will hear about it when that stops being true".
  assert.ok(
    outcome.lines.some((l) => /Railway container/.test(l) && /steward-nightly-scorecard/.test(l)),
  );
});

test('create refuses to guess when the options are missing', async () => {
  const { schedule } = fakeClient();
  await assert.rejects(
    () => runScorecardScheduleAction('create', { schedule, timeZone: TZ }),
    /schedule options/,
  );
});

test('create on an existing schedule explains that the action args are frozen', async () => {
  const { schedule } = fakeClient({ createThrows: new ScheduleAlreadyRunning('taken', SCORECARD_SCHEDULE_ID) });
  await assert.rejects(
    () => runScorecardScheduleAction('create', { schedule, options: options(), timeZone: TZ }),
    /already exists[\s\S]*delete/,
  );
});

test('pause and unpause report the state the action produced, not the one before it', async () => {
  const { schedule, calls } = fakeClient();
  const paused = await runScorecardScheduleAction('pause', {
    schedule,
    note: 'travelling',
    timeZone: TZ,
  });
  assert.deepEqual(calls.find((c) => c.method === 'pause')?.args, ['travelling']);
  assert.ok(paused.lines[0].includes('travelling'));
  assert.ok(paused.lines.some((l) => l.startsWith('paused: true')), paused.lines.join(' | '));
  assert.ok(paused.lines.some((l) => l.includes('actions taken so far: 2')));

  const resumed = await runScorecardScheduleAction('unpause', { schedule, timeZone: TZ });
  assert.deepEqual(calls.find((c) => c.method === 'unpause')?.args, [undefined]);
  assert.ok(resumed.lines.some((l) => l === 'paused: false'), resumed.lines.join(' | '));
});

test('trigger overrides the SDK default with SKIP so it cannot stack an audit', async () => {
  const { schedule, calls } = fakeClient();
  const outcome = await runScorecardScheduleAction('trigger', { schedule, timeZone: TZ });
  assert.deepEqual(calls.find((c) => c.method === 'trigger')?.args, [ScheduleOverlapPolicy.SKIP]);
  // A triggered run is a Schedule action, so it archives as automated — the one
  // way `entry` can say "Nightly" without a clock firing.
  assert.ok(outcome.lines.some((l) => /Nightly/.test(l)));
});

test('delete stops there — no describe against a schedule that no longer exists', async () => {
  const { schedule, calls } = fakeClient();
  const outcome = await runScorecardScheduleAction('delete', { schedule, timeZone: TZ });
  assert.deepEqual(outcome.lines, ['deleted']);
  assert.equal(calls.some((c) => c.method === 'describe'), false);
});

test('a missing schedule is named, with the verb that would create it', async () => {
  for (const action of ['pause', 'unpause', 'trigger', 'delete'] as const) {
    const { schedule } = fakeClient({ handleThrows: new ScheduleNotFoundError('gone', SCORECARD_SCHEDULE_ID) });
    await assert.rejects(
      () => runScorecardScheduleAction(action, { schedule, timeZone: TZ }),
      /No schedule[\s\S]*create/,
      `${action} did not explain the missing schedule`,
    );
  }
});
