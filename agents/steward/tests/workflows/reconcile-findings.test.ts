import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Client, WorkflowNotFoundError, WorkflowUpdateFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT, settings, skipVerdictMeasure } from '../helpers/verdict-measure.js';
import {
  RECONCILE_START_ONLY_PATCH,
  reconcileFindingsWorkflow,
  reconcileNeedsAttention,
  summariseStartOnly,
} from '../../src/workflows/reconcile-findings.js';
import { findingStateQuery, verdictUpdate, type FindingState, type FindingWorkflowResult } from '../../src/workflows/finding.js';
import { startMissingFindingRuns } from '../../src/activities/findings.js';
import { findingWorkflowId, parseFindingsIndex, type FindingVerdict, type FindingsIndexLine } from '../../src/lib/findings.js';

/**
 * `reconcileFindingsWorkflow` on its one rule, against the real test server,
 * with the GitHub reads mocked. The batch activity is the real
 * `startMissingFindingRuns` over a mocked index, so the lookups and starts go
 * to the server and the finding workflows it starts are real executions.
 *
 * The rules the workflow had before (the verdict and `fix` signals, the
 * restart, the cancel) run only for a history recorded without the
 * `reconcile-start-only` marker. Their guard is the replay of
 * `reconcile-all-rules-pre.bin` and the three older fixtures in
 * `replay.test.ts`; `tests/lib/findings.test.ts` still holds `planReconcile`.
 *
 * **A plain client, not `env.client`.** The time-skipping client unlocks time
 * while it waits on a result, and the test server's default execution timeout is
 * ten years, so the first wait jumped the clock past it and every waiting finding
 * workflow read back `TIMED_OUT`. Nothing here needs time to move.
 *
 * **Histories.** A test that reads a history reads the reconcile run's, after
 * `execute` has returned its result: the run is closed, so every event it will
 * ever hold is there. No test reads the history of a run still open.
 */

const QUEUE = 'steward-findings';
const SITE = 'mattpyle-com';

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
  return ['# Findings index', '', 'Format: `key | status | kind | title | verdict reason`.', '', ...lines].join('\n');
}

