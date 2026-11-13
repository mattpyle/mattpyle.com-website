import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { Client } from '@temporalio/client';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { listOpenFindingWorkflows } from '../../src/activities/findings.js';
import { findingWorkflowId, findingsIndexPath, listedRuns, type OpenFindingListing, type OpenFindingWorkflow } from '../../src/lib/findings.js';

/**
 * `listOpenFindingWorkflows` in its three modes, against a fake client that
 * counts the `state` queries it is asked for and a fake GitHub that serves the
 * indexes. The reconciler's cost is the number of queries, so the count is what
 * is asserted; the plan stays identical in `tests/lib/findings.test.ts`.
 */

const REPO = 'mattpyle/argus';

const STATES: Record<string, { step: string; fixAttempts: number; issueUrl: string | null }> = {};

function indexText(lines: string[]): string {
  return ['# Findings index', '', 'One line per finding: `key | status | kind | scenario | title | verdict reason`.', '', ...lines, ''].join('\n');
}

function line(key: string, status: string): string {
  return `${key} | ${status} | defect | s | title | reason`;
}

// Site `a` has one run behind each status; site `broken` has an unreadable index.
const A_KEYS = ['k-approved', 'k-rejected', 'k-resolved', 'k-proposed', 'k-reopened'] as const;
const A_STATUS: Record<string, string> = {
  'k-approved': 'approved',
  'k-rejected': 'rejected',
  'k-resolved': 'resolved',
  'k-proposed': 'proposed',
  'k-reopened': 'reopened',
};

let fake: FakeGitHub | undefined;
let realFetch: typeof fetch | undefined;

afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
  fake?.restore();
  fake = undefined;
});

function install(): void {
  fake = installFakeGitHub({
    defaultBranch: 'main',
    seed: { [findingsIndexPath('a')]: indexText(A_KEYS.map((key) => line(key, A_STATUS[key]!))) },
  });
  // A site named `broken` cannot be read: any request for its path fails.
  const inner = globalThis.fetch;
  realFetch = inner;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    String(url).includes('/broken/') ? new Response('{}', { status: 500 }) : inner(url, init)) as typeof fetch;
}

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
          return STATES[workflowId] ?? { step: 'waiting-fix', fixAttempts: 0, issueUrl: null };
        },
      }),
    },
  } as unknown as Client;
  return { client, queried };
}

const IDS = [...A_KEYS.map((key) => findingWorkflowId('a', key)), findingWorkflowId('a', 'k-no-line'), findingWorkflowId('broken', 'k-one'), findingWorkflowId('broken', 'k-two')];

async function run(input: Parameters<typeof listOpenFindingWorkflows>[0]) {
  const { client, queried } = fakeClient(IDS);
  const env = new MockActivityEnvironment({}, { client });
  const out = (await env.run(() => listOpenFindingWorkflows(input))) as OpenFindingWorkflow[] | OpenFindingListing;
  return { out, queried };
}

test('no argument queries every run and returns the bare array, as before the modes', async () => {
  const { out, queried } = await run(undefined);
  assert.ok(Array.isArray(out));
  assert.equal(queried.length, IDS.length);
  assert.ok((out as OpenFindingWorkflow[]).every((r) => r.step === 'waiting-fix' && r.queried === undefined));
});

test('idsOnly queries nothing and lists every run with a null step', async () => {
  const { out, queried } = await run({ idsOnly: true });
  assert.deepEqual(queried, []);
  const runs = listedRuns(out);
  assert.equal(runs.length, IDS.length);
  assert.ok(runs.every((r) => r.step === null && r.queried === false));
});

test('pruning queries the runs behind approved, rejected and resolved lines, and every run of a site whose index fails', { timeout: 60_000 }, async () => {
  install();
  const { out, queried } = await run({ repo: REPO, sites: ['a', 'broken'] });
  assert.ok(!Array.isArray(out));
  const listing = out as OpenFindingListing;
  assert.deepEqual(
    [...queried].sort(),
    [findingWorkflowId('a', 'k-approved'), findingWorkflowId('a', 'k-rejected'), findingWorkflowId('a', 'k-resolved'), findingWorkflowId('broken', 'k-one'), findingWorkflowId('broken', 'k-two')].sort(),
  );
  assert.equal(listing.queried, 5);
  assert.equal(listing.indexReads, 2);
  assert.equal(listing.runs.length, IDS.length, 'every open run is still listed');
  const byId = new Map(listing.runs.map((r) => [r.workflowId, r]));
  for (const key of ['k-proposed', 'k-reopened', 'k-no-line']) {
    const r = byId.get(findingWorkflowId('a', key))!;
    assert.equal(r.step, null, key);
    assert.equal(r.queried, false, key);
  }
  for (const key of ['k-approved', 'k-rejected', 'k-resolved']) {
    assert.equal(byId.get(findingWorkflowId('a', key))!.step, 'waiting-fix', key);
  }
  // The failed read never falls back to null steps.
  assert.equal(byId.get(findingWorkflowId('broken', 'k-one'))!.step, 'waiting-fix');
});
