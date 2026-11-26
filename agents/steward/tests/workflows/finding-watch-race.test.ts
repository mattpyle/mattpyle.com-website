import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowUpdateStage, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';
import { bounded, createLocalEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT } from '../helpers/verdict-measure.js';
import {
  findingStateQuery,
  findingWorkflow,
  verdictUpdate,
  type FindingState,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import type { FindingSettings } from '../../src/activities/findings.js';
import type { WatchFindingResult } from '../../src/activities/findings-watch.js';
import type { FindingVerdict } from '../../src/lib/findings.js';

/**
 * Stage 4's race on the real `findingWorkflow`: the watch's resolved result
 * and a `rejected` verdict Update in one workflow task. On a real dev server
 * (`createLocalEnv`): the test server did not deliver the Update to a run
 * whose workflow worker stopped and started again. Nothing here waits on a
 * timer, so time-skipping buys nothing.
 */

const FINDINGS = 'steward-findings';
const WATCH = 'steward-findings-watch';
const SITE = 'temporal-io';
const WATCHES: FindingSettings = { ...STOPS_AT_VERDICT, watch: true };

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

const APPROVE: FindingVerdict = { status: 'approved', reason: 'In the file.', source: 'file', at: '2026-11-25T09:00:00.000Z' };
const REJECT: FindingVerdict = { status: 'rejected', reason: 'Not worth it.', source: 'cli', at: '2026-11-25T10:00:00.000Z' };

/** The failure a still-present finding throws: benign, until the next day. */
const stillPresent = () =>
  ApplicationFailure.create({ type: 'StillPresent', message: 'still present', nextRetryDelay: '1 day', category: ApplicationFailureCategory.BENIGN });

interface Scene {
  settings?: FindingSettings;
  /** What each `watchFinding` attempt does, by attempt across the run; the last repeats. */
  watch: Array<WatchFindingResult | 'still' | 'hold'>;
}

function mocks(scene: Scene) {
  const called: string[] = [];
  const queues: string[] = [];
  let attempts = 0;
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => (release = resolve));
  const activities = {
    readFindingSettings: async () => (called.push('readFindingSettings'), scene.settings ?? WATCHES),
    writeFindingVerdict: async () => (called.push('writeFindingVerdict'), { findingCommitSha: 'f1', indexCommitSha: 'i1', commitSha: 'v1' }),
    watchFinding: async (): Promise<WatchFindingResult> => {
      called.push('watchFinding');
      queues.push(Context.current().info.taskQueue);
      const step = scene.watch[Math.min(attempts, scene.watch.length - 1)];
      attempts++;
      if (step === 'still') throw stillPresent();
      if (step === 'hold') {
        await held;
        return { outcome: 'resolved', commitSha: 'r1', rows: [], at: '2026-11-25T11:00:00.000Z' };
      }
      return step;
    },
  };
  return {
    activities,
    called,
    queues,
    attempts: () => attempts,
    release: () => release?.(),
    count: (name: string) => called.filter((c) => c === name).length,
  };
}

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

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`never saw ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The workflow worker on the findings queue and the watch worker on its own, as the hosted worker runs them. */
async function workers(m: ReturnType<typeof mocks>) {
  const { watchFinding, ...rest } = m.activities;
  const findings = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: rest,
    taskQueue: FINDINGS,
  });
  const watch = await Worker.create({ connection: env.nativeConnection, activities: { watchFinding }, taskQueue: WATCH });
  return { findings, watch };
}

test('a resolved result and a rejection in one workflow task: the run ends resolved and the Update is answered with a failure', async () => {
  const m = mocks({ watch: ['hold'] });
  const id = 'race';
  const handle = await client.workflow.start(findingWorkflow, { workflowId: `finding/${SITE}/${id}`, taskQueue: FINDINGS, args: [input(id)] });
  const first = await workers(m);
  // The watch worker runs throughout; the workflow worker runs until the run watches, then stops.
  const watchRunning = first.watch.run();
  try {
    await first.findings.runUntil(
      bounded(
        (async () => {
          await until(handle, (s) => s.step === 'watching', 'watching');
          await waitFor(() => m.attempts() === 1, 'the held attempt');
        })(),
      ),
    );
    // With no workflow worker, the Update and the activity's result wait for the same workflow task.
    const update = handle.startUpdate(verdictUpdate, { args: [REJECT], waitForStage: WorkflowUpdateStage.ACCEPTED });
    update.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
    m.release();
    await new Promise((r) => setTimeout(r, 1000));
    const second = await Worker.create({
      connection: env.nativeConnection,
      workflowBundle: await workflowBundle(),
      activities: { readFindingSettings: m.activities.readFindingSettings, writeFindingVerdict: m.activities.writeFindingVerdict },
      taskQueue: FINDINGS,
    });
    const out = await second.runUntil(
      bounded(
        (async () => {
          let answer: unknown;
          try {
            answer = await (await update).result();
          } catch (err) {
            answer = err;
          }
          return { answer, result: await handle.result() };
        })(),
      ),
    );
    assert.equal(out.result.outcome, 'resolved');
    assert.ok(out.answer instanceof Error, `the Update was answered with ${JSON.stringify(out.answer)}`);
    assert.match(String((out.answer as Error & { cause?: Error }).cause?.message), /resolved before the rejection was written/);
    assert.ok(!m.called.includes('writeFindingVerdict'), 'no rejection written over a resolved file');
  } finally {
    first.watch.shutdown();
    await watchRunning;
  }
});