function store(initial: Record<string, string>) {
  const indexes: Record<string, string> = { ...initial };
  const pings: Array<{ signal: string; ok: boolean; summary: string }> = [];
  const writes: unknown[] = [];
  const flags = { autoFix: false };
  /** Sites whose `config.yaml` says `stop_after: verdict`. A site other than mattpyle-com has no origin and stops too. */
  const stops = new Set<string>();
  /** Workflow IDs whose lookup throws, as a server error on one line would. */
  const broken = new Set<string>();
  const called: string[] = [];

  const failingClient = (): Client =>
    ({
      workflow: {
        getHandle: (id: string) => {
          if (broken.has(id)) {
            return {
              describe: async () => {
                throw new Error('the server refused the lookup');
              },
            };
          }
          return client.workflow.getHandle(id);
        },
        start: client.workflow.start.bind(client.workflow),
      },
    }) as unknown as Client;

  const activities = {
    listSites: async () => (called.push('listSites'), Object.keys(indexes).sort()),
    startMissingFindingRuns: (input: { repo: string; site: string }) => {
      called.push('startMissingFindingRuns');
      return startMissingFindingRuns(input, {
        readIndex: async (_repo: string, site: string): Promise<FindingsIndexLine[]> => {
          if (indexes[site] === 'UNREADABLE') throw Object.assign(new Error('GitHub rejected the credential (401)'), { name: 'AuthError' });
          return parseFindingsIndex(indexes[site] ?? '');
        },
        siteStops: async (_repo: string, site: string) => site !== SITE || stops.has(site),
        ...(broken.size > 0 ? { client: failingClient() } : {}),
      });
    },
    // Read by a finding run at its approved verdict and while it is parked. Only
    // mattpyle-com has a production origin, as on the worker.
    readFindingSettings: async (input: { site: string }) =>
      input.site !== SITE || stops.has(input.site) ? STOPS_AT_VERDICT : settings({ autoFix: flags.autoFix }),
    requestFixSlot: async () => ({ paths: [], dispatched: false }),
    openFixIssue: async () => {
      throw ApplicationFailure.nonRetryable('the test opens no issue', 'FindingNotFixable');
    },
    writeFindingVerdict: async (input: unknown) => {
      writes.push(input);
      return { findingCommitSha: null, indexCommitSha: null, commitSha: 'c1' };
    },
    reportRunHealth: async (input: { signal: string; shape: { ok: boolean; summary: string } }) => {
      pings.push({ signal: input.signal, ok: input.shape.ok, summary: input.shape.summary });
      return { signal: input.signal, ok: input.shape.ok, sent: true };
    },
  };
  return { indexes, activities, pings, writes, flags, stops, broken, called };
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

async function exists(id: string): Promise<boolean> {
  try {
    await client.workflow.getHandle(id).describe();
    return true;
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return false;
    throw err;
  }
}

const verdict = (status: FindingVerdict['status'], reason = 'Decided.'): FindingVerdict => ({
  status,
  reason,
  source: 'cli',
  at: '2026-11-22T09:00:00.000Z',
});

async function terminateAll(ids: string[]): Promise<void> {
  for (const id of ids) await client.workflow.getHandle(id).terminate('test over').catch(() => undefined);
}

test('starts a run for every proposed line on every site, and nothing on a second pass', async () => {
  const s = store({
    'site-a': header(['a-one | proposed | defect | Title | ', 'a-two | proposed | defect | Title | ', 'a-old | resolved | defect | Title | Done.']),
    'site-b': header(['b-one | proposed | defect | Title | ']),
    'site-empty': '',
  });
  await withWorker(s.activities, async () => {
    const first = await reconcileOnce();
    assert.deepEqual(first, {
      'site-a': { started: 2, running: 0, skipped: 0, unchanged: 1, startedKeys: ['a-one', 'a-two'], blocked: [], failed: [] },
      'site-b': { started: 1, running: 0, skipped: 0, unchanged: 0, startedKeys: ['b-one'], blocked: [], failed: [] },
      'site-empty': { started: 0, running: 0, skipped: 0, unchanged: 0, startedKeys: [], blocked: [], failed: [] },
    });
    assert.equal((await client.workflow.getHandle(findingWorkflowId('site-a', 'a-one')).query(findingStateQuery)).step, 'waiting-verdict');
    assert.equal(await exists(findingWorkflowId('site-a', 'a-old')), false, 'a resolved line gets no workflow');

    const second = await reconcileOnce();
    assert.deepEqual(second['site-a'], { started: 0, running: 2, skipped: 0, unchanged: 1, startedKeys: [], blocked: [], failed: [] });
    assert.deepEqual(second['site-b'], { started: 0, running: 1, skipped: 0, unchanged: 0, startedKeys: [], blocked: [], failed: [] });
    await terminateAll([findingWorkflowId('site-a', 'a-one'), findingWorkflowId('site-a', 'a-two'), findingWorkflowId('site-b', 'b-one')]);
  });
  assert.equal(s.pings.length, 2, 'every run pings');
  assert.ok(s.pings.every((p) => p.signal === 'findings-reconcile' && p.ok));
  assert.match(s.pings[0].summary, /site-a started 2 \(a-one, a-two\), running 0, skipped 0, blocked 0, failed 0, unchanged 1/);
  assert.match(s.pings[1].summary, /site-a started 0, running 2, skipped 0, blocked 0, failed 0, unchanged 1/);
});

test('the pass is one activity per site: its history lists no workflow and holds no query, signal or cancel', async () => {
  const s = store({
    [SITE]: header(['h-one | proposed | defect | Title | ', 'h-two | approved | defect | Title | Yes.']),
    'site-b': header(['h-three | proposed | defect | Title | ']),
  });
  await withWorker(s.activities, async () => {
    await reconcileOnce();
    // The run is closed: `execute` returned its result, so the history is whole.
    const history = await client.workflow.getHandle(`reconcile-test-${runs}`).fetchHistory();
    const events = history.events ?? [];
    const activityTypes = events.map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name).filter(Boolean);
    assert.deepEqual(activityTypes, ['listSites', 'startMissingFindingRuns', 'startMissingFindingRuns', 'reportRunHealth']);
    assert.ok(events.every((e) => !e.signalExternalWorkflowExecutionInitiatedEventAttributes), 'no signal');
    assert.ok(events.every((e) => !e.requestCancelExternalWorkflowExecutionInitiatedEventAttributes), 'no cancel');
    // A `patched` marker shows as the `TemporalChangeVersion` search attribute it upserts.
    const markers = events
      .map((e) => e.upsertWorkflowSearchAttributesEventAttributes?.searchAttributes?.indexedFields?.TemporalChangeVersion?.data)
      .filter(Boolean)
      .map((data) => Buffer.from(data as Uint8Array).toString('utf8'));
    assert.equal(markers.length, 1, 'one marker');
    assert.ok(markers[0].includes(RECONCILE_START_ONLY_PATCH));
    assert.ok(!markers[0].includes('reconcile-fix-any-kind'), 'none of the three earlier markers');
    await stateWhen(findingWorkflowId(SITE, 'h-two'), (st) => st.step === 'waiting-fix');
    await terminateAll([findingWorkflowId(SITE, 'h-one'), findingWorkflowId(SITE, 'h-two'), findingWorkflowId('site-b', 'h-three')]);
  });
  assert.deepEqual(s.called, ['listSites', 'startMissingFindingRuns', 'startMissingFindingRuns']);
});

