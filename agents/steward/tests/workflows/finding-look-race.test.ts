import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowUpdateStage, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { bounded, createLocalEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT } from '../helpers/verdict-measure.js';
import {
  findingStateQuery,
  findingWorkflow,
  lookUpdate,
  measureNowUpdate,
  type FindingState,
  type FindingWorkflowInput,
  type LookRequest,
} from '../../src/workflows/finding.js';
import type { FindingSettings } from '../../src/activities/findings.js';
import type { WatchFindingResult } from '../../src/activities/findings-watch.js';
import type { WriteFindingLookResult } from '../../src/activities/findings-look.js';
import type { FindingVerdict } from '../../src/lib/findings.js';

/**
 * Stage 5's ties on the real `findingWorkflow`: a `record-look` Update and the
 * watch's result in one workflow task. The look is the race's third arm,
 * tested last, so the result wins: a `resolved` result answers the look by
 * the watch, and `stopped` writes the look all the same, as it writes a
 * rejection. On a real dev server (`createLocalEnv`), for the reason
 * `finding-watch-race.test.ts` gives.
 *
 * A third tie is a `measure-now` and a look in one task: the mapping takes
 * `measure`, the loop continues, and the top of the loop takes the look before
 * any second `watchFinding` is scheduled. That is the look's flag surviving a
 * `continue`. The same tie with the 30-day bound is not driven here: the bound
 * needs the time-skipping server, and that server did not deliver an Update to
 * a run whose workflow worker stopped and started again.
 */

const FINDINGS = 'steward-findings';
const WATCH = 'steward-findings-watch';
const SITE = 'temporal-io';
const RUN = '2026-11-26T0830Z';
const WATCHES: FindingSettings = { ...STOPS_AT_VERDICT, watch: true };
const APPROVE: FindingVerdict = { status: 'approved', reason: 'In the file.', source: 'file', at: '2026-11-25T09:00:00.000Z' };
const LOOK: LookRequest = { result: 'fixed', run: RUN, at: '2026-11-26T08:45:00.000Z', source: 'argus' };

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createLocalEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

type Handle = WorkflowHandle<typeof findingWorkflow>;

function input(id: string): FindingWorkflowInput {
  return {
    site: SITE,
    key: id,
    repo: 'mattpyle/argus',
    findingPath: `sites/${SITE}/findings/${id}.md`,
    indexPath: `sites/${SITE}/findings/INDEX.md`,
    verdict: APPROVE,
  };
}

async function until(handle: Pick<Handle, 'query'>, ready: (state: FindingState) => boolean, what: string): Promise<FindingState> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = await handle.query(findingStateQuery);
    if (ready(state)) return state;
    if (Date.now() > deadline) assert.fail(`the run never reached ${what}; it is at ${state.step}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Holds the first watch attempt, sends the look with no workflow worker, then lets both reach one task. */
async function tie(id: string, result: WatchFindingResult) {
  const called: string[] = [];
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => (release = resolve));
  let attempts = 0;
  const findingsActivities = {
    readFindingSettings: async () => (called.push('readFindingSettings'), WATCHES),
    writeFindingLook: async (): Promise<WriteFindingLookResult> => (called.push('writeFindingLook'), { by: 'look', resolvedRun: RUN, commitSha: 'abcdef1234' }),
  };
  const watchFinding = async (): Promise<WatchFindingResult> => {
    called.push('watchFinding');
    attempts++;
    await held;
    return result;
  };
  const handle = await client.workflow.start(findingWorkflow, { workflowId: `finding/${SITE}/${id}`, taskQueue: FINDINGS, args: [input(id)] });
  const first = await Worker.create({ connection: env.nativeConnection, workflowBundle: await workflowBundle(), activities: findingsActivities, taskQueue: FINDINGS });
  const watch = await Worker.create({ connection: env.nativeConnection, activities: { watchFinding }, taskQueue: WATCH });
  const watchRunning = watch.run();
  try {
    await first.runUntil(
      bounded(
        (async () => {
          await until(handle, (s) => s.step === 'watching', 'watching');
          const deadline = Date.now() + 30_000;
          while (attempts < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        })(),
      ),
    );
    // With no workflow worker, the Update and the activity's result wait for the same workflow task.
    const update = handle.startUpdate(lookUpdate, { args: [LOOK], waitForStage: WorkflowUpdateStage.ACCEPTED });
    update.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
    release!();
    await new Promise((r) => setTimeout(r, 1000));
    const second = await Worker.create({
      connection: env.nativeConnection,
      workflowBundle: await workflowBundle(),
      activities: findingsActivities,
      taskQueue: FINDINGS,
      maxCachedWorkflows: 0,
    });
    return await second.runUntil(
      bounded(
        (async () => {
          const answer = await (await update).result();
          const out = await handle.result();
          const events = (await handle.fetchHistory()).events ?? [];
          return { answer, out, events, called };
        })(),
      ),
    );
  } finally {
    watch.shutdown();
    await watchRunning;
  }
}

test('a look and a resolved result in one workflow task: the result wins, and the look is answered by the watch with nothing written', async () => {
  const { answer, out, events, called } = await tie('look-loses', { outcome: 'resolved', commitSha: 'r1', rows: [], at: '2026-11-26T09:00:00.000Z' });
  assert.equal(out.outcome, 'resolved');
  assert.equal(out.note, 'Resolved by its own watch: every check passed on production (commit r1).');
  assert.equal(answer.by, 'watch');
  assert.ok(!called.includes('writeFindingLook'), 'no look written over a resolved file');
  // One task after the result: the Update accepted, completed, and the run completed.
  const completedAt = events.findIndex((e) => e.activityTaskCompletedEventAttributes);
  const tail = events.slice(completedAt + 1).map((e) => Object.keys(e).find((k) => k.endsWith('EventAttributes')));
  assert.ok(tail.includes('workflowExecutionUpdateAcceptedEventAttributes'));
  assert.ok(tail.includes('workflowExecutionUpdateCompletedEventAttributes'));
  assert.equal(tail.at(-1), 'workflowExecutionCompletedEventAttributes');
});

test('a look and a stopped result in one workflow task: the look is written all the same, and the run ends resolved', async () => {
  const { answer, out, called } = await tie('look-stopped', { outcome: 'stopped' });
  assert.equal(answer.by, 'look');
  assert.equal(out.outcome, 'resolved');
  assert.equal(out.note, `Resolved by Argus's look ${RUN} (commit abcdef1).`);
  assert.ok(called.includes('writeFindingLook'));
});

