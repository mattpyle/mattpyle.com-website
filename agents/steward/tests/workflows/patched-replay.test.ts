import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { bounded, createLocalEnv } from '../helpers/test-env.js';

/**
 * What `patched()` answers on replay at a site that ran BEFORE the marker was
 * recorded (STW-689). `findingWorkflow` reads its `failure-parks` marker at
 * several sites. A run could pass one site on the old code, stay open, and
 * record the marker later at another. If replay then answered true at the
 * first site, the run would take the new branch there and fail with
 * `TMPRL1100`.
 *
 * The history is recorded on `patch-probe-v1.ts`: the first activity fails, the
 * catch goes on, the run waits for a signal, and only then reads the marker
 * and records it. It is replayed on `patch-probe-v2.ts`, whose catch reads the
 * marker and, on true, issues a command the history does not hold.
 *
 * Result with the installed TypeScript SDK (2026-11-25): the replay passes, so
 * `patched()` answers false at the earlier site. The workflow learns of a
 * marker only when it replays the workflow task that recorded it, so a site
 * in an earlier task does not see it. Temporal's patching page
 * (docs.temporal.io/patching, "Behavior when replaying with marker after
 * current location") describes a non-determinism error for this case; it is
 * written for the Python, .NET and Ruby SDKs, and this test is the TypeScript
 * answer. The second test replays the same history on code whose catch issues
 * the new command with no guard, and that replay fails, so the first can fail.
 */

const v1 = fileURLToPath(new URL('../fixtures/workflows/patch-probe-v1.ts', import.meta.url));
const v2 = fileURLToPath(new URL('../fixtures/workflows/patch-probe-v2.ts', import.meta.url));
const QUEUE = 'patch-probe';

async function recordOnV1() {
  const env = await createLocalEnv();
  try {
    const client = new Client({ connection: env.connection, namespace: env.namespace });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      workflowsPath: v1,
      taskQueue: QUEUE,
      activities: {
        first: async () => {
          throw ApplicationFailure.nonRetryable('first fails', 'Probe');
        },
        marked: async () => undefined,
        newBranch: async () => undefined,
      },
    });
    return await worker.runUntil(
      bounded(
        (async () => {
          const handle = await client.workflow.start('patchProbe', { workflowId: 'patch-probe', taskQueue: QUEUE });
          // The catch has run and the run waits before the signal arrives, so the marker lands in a later task.
          for (let i = 0; i < 200; i++) {
            const history = await handle.fetchHistory();
            if (history.events?.some((e) => e.activityTaskFailedEventAttributes)) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          await handle.signal('go');
          assert.equal(await handle.result(), 'done');
          return await handle.fetchHistory();
        })(),
      ),
    );
  } finally {
    await env.teardown();
  }
}

test('patched() answers false on replay at a site that ran before its marker was recorded', { timeout: 120_000 }, async () => {
  const history = await recordOnV1();
  const markers = history.events?.filter((e) => e.markerRecordedEventAttributes) ?? [];
  assert.equal(markers.length, 1, 'the marker is recorded once, after the signal');
  const failedAt = Number(history.events?.find((e) => e.activityTaskFailedEventAttributes)?.eventId);
  const markedAt = Number(markers[0].eventId);
  const signalAt = Number(history.events?.find((e) => e.workflowExecutionSignaledEventAttributes)?.eventId);
  assert.ok(failedAt < signalAt && signalAt < markedAt, 'the catch ran in a task before the marker');
  await Worker.runReplayHistory({ workflowsPath: v2 }, history, 'patch-probe');
});

test('the probe can fail: a new command at that site, unguarded, breaks the replay', { timeout: 120_000 }, async () => {
  const history = await recordOnV1();
  const unguarded = fileURLToPath(new URL('../fixtures/workflows/patch-probe-unguarded.ts', import.meta.url));
  await assert.rejects(Worker.runReplayHistory({ workflowsPath: unguarded }, history, 'patch-probe'), /TMPRL1100|[Nn]ondeterminism/);
});