test('a reopened line whose last run completed gets a new run, waiting at the verdict and named reopened in its memo', async () => {
  const s = store({ [SITE]: header(['r-one | proposed | defect | Title | ']) });
  const id = findingWorkflowId(SITE, 'r-one');
  await withWorker(s.activities, async () => {
    assert.deepEqual((await reconcileOnce())[SITE].startedKeys, ['r-one']);
    const first = await client.workflow.getHandle(id).describe();
    assert.equal(first.memo?.indexStatus, 'proposed');

    // The first run ends at a rejection; a later verify writes `reopened` into the index.
    await client.workflow.getHandle(id).executeUpdate(verdictUpdate, { args: [verdict('rejected', 'Not now.')] });
    await client.workflow.getHandle(id, first.runId).result();
    s.indexes[SITE] = header(['r-one | reopened | defect | Title | ']);

    assert.deepEqual((await reconcileOnce())[SITE].startedKeys, ['r-one']);
    const latest = client.workflow.getHandle(id);
    const described = await latest.describe();
    assert.equal(described.status.name, 'RUNNING');
    assert.notEqual(described.runId, first.runId, 'a new run under the same ID');
    assert.equal(described.memo?.indexStatus, 'reopened');
    const state = await latest.query(findingStateQuery);
    assert.equal(state.step, 'waiting-verdict');
    assert.equal(state.verdict, null, 'a reopened line carries no verdict: it is back at the gate');

    // Open now, so the next pass leaves it.
    assert.deepEqual((await reconcileOnce())[SITE], { started: 0, running: 1, skipped: 0, unchanged: 0, startedKeys: [], blocked: [], failed: [] });
    await latest.terminate('test over');
  });
});

test('an approved line with no run on a site that fixes gets a run carrying the file verdict: it does not wait, and writes nothing', async () => {
  const s = store({ [SITE]: header(['v-one | approved | opportunity | Title | Approved by Matt in Discord.']) });
  const id = findingWorkflowId(SITE, 'v-one');
  await withWorker(s.activities, async () => {
    assert.deepEqual((await reconcileOnce())[SITE], { started: 1, running: 0, skipped: 0, unchanged: 0, startedKeys: ['v-one'], blocked: [], failed: [] });
    const handle = client.workflow.getHandle(id);
    assert.equal((await handle.describe()).memo?.indexStatus, 'approved');

    // No signal and no Update is sent: the run passes its gate on its input and parks, with `auto_fix` off.
    const parked = await stateWhen(id, (st) => st.step === 'waiting-fix');
    assert.equal(parked.status, 'done');
    assert.equal(parked.verdict?.status, 'approved');
    assert.equal(parked.verdict?.source, 'file');
    assert.equal(parked.verdict?.reason, 'Approved by Matt in Discord.');
    assert.equal(parked.commitSha, null);
    assert.equal(parked.fixAttempts, 0);
    assert.equal(s.writes.length, 0, 'the verdict is already in the file');

    // The first verdict stands: the same status is answered with it, the other is refused.
    const again = await handle.executeUpdate(verdictUpdate, { args: [verdict('approved', 'Again.')] });
    assert.equal(again.first, false);
    assert.equal(again.verdict.source, 'file');
    assert.equal(again.verdict.reason, 'Approved by Matt in Discord.');
    await assert.rejects(
      handle.executeUpdate(verdictUpdate, { args: [verdict('rejected', 'Changed my mind.')] }),
      (err: unknown) => err instanceof WorkflowUpdateFailedError && /already recorded: approved \(source file\)/.test(String((err.cause as Error)?.message)),
    );
    assert.equal(s.writes.length, 0);

    // The run stays open behind its approved line, so the next pass starts nothing.
    assert.deepEqual((await reconcileOnce())[SITE], { started: 0, running: 1, skipped: 0, unchanged: 0, startedKeys: [], blocked: [], failed: [] });
    await handle.terminate('test over');
  });
});

