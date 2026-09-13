import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import {
  FINDINGS_SCHEDULE_CATCHUP_WINDOW,
  buildFindingsScheduleOptions,
  runFindingsScheduleAction,
} from '../../src/lib/findings-schedule.js';
import type { ScorecardScheduleClientLike } from '../../src/lib/scorecard-schedule.js';

const exec = promisify(execFile);
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(STEWARD, 'src', 'cli.ts');

/**
 * `steward finding`: the argument guards through the real CLI, every one of
 * which fails before `client()` so no server is needed, and the Schedule's
 * options and verbs against a fake schedule client, in the
 * `scorecard-schedule` tests' shape.
 */

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: STEWARD });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('an unknown schedule action is named, with the five that exist', async () => {
  const { code, out } = await runCli(['finding', 'schedule', 'delete']);
  assert.equal(code, 1);
  assert.match(out, /Unknown action "delete"/);
  assert.match(out, /create, describe, pause, unpause, trigger/);
});

test('--note is refused on a schedule verb that records no note', async () => {
  const { code, out } = await runCli(['finding', 'schedule', 'trigger', '--note', 'why']);
  assert.equal(code, 1);
  assert.match(out, /--note applies to `pause` and `unpause` only/);
});

test('a key that could traverse is refused before anything connects', async () => {
  const { code, out } = await runCli(['finding', 'approve', '../../etc']);
  assert.equal(code, 1);
  assert.match(out, /Invalid key/);
});

test('reject needs a reason', async () => {
  const { code, out } = await runCli(['finding', 'reject', 'some-key']);
  assert.equal(code, 1);
  assert.match(out, /--reason/);
});

test('the finding verbs are listed in help', async () => {
  const { code, out } = await runCli(['finding', '--help']);
  assert.equal(code, 0);
  for (const verb of ['list', 'status', 'approve', 'reject', 'schedule', 'sync']) {
    assert.match(out, new RegExp(`\\b${verb}\\b`));
  }
});

test('the Schedule fires at minute 5 of every hour, skips overlaps, and freezes the repository', () => {
  const options = buildFindingsScheduleOptions({ taskQueue: 'steward-findings', input: { repo: 'mattpyle/argus' } });
  assert.equal(options.scheduleId, 'steward-findings-reconcile');
  assert.deepEqual(options.spec.calendars, [{ hour: '*', minute: 5 }]);
  assert.equal(options.policies?.overlap, ScheduleOverlapPolicy.SKIP);
  assert.equal(options.policies?.catchupWindow, FINDINGS_SCHEDULE_CATCHUP_WINDOW);
  assert.equal(options.policies?.pauseOnFailure, false);
  assert.equal(options.action.type, 'startWorkflow');
  if (options.action.type !== 'startWorkflow') return;
  assert.equal(options.action.taskQueue, 'steward-findings');
  assert.deepEqual(options.action.args, [{ repo: 'mattpyle/argus' }]);
  assert.ok(options.action.workflowExecutionTimeout, 'a wedged run must time out rather than suppress every later firing');
});

function fakeSchedule() {
  const calls: string[] = [];
  const schedule: ScorecardScheduleClientLike = {
    create: async () => {
      calls.push('create');
    },
    getHandle: () => ({
      describe: async () => ({
        state: { paused: false },
        policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: 1_800_000, pauseOnFailure: false },
        info: {
          nextActionTimes: [new Date('2026-09-12T20:05:00Z')],
          numActionsTaken: 3,
          numActionsMissedCatchupWindow: 0,
          numActionsSkippedOverlap: 0,
        },
      }),
      pause: async (note?: string) => {
        calls.push(`pause:${note ?? ''}`);
      },
      unpause: async () => {
        calls.push('unpause');
      },
      trigger: async (overlap?: ScheduleOverlapPolicy) => {
        calls.push(`trigger:${overlap}`);
      },
      delete: async () => {
        calls.push('delete');
      },
    }),
  };
  return { schedule, calls };
}

test('trigger cannot bypass the SKIP policy, and every verb reports the schedule afterwards', async () => {
  const { schedule, calls } = fakeSchedule();
  const outcome = await runFindingsScheduleAction('trigger', { schedule, timeZone: 'America/Vancouver' });
  assert.deepEqual(calls, [`trigger:${ScheduleOverlapPolicy.SKIP}`]);
  assert.ok(outcome.lines.some((l) => /actions taken so far: 3/.test(l)));
  assert.ok(outcome.lines.some((l) => /next firings \(America\/Vancouver\)/.test(l)));
});

test('describe changes nothing', async () => {
  const { schedule, calls } = fakeSchedule();
  await runFindingsScheduleAction('describe', { schedule, timeZone: 'UTC' });
  assert.deepEqual(calls, []);
});