test('a measure-now and a look in one workflow task: measure wins the mapping, and the next pass takes the look before any second watch', async () => {
  const called: string[] = [];
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => (release = resolve));
  let attempts = 0;
  const findingsActivities = {
    readFindingSettings: async () => (called.push('readFindingSettings'), WATCHES),
    writeFindingLook: async (): Promise<WriteFindingLookResult> => (called.push('writeFindingLook'), { by: 'look', resolvedRun: RUN, commitSha: 'abcdef1234' }),
  };
  // Held until the test ends: the run cancels it, and no second attempt is ever scheduled.
  const watchFinding = async (): Promise<WatchFindingResult> => {
    called.push('watchFinding');
    attempts++;
    await held;
    return { outcome: 'stopped' };
  };
  const id = 'look-after-measure';
  const handle = await client.workflow.start(findingWorkflow, { workflowId: `finding/${SITE}/${id}`, taskQueue: FINDINGS, args: [input(id)] });
  const first = await Worker.create({ connection: env.nativeConnection, workflowBundle: await workflowBundle(), activities: findingsActivities, taskQueue: FINDINGS });
  const watch = await Worker.create({ connection: env.nativeConnection, activities: { watchFinding }, taskQueue: WATCH });
  const watchRunning = watch.run();
  try {
    await first.runUntil(
      bounded(
        (async () => {
          await until(handle, (s) => s.step === 'watching', 'watching');
          const deadline = Date.now() + 30_000;
          while (attempts < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        })(),
      ),
    );
    // With no workflow worker, both Updates wait for the same workflow task, measure-now first.
    const measure = handle.startUpdate(measureNowUpdate, { args: [{ source: 'cli', at: '2026-11-26T08:44:00.000Z' }], waitForStage: WorkflowUpdateStage.ACCEPTED });
    measure.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
    const look = handle.startUpdate(lookUpdate, { args: [LOOK], waitForStage: WorkflowUpdateStage.ACCEPTED });
    look.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
    const second = await Worker.create({
      connection: env.nativeConnection,
      workflowBundle: await workflowBundle(),
      activities: findingsActivities,
      taskQueue: FINDINGS,
      maxCachedWorkflows: 0,
    });
    const out = await second.runUntil(
      bounded(
        (async () => {
          const measured = await (await measure).result();
          const answer = await (await look).result();
          const result = await handle.result();
          const events = (await handle.fetchHistory()).events ?? [];
          const state = await handle.query(findingStateQuery);
          return { measured, answer, result, events, state };
        })(),
      ),
    );
    const kind = (e: (typeof out.events)[number]) => Object.keys(e).find((k) => k.endsWith('EventAttributes'));
    const accepted = out.events.map((e, i) => (e.workflowExecutionUpdateAcceptedEventAttributes ? i : -1)).filter((i) => i >= 0);
    assert.equal(accepted.length, 2, 'both Updates were accepted');
    // The harness worked: no workflow task completed between the two acceptances.
    assert.ok(!out.events.slice(accepted[0], accepted[1]).some((e) => kind(e) === 'workflowTaskCompletedEventAttributes'), 'one workflow task took both');
    assert.deepEqual(out.measured, { workflowId: `finding/${SITE}/${id}`, issued: 'again' });
    assert.equal(out.answer.by, 'look');
    assert.equal(out.result.outcome, 'resolved');
    assert.equal(out.result.note, `Resolved by Argus's look ${RUN} (commit abcdef1).`);
    const scheduled = out.events
      .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
      .filter((name): name is string => Boolean(name));
    assert.equal(scheduled.filter((name) => name === 'watchFinding').length, 1, 'no second watchFinding was scheduled');
    assert.ok(scheduled.includes('writeFindingLook'));
    assert.equal(called.filter((c) => c === 'watchFinding').length, 1);
    // A watch scheduled and cancelled in one activation leaves no event, so the history alone
    // cannot tell the loop's top from the race arm: the run's own count of issues does.
    // Probe (2026-11-26): taking the look only from the race arm left this test green
    // without this assertion and failed it here (2 issues); reverted.
    assert.equal(out.state.watchIssues, 1, 'the second pass issued no watch');
  } finally {
    release!();
    watch.shutdown();
    await watchRunning;
  }
});