test('an approved line on a site that stops at the verdict is skipped, by its config or for want of an origin', async () => {
  const s = store({
    [SITE]: header(['k-one | approved | defect | Title | Yes.', 'k-two | proposed | defect | Title | ']),
    'site-b': header(['k-three | approved | defect | Title | Yes.']),
  });
  s.stops.add(SITE);
  await withWorker(s.activities, async () => {
    const result = await reconcileOnce();
    assert.deepEqual(result[SITE], { started: 1, running: 0, skipped: 1, unchanged: 0, startedKeys: ['k-two'], blocked: [], failed: [] });
    assert.deepEqual(result['site-b'], { started: 0, running: 0, skipped: 1, unchanged: 0, startedKeys: [], blocked: [], failed: [] });
    assert.equal(await exists(findingWorkflowId(SITE, 'k-one')), false);
    assert.equal(await exists(findingWorkflowId('site-b', 'k-three')), false);
    // And again on the next pass: a skipped line is never started.
    assert.equal((await reconcileOnce())[SITE].skipped, 1);
    assert.equal(await exists(findingWorkflowId(SITE, 'k-one')), false);
    await terminateAll([findingWorkflowId(SITE, 'k-two')]);
  });
  assert.ok(s.pings.every((p) => p.ok), 'a skipped line is as designed');
});

test('a proposed line whose last run completed is blocked: no new run, the key named, and the ping failed', async () => {
  const s = store({ 'site-c': header(['c-one | proposed | defect | Title | ', 'c-two | proposed | defect | Title | ']) });
  const id = findingWorkflowId('site-c', 'c-one');
  await withWorker(s.activities, async () => {
    await reconcileOnce();
    const first = await client.workflow.getHandle(id).describe();
    // The run ends at its verdict, and the index line still says proposed.
    await client.workflow.getHandle(id).executeUpdate(verdictUpdate, { args: [verdict('approved')] });
    const result = (await client.workflow.getHandle(id, first.runId).result()) as FindingWorkflowResult;
    assert.equal(result.verdict.status, 'approved');

    const second = await reconcileOnce();
    assert.deepEqual(second['site-c'], { started: 0, running: 1, skipped: 0, unchanged: 0, startedKeys: [], blocked: ['c-one'], failed: [] });
    const described = await client.workflow.getHandle(id).describe();
    assert.equal(described.runId, first.runId, 'the completed run is not started again');
    assert.equal(described.status.name, 'COMPLETED');
    await terminateAll([findingWorkflowId('site-c', 'c-two')]);
  });
  assert.equal(s.pings[0].ok, true);
  assert.equal(s.pings[1].ok, false, 'a finding with no workflow is not silent');
  assert.match(s.pings[1].summary, /site-c started 0, running 1, skipped 0, blocked 1 \(c-one\), failed 0/);
  assert.match(s.pings[1].summary, /A blocked line has no running workflow/);
});

