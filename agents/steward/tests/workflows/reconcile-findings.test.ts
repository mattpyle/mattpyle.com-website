import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { skipVerdictMeasure } from '../helpers/verdict-measure.js';
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
  // The keys the gate accepts, and the keys whose attempt opens an issue.
  const fixable = new Set<string>();
  const opens = new Set<string>();

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
            open.push({ workflowId: id, step: state.step ?? null, fixAttempts: state.fixAttempts ?? null, issueUrl: state.issueUrl ?? null });
          } catch (err) {
            if (!(err instanceof WorkflowNotFoundError)) throw err;
          }
        }
      }
      return open;
    },
    // Read by a finding run at its verdict and by the reconciler for a parked line.
    readSiteAutoFix: async () => flags.autoFix,
    requestFixSlot: async () => ({ paths: [], dispatched: false }),
    listFixableFindings: async (input: { keys: string[] }) => input.keys.filter((key) => fixable.has(key)),
    openFixIssue: async (input: { key: string }) => {
      fixIssues.push(input.key);
      if (opens.has(input.key)) return { repo: 'o/r', number: 1, url: 'https://github.com/o/r/issues/1', reused: false };
      throw ApplicationFailure.nonRetryable('the test opens no issue', 'FindingNotFixable');
    },
    // An issue with no PR: the attempt fails back to waiting-fix with its issue kept.
    awaitFixPr: async () => {
      throw ApplicationFailure.nonRetryable('the test sees no PR', 'NoPr');
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
  return { indexes, activities, pings, writes, flags, fixIssues, fixable, opens };
}

async function withWorker<T>(activities: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: skipVerdictMeasure(activities),
    taskQueue: QUEUE,
  });
  return await worker.runUntil(bounded(fn()));
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
      'site-a': { started: 2, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 },
      'site-b': { started: 1, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 0 },
      'site-empty': { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 0 },
    });
    const a1 = client.workflow.getHandle(findingWorkflowId('site-a', 'a-one'));
    assert.equal((await a1.query(findingStateQuery)).status, 'waiting');

    const second = await reconcileOnce();
    assert.deepEqual(second['site-a'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 3 });
    assert.deepEqual(second['site-b'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });

    // Argus records a Discord verdict in the index; the next run carries it.
    s.indexes['site-a'] = header([
      'a-one | rejected | Title | By design, per Matt in Discord.',
      'a-two | proposed | Title | ',
      'a-old | resolved | Title | Done.',
    ]);
    const third = await reconcileOnce();
    assert.deepEqual(third['site-a'], { started: 0, signalled: 1, fixed: 0, restarted: 0, closed: 0, unchanged: 2 });

    const result = (await a1.result()) as FindingWorkflowResult;
    assert.equal(result.verdict.status, 'rejected');
    assert.equal(result.verdict.source, 'file');
    assert.equal(result.verdict.reason, 'By design, per Matt in Discord.');
    assert.equal(result.commitSha, null);

    // The closed workflow is not reopened, and the decided line is not re-signalled.
    const fourth = await reconcileOnce();
    assert.deepEqual(fourth['site-a'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 3 });
  });

  assert.equal(s.writes.length, 0, 'a file verdict never writes');
  assert.equal(s.pings.length, 4, 'every run pings');
  assert.ok(s.pings.every((p) => p.signal === 'findings-reconcile' && p.ok));
  assert.match(s.pings[0].summary, /site-a started 2, signalled 0, fixed 0, restarted 0, closed 0, unchanged 1/);
});

test('a reopened line whose last run completed gets a new run, waiting at the verdict and named reopened in its memo', async () => {
  const s = store({ 'mattpyle-com': header(['r-one | proposed | Title | ']) });
  await withWorker(s.activities, async () => {
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 1, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 0 });
    const id = findingWorkflowId('mattpyle-com', 'r-one');
    const first = await client.workflow.getHandle(id).describe();
    assert.equal(first.memo?.indexStatus, 'proposed');

    // The first run ends; a later verify writes `reopened` into the index.
    s.indexes['mattpyle-com'] = header(['r-one | rejected | Title | Not now.']);
    await reconcileOnce();
    await client.workflow.getHandle(id, first.runId).result();
    s.indexes['mattpyle-com'] = header(['r-one | reopened | Title | ']);

    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 1, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 0 });
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
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });
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

