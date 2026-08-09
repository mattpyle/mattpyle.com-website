import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleAlreadyRunning, ScheduleNotFoundError, ScheduleOverlapPolicy, type ScheduleOptions } from '@temporalio/client';

import {
  SCORECARD_SCHEDULE_ACTIONS,
  SCORECARD_SCHEDULE_CATCHUP_WINDOW,
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
 * Two halves, and neither needs a server. The first pins the three policy
 * choices the card argues for — they are the decision, and a silent revert of
 * `catchupWindow` to the SDK's one-year default would publish fake time-series
 * points rather than fail visibly. The second drives the five verbs against a
 * fake `ScheduleClient`, which is where the CLI's behaviour actually lives.
 */

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
    taskQueue: 'steward-light',
    input: INPUT,
    ...overrides,
  });
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

test('the catchup window is seconds, not the SDK default — missed firings must drop', () => {
  // Pinned as a value, not just "not undefined": a run taken hours late measures
  // the site as it is hours later, which is fake data in a time series.
  assert.equal(SCORECARD_SCHEDULE_CATCHUP_WINDOW, '10 seconds');
});

test('the spec is a daily calendar firing in the given timezone', () => {
  const spec = options({ at: { hour: 22, minute: 5 } }).spec;
  assert.deepEqual(spec.calendars, [{ hour: 22, minute: 5 }]);
  assert.equal(spec.timezone, 'America/Vancouver');
  // A calendar spec only. An interval would drift relative to creation time.
  assert.equal(spec.intervals, undefined);
  assert.equal(spec.cronExpressions, undefined);
});

test('the action starts the audit workflow on the light queue with a stable base id', () => {
  const action = options().action;
  assert.equal(action.type, 'startWorkflow');
  assert.equal((action.workflowType as { name: string }).name, 'scorecardAuditWorkflow');
  assert.equal(action.taskQueue, 'steward-light');
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

test('the five actions are the five the spec names', () => {
  assert.deepEqual([...SCORECARD_SCHEDULE_ACTIONS], ['create', 'pause', 'unpause', 'trigger', 'delete']);
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

function fakeClient(behaviour: { createThrows?: Error; handleThrows?: Error } = {}) {
  const calls: Call[] = [];
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
    if (behaviour.handleThrows && method !== 'describe') throw behaviour.handleThrows;
  };

  const handle: ScorecardScheduleHandleLike = {
    async describe() {
      calls.push({ method: 'describe', args: [] });
      return {
        state: { paused: false },
        info: { nextActionTimes: [new Date('2026-08-09T10:30:00Z')], numActionsTaken: 2 },
      };
    },
    async pause(note) {
      record('pause', note);
    },
    async unpause(note) {
      record('unpause', note);
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

test('create sends the built options and reports the next firing', async () => {
  const { schedule, calls } = fakeClient();
  const built = options();
  const outcome = await runScorecardScheduleAction('create', { schedule, options: built });

  assert.equal(calls[0].method, 'create');
  assert.equal(calls[0].args[0], built);
  assert.equal(outcome.scheduleId, SCORECARD_SCHEDULE_ID);
  assert.ok(outcome.lines.includes('created'));
  assert.ok(outcome.lines.some((l) => l.includes('2026-08-09T10:30:00.000Z')));
  // The laptop-stack limit is stated by the tool itself, not only in the docs.
  assert.ok(outcome.lines.some((l) => /steward up/.test(l) && /not unattended/.test(l)));
});

test('create refuses to guess when the options are missing', async () => {
  const { schedule } = fakeClient();
  await assert.rejects(() => runScorecardScheduleAction('create', { schedule }), /schedule options/);
});

test('create on an existing schedule explains that the action args are frozen', async () => {
  const { schedule } = fakeClient({ createThrows: new ScheduleAlreadyRunning('taken', SCORECARD_SCHEDULE_ID) });
  await assert.rejects(
    () => runScorecardScheduleAction('create', { schedule, options: options() }),
    /already exists[\s\S]*delete/,
  );
});

test('pause and unpause pass the note through and report the state after', async () => {
  const { schedule, calls } = fakeClient();
  const paused = await runScorecardScheduleAction('pause', { schedule, note: 'travelling' });
  assert.deepEqual(calls.find((c) => c.method === 'pause')?.args, ['travelling']);
  assert.ok(paused.lines[0].includes('travelling'));
  assert.ok(paused.lines.some((l) => l === 'paused: false')); // the fake's state
  assert.ok(paused.lines.some((l) => l.includes('actions taken so far: 2')));

  const { schedule: s2, calls: c2 } = fakeClient();
  await runScorecardScheduleAction('unpause', { schedule: s2 });
  assert.deepEqual(c2.find((c) => c.method === 'unpause')?.args, [undefined]);
});

test('trigger overrides the SDK default with SKIP so it cannot stack an audit', async () => {
  const { schedule, calls } = fakeClient();
  const outcome = await runScorecardScheduleAction('trigger', { schedule });
  assert.deepEqual(calls.find((c) => c.method === 'trigger')?.args, [ScheduleOverlapPolicy.SKIP]);
  // A triggered run is a Schedule action, so it archives as automated — the one
  // way `entry` can say "Nightly" without a clock firing.
  assert.ok(outcome.lines.some((l) => /Nightly/.test(l)));
});

test('delete stops there — no describe against a schedule that no longer exists', async () => {
  const { schedule, calls } = fakeClient();
  const outcome = await runScorecardScheduleAction('delete', { schedule });
  assert.deepEqual(outcome.lines, ['deleted']);
  assert.equal(calls.some((c) => c.method === 'describe'), false);
});

test('a missing schedule is named, with the verb that would create it', async () => {
  for (const action of ['pause', 'unpause', 'trigger', 'delete'] as const) {
    const { schedule } = fakeClient({ handleThrows: new ScheduleNotFoundError('gone', SCORECARD_SCHEDULE_ID) });
    await assert.rejects(
      () => runScorecardScheduleAction(action, { schedule }),
      /No schedule[\s\S]*create/,
      `${action} did not explain the missing schedule`,
    );
  }
});
