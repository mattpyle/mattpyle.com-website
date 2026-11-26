import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockActivityEnvironment, type TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { bounded, createLocalEnv, untilBetweenAttempts } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT } from '../helpers/verdict-measure.js';
import { findingWorkflow, findingStateQuery } from '../../src/workflows/finding.js';
import { readWatchRun } from '../../src/activities/findings-recheck.js';
import type { WatchRun } from '../../src/lib/findings-recheck.js';

/**
 * `readWatchRun` (STW-678) against a real dev server, on runs of the real
 * `findingWorkflow`: what the recheck is told about a run whose attempt waits,
 * one whose attempt never started, one with no attempt, and no run at all. A
 * dev server (`createLocalEnv`), because the time-skipping server reports a
 * waiting retry as started.
 */

const FINDINGS = 'steward-findings';
const WATCH = 'steward-findings-watch';
const SITE = 'temporal-io';

let env: TestWorkflowEnvironment;

beforeEach(async () => {
  env = await createLocalEnv();
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

const read = (workflowId: string): Promise<WatchRun> =>
  new MockActivityEnvironment({}, { client: env.client }).run(readWatchRun, { workflowId });

test('a run is read by its ID: waiting, never started, not watching, closed and unknown', async () => {
  const findings = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: { readFindingSettings: async () => ({ ...STOPS_AT_VERDICT, watch: true }) },
    taskQueue: FINDINGS,
  });
  const watch = await Worker.create({
    connection: env.nativeConnection,
    activities: {
      watchFinding: async () => {
        throw ApplicationFailure.create({ type: 'StillPresent', message: 'still present on 2026-11-25', nextRetryDelay: '1 day' });
      },
    },
    taskQueue: WATCH,
  });
  const start = (key: string, approved: boolean) =>
    env.client.workflow.start(findingWorkflow, {
      workflowId: `finding/${SITE}/${key}`,
      taskQueue: FINDINGS,
      args: [
        {
          site: SITE,
          key,
          repo: 'mattpyle/argus',
          findingPath: `sites/${SITE}/findings/${key}.md`,
          indexPath: `sites/${SITE}/findings/INDEX.md`,
          ...(approved ? { verdict: { status: 'approved' as const, reason: 'r', source: 'file' as const, at: '2026-11-25T09:00:00.000Z' } } : {}),
        },
      ],
    });

  await findings.runUntil(
    bounded(
      (async () => {
        assert.deepEqual(await read(`finding/${SITE}/unknown`), { state: 'no run' });

        // No watch worker yet: the first attempt is scheduled and never starts.
        const handle = await start('waits', true);
        while ((await handle.query(findingStateQuery)).step !== 'watching') await new Promise((r) => setTimeout(r, 50));
        const unstarted = await read(handle.workflowId);
        assert.ok(unstarted.state === 'open' && unstarted.pending);
        assert.equal(unstarted.pending.attempt, 1);
        assert.equal(unstarted.pending.lastStartedAt, null);
        assert.equal(unstarted.pending.lastCompletedAt, null);
        assert.ok(unstarted.pending.scheduledAt);
        assert.equal(unstarted.pending.failureType, null);

        await watch.runUntil(bounded(untilBetweenAttempts(handle, 'watchFinding')));
        const waiting = await read(handle.workflowId);
        assert.ok(waiting.state === 'open' && waiting.pending);
        assert.equal(waiting.pending.failureType, 'StillPresent');
        assert.equal(waiting.pending.failureMessage, 'still present on 2026-11-25');
        assert.equal(waiting.pending.lastStartedAt, null);
        assert.ok(Date.now() - Date.parse(waiting.pending.lastCompletedAt!) < 60_000, 'the completion ages the waiting retry');
        assert.ok(Date.parse(waiting.pending.scheduledAt!) > Date.now(), 'the scheduled time is the next attempt');

        const parked = await start('parked', false);
        assert.deepEqual(await read(parked.workflowId), { state: 'open', pending: null, step: 'waiting-verdict' });
        await parked.terminate();
        assert.deepEqual(await read(parked.workflowId), { state: 'no run' });
        await handle.terminate();
      })(),
    ),
  );
});