test('an approved parked line of any kind gets one fix when the gate accepts it; a run with an issue, or a refused file, gets none', async () => {
  const kinded = (lines: string[]) =>
    ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', ...lines].join('\n');
  const kindOf: Record<string, string> = {
    'p-defect': 'defect',
    'p-opportunity': 'opportunity',
    'p-refused': 'opportunity',
    'p-direction': 'direction',
  };
  const keys = Object.keys(kindOf);
  const lines = (status: string) => keys.map((key) => `${key} | ${status} | ${kindOf[key]} | Title | ${status === 'approved' ? 'Yes.' : ''}`);
  const s = store({ 'mattpyle-com': kinded(lines('proposed')) });
  const id = (key: string) => findingWorkflowId('mattpyle-com', key);
  s.opens.add('p-defect');
  s.opens.add('p-opportunity');

  await withWorker(s.activities, async () => {
    await reconcileOnce();
    // All approved while the site had no flag: each run reads false at its verdict and parks.
    s.indexes['mattpyle-com'] = kinded(lines('approved'));
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 4, fixed: 0, restarted: 0, closed: 0, unchanged: 0 });
    for (const key of keys) {
      const parked = await stateWhen(id(key), (st) => st.step === 'waiting-fix');
      assert.equal(parked.fixAttempts, 0);
    }

    // The flag is set later, and the gate accepts the defect and the opportunity. The others wait.
    s.flags.autoFix = true;
    s.fixable.add('p-defect');
    s.fixable.add('p-opportunity');
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 2, restarted: 0, closed: 0, unchanged: 2 });
    for (const key of ['p-defect', 'p-opportunity']) {
      const tried = await stateWhen(id(key), (st) => st.fixAttempts === 1 && st.step === 'waiting-fix' && Boolean(st.lastFixError));
      assert.equal(tried.issueUrl, 'https://github.com/o/r/issues/1');
    }
    assert.deepEqual([...s.fixIssues].sort(), ['p-defect', 'p-opportunity']);

    // Each opened an issue, so the next pass sends nothing: a failed Action is a person's retry.
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 4 });
    for (const key of ['p-refused', 'p-direction']) {
      const left = await client.workflow.getHandle(id(key)).query(findingStateQuery);
      assert.equal(left.step, 'waiting-fix');
      assert.equal(left.fixAttempts, 0, 'the gate runs before the send, so a refused finding is never signalled');
    }
    assert.deepEqual([...s.fixIssues].sort(), ['p-defect', 'p-opportunity']);

    // The refused finding is edited and now passes the gate: the next pass sends it, once.
    s.fixable.add('p-refused');
    s.opens.add('p-refused');
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 1, restarted: 0, closed: 0, unchanged: 3 });
    await stateWhen(id('p-refused'), (st) => st.fixAttempts === 1 && st.step === 'waiting-fix' && Boolean(st.issueUrl));
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 4 });

    for (const key of keys) await client.workflow.getHandle(id(key)).terminate('test over');
  });
  assert.match(s.pings[2].summary, /mattpyle-com started 0, signalled 0, fixed 2, restarted 0, closed 0, unchanged 2/);
});

test('a gate refusal at the attempt parks the run with lastFixError, and the reconciler retries it once the gate accepts', async () => {
  const kinded = (lines: string[]) =>
    ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', ...lines].join('\n');
  const s = store({ 'mattpyle-com': kinded(['g-opportunity | proposed | opportunity | Title | ']) });
  s.flags.autoFix = true;
  const id = findingWorkflowId('mattpyle-com', 'g-opportunity');

  await withWorker(s.activities, async () => {
    await reconcileOnce();
    s.indexes['mattpyle-com'] = kinded(['g-opportunity | approved | opportunity | Title | Yes.']);
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 1, fixed: 0, restarted: 0, closed: 0, unchanged: 0 });

    // The attempt at the verdict reaches the gate, which refuses it: parked, with the reason.
    const refused = await stateWhen(id, (st) => st.fixAttempts === 1 && st.step === 'waiting-fix');
    assert.match(refused.lastFixError ?? '', /opens no issue/);
    assert.equal(refused.issueUrl, null);
    assert.deepEqual(s.fixIssues, ['g-opportunity']);

    // The gate still refuses, so nothing is sent. Once it accepts, one fix goes.
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });
    s.fixable.add('g-opportunity');
    s.opens.add('g-opportunity');
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 1, restarted: 0, closed: 0, unchanged: 0 });
    const opened = await stateWhen(id, (st) => st.fixAttempts === 2 && st.step === 'waiting-fix' && Boolean(st.issueUrl));
    assert.equal(opened.issueUrl, 'https://github.com/o/r/issues/1');
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });

    await client.workflow.getHandle(id).terminate('test over');
  });
});

