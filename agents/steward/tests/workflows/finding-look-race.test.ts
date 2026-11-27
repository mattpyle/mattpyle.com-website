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
