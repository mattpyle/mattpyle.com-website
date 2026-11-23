import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { Client } from '@temporalio/client';
import { listOpenFindingWorkflows } from '../../src/activities/findings.js';
import { findingWorkflowId, listedRuns, type OpenFindingWorkflow } from '../../src/lib/findings.js';

/**
 * `listOpenFindingWorkflows` in its two modes, against a fake client that
 * counts the `state` queries it is asked for. The cost is the number of
 * queries, so the count is what is asserted.
 */

const IDS = ['k-approved', 'k-proposed', 'k-reopened'].map((key) => findingWorkflowId('a', key));

function fakeClient(ids: string[]): { client: Client; queried: string[] } {
  const queried: string[] = [];
  const client = {
    withAbortSignal: (_signal: unknown, fn: () => unknown) => fn(),
    workflow: {
      list: () =>
        (async function* () {
          for (const workflowId of ids) yield { workflowId, runId: `run-${workflowId}` };
        })(),
      getHandle: (workflowId: string) => ({
        query: async () => {
          queried.push(workflowId);
          return { step: 'waiting-fix', fixAttempts: 0, issueUrl: null };
        },
      }),
    },
  } as unknown as Client;
  return { client, queried };
}

async function run(input: Parameters<typeof listOpenFindingWorkflows>[0]) {
  const { client, queried } = fakeClient(IDS);
  const env = new MockActivityEnvironment({}, { client });
  const out = (await env.run(() => listOpenFindingWorkflows(input))) as OpenFindingWorkflow[];
  return { out, queried };
}

test('no argument queries every run and returns the bare array, as before the modes', async () => {
  const { out, queried } = await run(undefined);
  assert.ok(Array.isArray(out));
  assert.equal(queried.length, IDS.length);
  assert.ok(out.every((r) => r.step === 'waiting-fix' && r.queried === undefined));
});

test('idsOnly queries nothing and lists every run with a null step', async () => {
  const { out, queried } = await run({ idsOnly: true });
  assert.deepEqual(queried, []);
  const runs = listedRuns(out);
  assert.equal(runs.length, IDS.length);
  assert.ok(runs.every((r) => r.step === null && r.queried === false));
});