test('an opportunity attempts the fix at its verdict with no signal; a direction still waits for a person', async () => {
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
  s.opens.add('w-opportunity');
  const startedInput = async (key: string) => {
    const history = await client.workflow.getHandle(findingWorkflowId('mattpyle-com', key)).fetchHistory();
    const payload = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
    return JSON.parse(Buffer.from(payload as Uint8Array).toString('utf8'));
  };

  await withWorker(s.activities, async () => {
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 3, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 0 });
    assert.ok(!('waitsForPerson' in (await startedInput('w-defect'))), 'a defect starts without the field');
    assert.ok(!('waitsForPerson' in (await startedInput('w-opportunity'))), 'an opportunity attempts at the verdict');
    assert.equal((await startedInput('w-direction')).waitsForPerson, true);

    s.indexes['mattpyle-com'] = kinded([
      'w-defect | approved | defect | Title | Yes.',
      'w-opportunity | approved | opportunity | Title | Yes.',
      'w-direction | approved | direction | Title | Yes.',
    ]);
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 3, fixed: 0, restarted: 0, closed: 0, unchanged: 0 });

    const tried = await stateWhen(findingWorkflowId('mattpyle-com', 'w-defect'), (st) => st.fixAttempts === 1 && st.step === 'waiting-fix');
    assert.match(tried.lastFixError ?? '', /opens no issue/);
    const opened = await stateWhen(
      findingWorkflowId('mattpyle-com', 'w-opportunity'),
      (st) => st.fixAttempts === 1 && st.step === 'waiting-fix' && Boolean(st.issueUrl),
    );
    assert.equal(opened.issueUrl, 'https://github.com/o/r/issues/1', 'the opportunity opened its issue at the verdict');
    const parked = await stateWhen(findingWorkflowId('mattpyle-com', 'w-direction'), (st) => st.step === 'waiting-fix');
    assert.equal(parked.fixAttempts, 0);
    assert.equal(parked.lastFixError, null);
    assert.equal(parked.waitsForPerson, true);
    assert.deepEqual([...s.fixIssues].sort(), ['w-defect', 'w-opportunity'], 'openFixIssue ran for the defect and the opportunity, not the direction');

    for (const key of ['w-defect', 'w-opportunity', 'w-direction']) {
      await client.workflow.getHandle(findingWorkflowId('mattpyle-com', key)).terminate('test over');
    }
  });
});

test('a resolved or rejected line whose run waits at waiting-fix gets the run cancelled once; an approved parked run is left', async () => {
  const kinded = (lines: string[]) =>
    ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', ...lines].join('\n');
  const keys = ['k-resolved', 'k-rejected', 'k-approved'];
  const lines = (statuses: string[]) => keys.map((key, i) => `${key} | ${statuses[i]} | direction | Title | Yes.`);
  const s = store({ 'mattpyle-com': kinded(lines(['proposed', 'proposed', 'proposed'])) });
  const id = (key: string) => findingWorkflowId('mattpyle-com', key);

  await withWorker(s.activities, async () => {
    await reconcileOnce();
    // A direction parks at waiting-fix without an attempt, so each run waits there.
    s.indexes['mattpyle-com'] = kinded(lines(['approved', 'approved', 'approved']));
    await reconcileOnce();
    for (const key of keys) await stateWhen(id(key), (st) => st.step === 'waiting-fix');

    // Verify and a later verdict decide the files from outside the fixer's path.
    s.indexes['mattpyle-com'] = kinded(lines(['resolved', 'rejected', 'approved']));
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 2, unchanged: 1 });
    for (const key of ['k-resolved', 'k-rejected']) {
      const handle = client.workflow.getHandle(id(key));
      for (let i = 0; i < 100 && (await handle.describe()).status.name === 'RUNNING'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await handle.describe()).status.name, 'CANCELLED', `${key} ended through a cancel`);
    }
    const parked = client.workflow.getHandle(id('k-approved'));
    assert.equal((await parked.describe()).status.name, 'RUNNING');
    assert.equal((await parked.query(findingStateQuery)).step, 'waiting-fix');

    // The closed runs are gone from the list, so the next pass counts the decided lines unchanged.
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 3 });
    await parked.terminate('test over');
  });
  assert.match(s.pings[2].summary, /mattpyle-com started 0, signalled 0, fixed 0, restarted 0, closed 2, unchanged 1/);
});

