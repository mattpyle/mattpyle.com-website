import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { createTestEnv } from '../helpers/test-env.js';
import { reconcileFindingsWorkflow } from '../../src/workflows/reconcile-findings.js';
import { findingStateQuery, type FindingState, type FindingWorkflowResult } from '../../src/workflows/finding.js';
import { startFindingWorkflow } from '../../src/activities/findings.js';
import {
  findingWorkflowId,
  parseFindingsIndex,
  type FindingsIndexLine,
  type OpenFindingWorkflow,
} from '../../src/lib/findings.js';

/**
 * `reconcileFindingsWorkflow` against the real test server, with the GitHub
 * reads mocked. The start activity is the real one, so the finding workflows it
 * starts are real executions, and the open-workflow list is read back from the
 * server rather than invented: the mocked `listOpenFindingWorkflows` asks the
 * server which of the known IDs are running, which is what the visibility query
 * answers in production.
 *
 * **A plain client, not `env.client`.** The time-skipping client unlocks time
 * while it waits on a result, and the test server's default execution timeout is
 * ten years, so the first wait jumped the clock past it and every waiting finding
 * workflow read back `TIMED_OUT`. Nothing here needs time to move.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE = 'steward-findings';

let env: TestWorkflowEnvironment;
let client: Client;

before(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

function header(lines: string[]): string {
  return ['# Findings index', '', 'Format: `key | status | title | verdict reason`.', '', ...lines].join('\n');
}

function store(initial: Record<string, string>) {
  const indexes: Record<string, string> = { ...initial };
  const pings: Array<{ signal: string; ok: boolean; summary: string }> = [];
  const writes: unknown[] = [];
  const flags = { autoFix: false };
  const fixIssues: string[] = [];

  const activities = {
    listSites: async () => Object.keys(indexes).sort(),
    readFindingsIndex: async (_repo: string, site: string): Promise<FindingsIndexLine[]> =>
      parseFindingsIndex(indexes[site] ?? ''),
    startFindingWorkflow,
    listOpenFindingWorkflows: async (): Promise<OpenFindingWorkflow[]> => {
      const open: OpenFindingWorkflow[] = [];
      for (const [site, text] of Object.entries(indexes)) {
        for (const line of parseFindingsIndex(text)) {
          const id = findingWorkflowId(site, line.key);
          try {
            const handle = client.workflow.getHandle(id);
            if ((await handle.describe()).status.name !== 'RUNNING') continue;
            const state = await handle.query(findingStateQuery);
            open.push({ workflowId: id, step: state.step ?? null, fixAttempts: state.fixAttempts ?? null });
          } catch (err) {
            if (!(err instanceof WorkflowNotFoundError)) throw err;
          }
        }
      }
      return open;
    },
    // Read by a finding run at its verdict and by the reconciler for a parked defect.
    readSiteAutoFix: async () => flags.autoFix,
    openFixIssue: async (input: { key: string }) => {
      fixIssues.push(input.key);
      throw ApplicationFailure.nonRetryable('the test opens no issue', 'FindingNotFixable');
    },
    readFinding: async () => {
      throw new Error('the reconciler never reads a finding file');
    },
    writeFindingVerdict: async (input: unknown) => {
      writes.push(input);
      return { findingCommitSha: null, indexCommitSha: null, commitSha: null };
    },
    reportRunHealth: async (input: { signal: string; shape: { ok: boolean; summary: string } }) => {
      pings.push({ signal: input.signal, ok: input.shape.ok, summary: input.shape.summary });
      return { signal: input.signal, ok: input.shape.ok, sent: true };
    },
  };
  return { indexes, activities, pings, writes, flags, fixIssues };
}

async function withWorker<T>(activities: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities,
    taskQueue: QUEUE,
    bundlerOptions: {},
  });
  return await worker.runUntil(fn());
}

let runs = 0;
function reconcileOnce() {
  runs++;
  return client.workflow.execute(reconcileFindingsWorkflow, {
    workflowId: `reconcile-test-${runs}`,
    taskQueue: QUEUE,
    args: [{ repo: 'mattpyle/argus' }],
  });
}

test('starts the missing, signals the decided, and does nothing on a second run', async () => {
  const s = store({
    'site-a': header([
      'a-one | proposed | Title | ',
      'a-two | proposed | Title | ',
      'a-old | resolved | Title | Done.',
    ]),
    'site-b': header(['b-one | proposed | Title | ']),
    'site-empty': '',
  });

  await withWorker(s.activities, async () => {
    const first = await reconcileOnce();
    assert.deepEqual(first, {
      'site-a': { started: 2, signalled: 0, fixed: 0, unchanged: 1 },
      'site-b': { started: 1, signalled: 0, fixed: 0, unchanged: 0 },
      'site-empty': { started: 0, signalled: 0, fixed: 0, unchanged: 0 },
    });
    const a1 = client.workflow.getHandle(findingWorkflowId('site-a', 'a-one'));
    assert.equal((await a1.query(findingStateQuery)).status, 'waiting');

    const second = await reconcileOnce();
    assert.deepEqual(second['site-a'], { started: 0, signalled: 0, fixed: 0, unchanged: 3 });
    assert.deepEqual(second['site-b'], { started: 0, signalled: 0, fixed: 0, unchanged: 1 });

    // Argus records a Discord verdict in the index; the next run carries it.
    s.indexes['site-a'] = header([
      'a-one | rejected | Title | By design, per Matt in Discord.',
      'a-two | proposed | Title | ',
      'a-old | resolved | Title | Done.',
    ]);
    const third = await reconcileOnce();
    assert.deepEqual(third['site-a'], { started: 0, signalled: 1, fixed: 0, unchanged: 2 });

    const result = (await a1.result()) as FindingWorkflowResult;
    assert.equal(result.verdict.status, 'rejected');
    assert.equal(result.verdict.source, 'file');
    assert.equal(result.verdict.reason, 'By design, per Matt in Discord.');
    assert.equal(result.commitSha, null);

    // The closed workflow is not reopened, and the decided line is not re-signalled.
    const fourth = await reconcileOnce();
    assert.deepEqual(fourth['site-a'], { started: 0, signalled: 0, fixed: 0, unchanged: 3 });
  });

  assert.equal(s.writes.length, 0, 'a file verdict never writes');
  assert.equal(s.pings.length, 4, 'every run pings');
  assert.ok(s.pings.every((p) => p.signal === 'findings-reconcile' && p.ok));
  assert.match(s.pings[0].summary, /site-a started 2, signalled 0, fixed 0, unchanged 1/);
});

test('a reopened line whose last run completed gets a new run, waiting at the verdict and named reopened in its memo', async () => {
  const s = store({ 'mattpyle-com': header(['r-one | proposed | Title | ']) });
  await withWorker(s.activities, async () => {
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 1, signalled: 0, fixed: 0, unchanged: 0 });
    const id = findingWorkflowId('mattpyle-com', 'r-one');
    const first = await client.workflow.getHandle(id).describe();
    assert.equal(first.memo?.indexStatus, 'proposed');

    // The first run ends; a later verify writes `reopened` into the index.
    s.indexes['mattpyle-com'] = header(['r-one | rejected | Title | Not now.']);
    await reconcileOnce();
    await client.workflow.getHandle(id, first.runId).result();
    s.indexes['mattpyle-com'] = header(['r-one | reopened | Title | ']);

    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 1, signalled: 0, fixed: 0, unchanged: 0 });
    const latest = client.workflow.getHandle(id);
    const described = await latest.describe();
    assert.equal(described.status.name, 'RUNNING');
    assert.notEqual(described.runId, first.runId, 'a new run under the same ID');
    assert.equal(described.memo?.indexStatus, 'reopened');
    const state = await latest.query(findingStateQuery);
    assert.equal(state.step, 'waiting-verdict');
    assert.equal(state.stopAfter, 'resolved');

    const history = await latest.fetchHistory();
    const payload = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
    const started = JSON.parse(Buffer.from(payload as Uint8Array).toString('utf8'));
    assert.ok(!('indexStatus' in started), 'the index status rides in the memo, not the workflow input');

    // Open now, so the next run leaves it.
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, unchanged: 1 });
    await latest.terminate('test over');
  });
});

/** Polls a finding run's state query until `done` holds, or fails after ten seconds. */
async function stateWhen(id: string, done: (state: FindingState) => boolean): Promise<FindingState> {
  const handle = client.workflow.getHandle(id);
  for (let i = 0; i < 100; i++) {
    const state = await handle.query(findingStateQuery);
    if (done(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${id} never reached the expected state`);
}

test('an approved defect parked at waiting-fix on an auto_fix site gets one fix; an opportunity gets none', async () => {
  const kinded = (lines: string[]) =>
    ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', ...lines].join('\n');
  const s = store({
    'mattpyle-com': kinded(['p-defect | proposed | defect | Title | ', 'p-opportunity | proposed | opportunity | Title | ']),
  });
  const defect = findingWorkflowId('mattpyle-com', 'p-defect');
  const opportunity = findingWorkflowId('mattpyle-com', 'p-opportunity');

  await withWorker(s.activities, async () => {
    await reconcileOnce();
    // Both approved while the site had no flag: each run reads false at its verdict and parks.
    s.indexes['mattpyle-com'] = kinded([
      'p-defect | approved | defect | Title | Yes.',
      'p-opportunity | approved | opportunity | Title | Yes.',
    ]);
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 2, fixed: 0, unchanged: 0 });
    for (const id of [defect, opportunity]) {
      const parked = await stateWhen(id, (st) => st.step === 'waiting-fix');
      assert.equal(parked.fixAttempts, 0);
    }

    // The flag is set later. The next pass sends `fix` to the defect only.
    s.flags.autoFix = true;
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 1, unchanged: 1 });
    const tried = await stateWhen(defect, (st) => st.fixAttempts === 1 && st.step === 'waiting-fix');
    assert.match(tried.lastFixError ?? '', /opens no issue/);
    assert.deepEqual(s.fixIssues, ['p-defect']);

    // One attempt made, so the next pass sends nothing: a retry is a person's.
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, unchanged: 2 });
    const left = await client.workflow.getHandle(opportunity).query(findingStateQuery);
    assert.equal(left.step, 'waiting-fix');
    assert.equal(left.fixAttempts, 0);
    assert.deepEqual(s.fixIssues, ['p-defect']);

    for (const id of [defect, opportunity]) await client.workflow.getHandle(id).terminate('test over');
  });
  assert.match(s.pings[2].summary, /mattpyle-com started 0, signalled 0, fixed 1, unchanged 1/);
});

test('a started opportunity carries waitsForPerson and parks unattempted on an auto_fix site; a defect does not and tries', async () => {
  const kinded = (lines: string[]) =>
    ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', ...lines].join('\n');
  const s = store({
    'mattpyle-com': kinded([
      'w-defect | proposed | defect | Title | ',
      'w-opportunity | proposed | opportunity | Title | ',
      'w-direction | proposed | direction | Title | ',
    ]),
  });
  s.flags.autoFix = true;
  const startedInput = async (key: string) => {
    const history = await client.workflow.getHandle(findingWorkflowId('mattpyle-com', key)).fetchHistory();
    const payload = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
    return JSON.parse(Buffer.from(payload as Uint8Array).toString('utf8'));
  };

  await withWorker(s.activities, async () => {
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 3, signalled: 0, fixed: 0, unchanged: 0 });
    assert.ok(!('waitsForPerson' in (await startedInput('w-defect'))), 'a defect starts without the field');
    assert.equal((await startedInput('w-opportunity')).waitsForPerson, true);
    assert.equal((await startedInput('w-direction')).waitsForPerson, true);

    s.indexes['mattpyle-com'] = kinded([
      'w-defect | approved | defect | Title | Yes.',
      'w-opportunity | approved | opportunity | Title | Yes.',
      'w-direction | approved | direction | Title | Yes.',
    ]);
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 3, fixed: 0, unchanged: 0 });

    const tried = await stateWhen(findingWorkflowId('mattpyle-com', 'w-defect'), (st) => st.fixAttempts === 1 && st.step === 'waiting-fix');
    assert.match(tried.lastFixError ?? '', /opens no issue/);
    for (const key of ['w-opportunity', 'w-direction']) {
      const parked = await stateWhen(findingWorkflowId('mattpyle-com', key), (st) => st.step === 'waiting-fix');
      assert.equal(parked.fixAttempts, 0);
      assert.equal(parked.lastFixError, null);
      assert.equal(parked.waitsForPerson, true);
    }
    assert.deepEqual(s.fixIssues, ['w-defect'], 'openFixIssue ran for the defect alone');

    for (const key of ['w-defect', 'w-opportunity', 'w-direction']) {
      await client.workflow.getHandle(findingWorkflowId('mattpyle-com', key)).terminate('test over');
    }
  });
});

test('a proposed line whose last run completed is not started again', async () => {
  const s = store({ 'site-f': header(['f-one | proposed | Title | ']) });
  await withWorker(s.activities, async () => {
    await reconcileOnce();
    s.indexes['site-f'] = header(['f-one | rejected | Title | No.']);
    await reconcileOnce();
    await client.workflow.getHandle(findingWorkflowId('site-f', 'f-one')).result();
    // A stale line: the index still says proposed after the run completed.
    s.indexes['site-f'] = header(['f-one | proposed | Title | ']);
    assert.deepEqual((await reconcileOnce())['site-f'], { started: 0, signalled: 0, fixed: 0, unchanged: 1 });
  });
});

test('a start that collides with a workflow visibility has not listed yet counts as unchanged', async () => {
  const s = store({ 'site-c': header(['c-one | proposed | Title | ']) });
  // Visibility lags: the list never shows anything open.
  s.activities.listOpenFindingWorkflows = async () => [];
  await withWorker(s.activities, async () => {
    assert.deepEqual((await reconcileOnce())['site-c'], { started: 1, signalled: 0, fixed: 0, unchanged: 0 });
    assert.deepEqual((await reconcileOnce())['site-c'], { started: 0, signalled: 0, fixed: 0, unchanged: 1 });
  });
});

test('a failed read fails the run and pings the check as failed', async () => {
  const s = store({ 'site-d': header([]) });
  s.activities.listSites = async () => {
    throw Object.assign(new Error('GitHub rejected the credential (401)'), { name: 'AuthError' });
  };
  await withWorker(s.activities, async () => {
    await assert.rejects(reconcileOnce());
  });
  assert.equal(s.pings.length, 1);
  assert.equal(s.pings[0].ok, false);
  assert.match(s.pings[0].summary, /401/);
});

test('a new finding of a known site starts at resolved, with its paths, branch and origin frozen in', async () => {
  const s = store({
    'mattpyle-com': header(['m-one | proposed | Title | ']),
    'site-e': header(['e-one | proposed | Title | ']),
  });
  await withWorker(s.activities, async () => {
    await reconcileOnce();
    const known = await client.workflow.getHandle(findingWorkflowId('mattpyle-com', 'm-one')).query(findingStateQuery);
    assert.equal(known.stopAfter, 'resolved');
    assert.equal(known.step, 'waiting-verdict');
    const unknown = await client.workflow.getHandle(findingWorkflowId('site-e', 'e-one')).query(findingStateQuery);
    assert.equal(unknown.stopAfter, 'verdict', 'a site with no production origin cannot verify, so it stops at the verdict');

    const history = await client.workflow.getHandle(findingWorkflowId('mattpyle-com', 'm-one')).fetchHistory();
    const payload = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
    const started = JSON.parse(Buffer.from(payload as Uint8Array).toString('utf8'));
    assert.deepEqual(
      { handoffPath: started.handoffPath, branch: started.branch, origin: started.origin },
      {
        handoffPath: 'sites/mattpyle-com/handoffs/m-one.md',
        branch: 'fix/finding-m-one',
        origin: 'https://www.mattpyle.com',
      },
    );
  });
});