test('a line whose lookup fails is reported with its reason, the other lines are still started, and the ping fails', async () => {
  const s = store({ 'site-f': header(['f-bad | proposed | defect | Title | ', 'f-good | proposed | defect | Title | ']) });
  s.broken.add(findingWorkflowId('site-f', 'f-bad'));
  await withWorker(s.activities, async () => {
    const result = await reconcileOnce();
    assert.deepEqual(result['site-f'], {
      started: 1,
      running: 0,
      skipped: 0,
      unchanged: 0,
      startedKeys: ['f-good'],
      blocked: [],
      failed: [{ key: 'f-bad', error: 'the server refused the lookup' }],
    });
    assert.equal(await exists(findingWorkflowId('site-f', 'f-good')), true);

    // The fault clears, and the next pass starts the line it could not check.
    s.broken.clear();
    assert.deepEqual((await reconcileOnce())['site-f'].startedKeys, ['f-bad']);
    await terminateAll([findingWorkflowId('site-f', 'f-bad'), findingWorkflowId('site-f', 'f-good')]);
  });
  assert.equal(s.pings[0].ok, false);
  assert.match(s.pings[0].summary, /failed 1 \(f-bad: the server refused the lookup\)/);
  assert.equal(s.pings[1].ok, true, 'the next good pass clears the check');
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
  assert.match(s.pings[0].summary, /may have no workflow until the next one/);
});

test('a new finding of a known site starts at resolved, with its paths, branch and origin frozen in', async () => {
  const s = store({
    [SITE]: header(['m-one | proposed | defect | Title | ']),
    'site-e': header(['e-one | proposed | defect | Title | ']),
  });
  await withWorker(s.activities, async () => {
    await reconcileOnce();
    const known = await client.workflow.getHandle(findingWorkflowId(SITE, 'm-one')).query(findingStateQuery);
    assert.equal(known.stopAfter, 'resolved');
    assert.equal(known.step, 'waiting-verdict');
    const unknown = await client.workflow.getHandle(findingWorkflowId('site-e', 'e-one')).query(findingStateQuery);
    assert.equal(unknown.stopAfter, 'verdict', 'a site with no production origin cannot verify, so it stops at the verdict');

    // The first event of a history is there as soon as the run exists.
    const history = await client.workflow.getHandle(findingWorkflowId(SITE, 'm-one')).fetchHistory();
    const payload = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
    const started = JSON.parse(Buffer.from(payload as Uint8Array).toString('utf8'));
    assert.deepEqual(
      { handoffPath: started.handoffPath, branch: started.branch, origin: started.origin },
      { handoffPath: `sites/${SITE}/handoffs/m-one.md`, branch: 'fix/finding-m-one', origin: 'https://www.mattpyle.com' },
    );
    assert.ok(!('verdict' in started), 'a proposed line carries no verdict');
    assert.ok(!('indexStatus' in started), 'the index status rides in the memo, not the workflow input');
    await terminateAll([findingWorkflowId(SITE, 'm-one'), findingWorkflowId('site-e', 'e-one')]);
  });
});

test('the summary names at most ten keys per list and says what a person does about a blocked line', () => {
  const keys = Array.from({ length: 12 }, (_, i) => `key-${i + 1}`);
  const quiet = { 'site-a': { started: 12, running: 3, skipped: 1, unchanged: 4, startedKeys: keys, blocked: [], failed: [] } };
  assert.equal(reconcileNeedsAttention(quiet), false);
  assert.equal(
    summariseStartOnly(quiet),
    `Findings reconcile: site-a started 12 (${keys.slice(0, 10).join(', ')}, and 2 more), running 3, skipped 1, blocked 0, failed 0, unchanged 4.`,
  );
  const loud = { 'site-a': { started: 0, running: 0, skipped: 0, unchanged: 0, startedKeys: [], blocked: ['b-one'], failed: [{ key: 'f-one', error: 'boom' }] } };
  assert.equal(reconcileNeedsAttention(loud), true);
  assert.match(summariseStartOnly(loud), /blocked 1 \(b-one\), failed 1 \(f-one: boom\), unchanged 0\. A blocked line/);
  assert.equal(summariseStartOnly({}), 'Findings reconcile: no site folders.');
  // A result recorded before the rule holds none of its fields.
  assert.equal(reconcileNeedsAttention({ 'site-a': { started: 1, signalled: 0, fixed: 0, unchanged: 2 } }), false);
});