/**
 * A run that stopped at the verdict and completed, as the 2026-10-13 approvals
 * did: started with `stopAfter: 'verdict'`, then given the verdict by the file.
 */
async function completedAtVerdict(site: string, key: string): Promise<void> {
  const id = findingWorkflowId(site, key);
  const handle = await client.workflow.start('findingWorkflow', {
    workflowId: id,
    taskQueue: QUEUE,
    args: [{ site, key, repo: 'mattpyle/argus', findingPath: `sites/${site}/findings/${key}.md`, indexPath: `sites/${site}/findings/INDEX.md`, stopAfter: 'verdict' }],
  });
  await handle.signal('verdict', { status: 'approved', reason: 'Yes.', source: 'file', at: new Date().toISOString() });
  await handle.result();
}

async function startedInput(id: string) {
  const history = await client.workflow.getHandle(id).fetchHistory();
  const payload = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
  return JSON.parse(Buffer.from(payload as Uint8Array).toString('utf8'));
}

test('an approved line with no open run gets one run carrying the file verdict; a refused file, a fixing line and a site without auto_fix get none', async () => {
  const kinded = (lines: string[]) =>
    ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', ...lines].join('\n');
  const lines = [
    's-ok | approved | opportunity | Title | The lede reads wrong.',
    's-defect | approved | defect | Title | Yes.',
    's-refused | approved | opportunity | Title | Yes.',
    's-fixing | fixing | defect | Title | Yes.',
  ];
  const s = store({ 'mattpyle-com': kinded(lines), 'site-off': kinded(['o-ok | approved | opportunity | Title | Yes.']) });
  s.flags.autoFix = true;
  s.opens.add('s-ok');
  s.opens.add('s-defect');
  s.fixable.add('s-ok');
  s.fixable.add('s-defect');
  s.fixable.add('s-fixing');
  s.fixable.add('o-ok');
  // `site-off` reads its own flag through the mock below.
  s.activities.readSiteAutoFix = async (input?: { site?: string }) => (input?.site === 'site-off' ? false : s.flags.autoFix);

  await withWorker(s.activities, async () => {
    for (const key of ['s-ok', 's-defect', 's-refused', 's-fixing']) await completedAtVerdict('mattpyle-com', key);
    await completedAtVerdict('site-off', 'o-ok');

    const first = await reconcileOnce();
    assert.deepEqual(first['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 2, closed: 0, unchanged: 2 });
    assert.deepEqual(first['site-off'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });

    const id = findingWorkflowId('mattpyle-com', 's-ok');
    const input = await startedInput(id);
    assert.equal(input.stopAfter, 'resolved');
    assert.ok(!('waitsForPerson' in input), 'the restart attempts at the verdict');
    assert.equal((await client.workflow.getHandle(id).describe()).memo?.indexStatus, 'approved');

    // The run took the file's verdict, wrote nothing, and attempted the fix on its own.
    const opened = await stateWhen(id, (st) => st.fixAttempts === 1 && st.step === 'waiting-fix' && Boolean(st.issueUrl));
    assert.equal(opened.verdict?.status, 'approved');
    assert.equal(opened.verdict?.source, 'file');
    assert.equal(opened.verdict?.reason, 'The lede reads wrong.');
    assert.equal(s.writes.length, 0);
    await stateWhen(findingWorkflowId('mattpyle-com', 's-defect'), (st) => st.fixAttempts === 1 && Boolean(st.issueUrl));
    assert.deepEqual([...s.fixIssues].sort(), ['s-defect', 's-ok']);

    // Both runs are open now, so the next pass leaves them; the refused line is still refused.
    const second = await reconcileOnce();
    assert.deepEqual(second['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 4 });
    assert.deepEqual(second['site-off'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });

    // The refused file is edited and passes: the next pass restarts it.
    s.fixable.add('s-refused');
    s.opens.add('s-refused');
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 1, closed: 0, unchanged: 3 });

    for (const key of ['s-ok', 's-defect', 's-refused']) await client.workflow.getHandle(findingWorkflowId('mattpyle-com', key)).terminate('test over');
  });
  assert.match(s.pings[0].summary, /mattpyle-com started 0, signalled 0, fixed 0, restarted 2, closed 0, unchanged 2/);
});

test('a restart that finds the ID already taken counts as unchanged and sends no signal', async () => {
  const s = store({
    'mattpyle-com': ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', 'v-one | approved | opportunity | Title | Yes.'].join('\n'),
  });
  s.flags.autoFix = true;
  s.fixable.add('v-one');
  // Visibility lags: the list never shows the run that is open.
  s.activities.listOpenFindingWorkflows = async () => [];
  await withWorker(s.activities, async () => {
    await client.workflow.start('findingWorkflow', {
      workflowId: findingWorkflowId('mattpyle-com', 'v-one'),
      taskQueue: QUEUE,
      args: [{ site: 'mattpyle-com', key: 'v-one', repo: 'mattpyle/argus', findingPath: 'f', indexPath: 'i', stopAfter: 'verdict' }],
    });
    assert.deepEqual((await reconcileOnce())['mattpyle-com'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });
    const state = await client.workflow.getHandle(findingWorkflowId('mattpyle-com', 'v-one')).query(findingStateQuery);
    assert.equal(state.verdict, null, 'the open run was sent nothing');
    await client.workflow.getHandle(findingWorkflowId('mattpyle-com', 'v-one')).terminate('test over');
  });
});

test('a site with no production origin is not restarted', async () => {
  const s = store({
    'site-x': ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', 'x-one | approved | opportunity | Title | Yes.'].join('\n'),
  });
  s.flags.autoFix = true;
  s.fixable.add('x-one');
  await withWorker(s.activities, async () => {
    await completedAtVerdict('site-x', 'x-one');
    // A run that would stop at the verdict would end at once and be restarted every hour.
    assert.deepEqual((await reconcileOnce())['site-x'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });
    assert.deepEqual((await reconcileOnce())['site-x'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });
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
    assert.deepEqual((await reconcileOnce())['site-f'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });
  });
});

test('a start that collides with a workflow visibility has not listed yet counts as unchanged', async () => {
  const s = store({ 'site-c': header(['c-one | proposed | Title | ']) });
  // Visibility lags: the list never shows anything open.
  s.activities.listOpenFindingWorkflows = async () => [];
  await withWorker(s.activities, async () => {
    assert.deepEqual((await reconcileOnce())['site-c'], { started: 1, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 0 });
    assert.deepEqual((await reconcileOnce())['site-c'], { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 1 });
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

test('the health summary states how many runs were listed, how many were queried and how many indexes were read', async () => {
  const s = store({ 'site-a': header(['a-one | proposed | Title | ', 'a-two | resolved | Title | Done.']) });
  // The pruned listing the real activity returns: two runs, one of them skipped.
  s.activities.listOpenFindingWorkflows = (async (): Promise<unknown> => ({
    runs: [
      { workflowId: findingWorkflowId('site-a', 'a-one'), step: null, fixAttempts: null, issueUrl: null, queried: false },
      { workflowId: findingWorkflowId('site-a', 'a-two'), step: 'waiting-verdict', fixAttempts: 0, issueUrl: null },
    ],
    queried: 1,
    indexReads: 1,
  })) as never;
  await withWorker(s.activities, async () => {
    const result = await reconcileOnce();
    // The run for a-one exists, so nothing is started, and the result keeps its per-site shape.
    assert.deepEqual(result, { 'site-a': { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: 2 } });
  });
  assert.match(s.pings[0].summary, /Listed 2 open runs, queried 1, read 1 indexes to decide\./);
});

test('a verdict that reaches a run past its verdict is dropped and the first one stands', async () => {
  // The pruned listing can hand a run a verdict it is past (the index changed between
  // the activity's read and the workflow's). `findingWorkflow` must drop it.
  const kinded = (status: string) =>
    ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', `k-late | ${status} | direction | Title | Yes.`].join('\n');
  const s = store({ 'mattpyle-com': kinded('proposed') });
  const id = findingWorkflowId('mattpyle-com', 'k-late');
  await withWorker(s.activities, async () => {
    await reconcileOnce();
    s.indexes['mattpyle-com'] = kinded('approved');
    await reconcileOnce();
    await stateWhen(id, (st) => st.step === 'waiting-fix');
    const handle = client.workflow.getHandle(id);
    await handle.signal('verdict', { status: 'rejected', reason: 'Late.', source: 'file', at: new Date().toISOString() });
    // A query after the signal sees the handler's effect: the workflow task that ran it ran first.
    const state = await handle.query(findingStateQuery);
    assert.equal(state.verdict?.status, 'approved');
    assert.equal(state.step, 'waiting-fix');
    assert.equal((await handle.describe()).status.name, 'RUNNING');
    await handle.terminate('test over');
  });
});
