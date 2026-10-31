import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { bounded, createTestEnv, untilBetweenAttempts } from '../helpers/test-env.js';
import {
  findingStateQuery,
  findingWorkflow,
  fixSignal,
  verdictSignal,
  type FindingState,
  type FindingWorkflowInput,
  type FindingWorkflowResult,
} from '../../src/workflows/finding.js';
import { dispatchStateQuery } from '../../src/workflows/fix-dispatch.js';
import {
  awaitFixPrMerge,
  closeConflictingFixPr,
  runningWorkflowIds,
  sendSlotRequest,
  type AwaitFixPrInput,
  type FixIssue,
  type FixPrOutcome,
  type OpenFixIssueInput,
  type RequestFixSlotInput,
} from '../../src/activities/findings.js';
import { dispatchWorkflowId, slotBlocker, type DispatchState } from '../../src/lib/fix-dispatch.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import type { FindingVerdict } from '../../src/lib/findings.js';
import { FIXING_FINDING, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * Fix dispatch by surface on the time-skipping server: real `findingWorkflow`
 * runs and the real `fixDispatchWorkflow` on one `steward-findings` worker, as
 * on the hosted container. The slot request is the real signal-with-start
 * through the worker's client, with the paths each test chooses per key in
 * place of a finding file. GitHub is mocked per test; the conflict test runs
 * the real merge wait and close against a scripted GitHub.
 *
 * Each test uses its own site, so each has its own dispatcher.
 *
 * **Each test has its own test server**, started in `beforeEach`. A shared
 * one let a test stall a later one. When a time-skipping `result()` returns,
 * the run's last workflow task completes and the server's time lock touches
 * zero before the client locks again. In that instant the server skips to the
 * next timer anywhere on it, such as an earlier test's idle dispatcher reaching
 * its 24-hour close. That timer schedules a workflow task just as the test's
 * worker shuts down; the task is never started, and the server keeps a time
 * lock for it from then on, so every later wait on time skipping stalls. On
 * CI on 2026-10-30 that was the sweep test, behind tests 1 and 3. A fresh
 * server per test has no earlier runs to fire, and a task lost at a test's end
 * goes with that test's server.
 *
 * For the same reason each test awaits at most one result through the
 * time-skipping client: the gap after a first await could strand a task the
 * second await then waits on.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const FINDINGS = 'steward-findings';
const SITE_REPO = 'mattpyle/mattpyle.com-website';

let env: TestWorkflowEnvironment;
// A plain client for queries while runs idle: the time-skipping one skips time
// while it awaits a result, which is wanted only where a test awaits one.
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'cli', at: '2026-10-30T18:00:00Z' };
const FIX = { source: 'cli' as const, at: '2026-10-30T18:05:00Z' };

interface Script {
  /** The repository paths each key's cause names. */
  paths: Record<string, string[]>;
  /** How many PR polls answer "not yet" before an issue's PR opens. Default 0. */
  prPolls?: number;
  /** Per PR number: how many merge polls answer "still open" before it merges. Default 0. */
  openPolls?: Record<number, number>;
  /** Use the real merge wait and close, against whatever fetch the test installed. */
  realMerge?: boolean;
}

/**
 * The activities. Issues are numbered from 101 in the order they open, and
 * issue n's PR is n + 300. `log` holds `issue:<key>`, `pr:<key>` and
 * `live:<key>` in the order they happened.
 */
function mocks(script: Script) {
  const log: string[] = [];
  const issues: (OpenFixIssueInput & { number: number })[] = [];
  const keyOfIssue = new Map<number, string>();
  const keyOfPr = new Map<number, string>();
  const mergePolls: Record<number, number> = {};
  const prPolls: Record<number, number> = {};

  const activities = {
    readSiteAutoFix: async () => false,
    writeFindingVerdict: async () => ({ findingCommitSha: null, indexCommitSha: null, commitSha: null }),
    writeFindingFix: async () => ({ findingCommitSha: null, indexCommitSha: null, commitSha: null }),
    writeFindingReturned: async () => ({ findingCommitSha: null, indexCommitSha: null, commitSha: null }),
    requestFixSlot: async (input: RequestFixSlotInput) => {
      const paths = script.paths[input.key] ?? [];
      if (paths.length === 0) return { paths, dispatched: false };
      await sendSlotRequest(Context.current().client, input.site, {
        workflowId: input.workflowId,
        key: input.key,
        paths,
        ticket: input.ticket,
        at: input.at,
      });
      return { paths, dispatched: true };
    },
    runningWorkflowIds,
    openFixIssue: async (input: OpenFixIssueInput): Promise<FixIssue> => {
      const number = 101 + issues.length;
      issues.push({ ...input, number });
      keyOfIssue.set(number, input.key);
      log.push(`issue:${input.key}`);
      return { repo: SITE_REPO, number, url: `https://github.com/${SITE_REPO}/issues/${number}`, reused: false };
    },
    awaitFixPr: async (input: AwaitFixPrInput) => {
      const n = (prPolls[input.issueNumber] = (prPolls[input.issueNumber] ?? 0) + 1);
      if (n <= (script.prPolls ?? 0)) throw ApplicationFailure.retryable('No PR yet.', 'FixPrNotOpen');
      const number = input.issueNumber + 300;
      const key = keyOfIssue.get(input.issueNumber) as string;
      keyOfPr.set(number, key);
      log.push(`pr:${key}`);
      return { prUrl: `https://github.com/${SITE_REPO}/pull/${number}`, branch: `claude/issue-${input.issueNumber}-x` };
    },
    awaitFixPrMerge: script.realMerge
      ? awaitFixPrMerge
      : async (prUrl: string): Promise<FixPrOutcome> => {
          const number = Number(prUrl.split('/').pop());
          const n = (mergePolls[number] = (mergePolls[number] ?? 0) + 1);
          if (n <= (script.openPolls?.[number] ?? 0)) throw ApplicationFailure.retryable(`${prUrl} is still open.`, 'PrStillOpen');
          return { prUrl, state: 'merged', mergeSha: `m${number}`, at: '2026-10-30T20:00:00Z' };
        },
    closeConflictingFixPr,
    awaitProductionDeploy: async (input: { mergeSha: string }) => {
      const key = keyOfPr.get(Number(input.mergeSha.slice(1))) as string;
      log.push(`live:${key}`);
      return { liveSha: input.mergeSha, deploymentId: 1 };
    },
    // The verify child: one passing check.
    readFinding: async (_repo: string, path: string) => ({ path, text: FIXING_FINDING, sha: 's', data: parseFrontmatter(FIXING_FINDING).data }),
    readFixPr: async (prUrl: string) => ({ prUrl, merged: true, mergedAt: '2026-10-30T20:00:00Z' }),
    readVerifyBlock: async () => ({
      handoff: null,
      hasBlock: true,
      checks: [{ url: `${ORIGIN}/`, kind: 'text' as const, expect: { contains: 'x' } }],
      source: 'finding' as const,
    }),
    runFindingChecks: async () => ({
      ranAt: '2026-10-30T21:00:00.000Z',
      passed: true,
      results: [{ n: 1, url: `${ORIGIN}/`, kind: 'text', pass: true, expected: 'contains "x"', measured: '1 occurrence' }],
    }),
    writeFindingVerification: async () => ({ findingCommitSha: null, indexCommitSha: null, commitSha: null }),
  };
  return { activities, log, issues };
}

async function withWorker<T>(activities: object, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities,
    taskQueue: FINDINGS,
    bundlerOptions: {},
  });
  return await worker.runUntil(bounded(fn()));
}

function input(site: string, key: string): FindingWorkflowInput {
  return {
    site,
    key,
    repo: 'mattpyle/argus',
    findingPath: `sites/${site}/findings/${key}.md`,
    indexPath: `sites/${site}/findings/INDEX.md`,
    stopAfter: 'resolved',
    handoffPath: `sites/${site}/handoffs/${key}.md`,
    branch: `fix/finding-${key}`,
    origin: ORIGIN,
  };
}

async function startApproved(site: string, key: string): Promise<WorkflowHandle<typeof findingWorkflow>> {
  const handle = await client.workflow.start(findingWorkflow, {
    workflowId: `finding/${site}/${key}`,
    taskQueue: FINDINGS,
    args: [input(site, key)],
  });
  await handle.signal(verdictSignal, APPROVE);
  await handle.signal(fixSignal, FIX);
  return handle;
}

/** Polls the run's state with the plain client until `done` says so, in real time. */
async function until(handle: WorkflowHandle, done: (s: FindingState) => boolean, ms = 20_000): Promise<FindingState> {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = await handle.query(findingStateQuery);
    if (done(state)) return state;
    if (Date.now() > deadline) throw new Error(`${handle.workflowId} is still ${state.step}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function dispatchState(site: string): Promise<DispatchState> {
  return await client.workflow.getHandle(dispatchWorkflowId(site)).query(dispatchStateQuery);
}

/** The dispatcher's signals, decoded, in history order: `<signal> <key>#<ticket> [reason]`. */
async function dispatchSignals(site: string): Promise<string[]> {
  const history = await client.workflow.getHandle(dispatchWorkflowId(site)).fetchHistory();
  return (history.events ?? [])
    .map((e) => e.workflowExecutionSignaledEventAttributes)
    .filter((a) => a != null)
    .map((a) => {
      const payload = JSON.parse(Buffer.from(a.input?.payloads?.[0]?.data as Uint8Array).toString('utf8'));
      const key = String(payload.workflowId).split('/').pop();
      return `${a.signalName} ${key}#${payload.ticket}${payload.reason ? ` ${payload.reason}` : ''}`;
    });
}

test('two findings naming one path: the second waits at waiting-slot, and its issue opens after the first is live', async () => {
  const site = 'seq-site';
  const [a, b] = ['content-first--page', 'content-second--page'];
  const m = mocks({ paths: { [a]: ['src/shared.ts'], [b]: ['src/other.ts', 'src/shared.ts'] }, openPolls: { 401: 2 } });

  await withWorker(m.activities, async () => {
    const first = await startApproved(site, a);
    await until(first, (s) => s.step === 'waiting-merge');
    const second = await startApproved(site, b);
    const waiting = await until(second, (s) => s.step === 'waiting-slot' && (s.slotPaths?.length ?? 0) > 0);
    assert.deepEqual(waiting.slotPaths, ['src/other.ts', 'src/shared.ts']);
    assert.deepEqual(slotBlocker(await dispatchState(site), second.workflowId), { key: a, path: 'src/shared.ts', held: true });
    assert.deepEqual(m.log, [`issue:${a}`, `pr:${a}`], 'no issue for the second fix while the first is in flight');

    // One await through the time-skipping client, which lets the merge polls
    // run (see the file's docblock). The second run is granted only once the
    // first is live, and the first needs no timer after that, so the plain
    // client finishes it.
    const results: FindingWorkflowResult[] = [];
    const secondResult = (await env.client.workflow.getHandle(second.workflowId).result()) as FindingWorkflowResult;
    results.push((await first.result()) as FindingWorkflowResult, secondResult);
    assert.deepEqual(results.map((r) => r.outcome), ['resolved', 'resolved']);
  });

  assert.deepEqual(m.log, [`issue:${a}`, `pr:${a}`, `live:${a}`, `issue:${b}`, `pr:${b}`, `live:${b}`]);
  const signals = await dispatchSignals(site);
  assert.deepEqual(signals, [
    `slot-request ${a}#1`,
    `slot-request ${b}#1`,
    `slot-release ${a}#1 live`,
    `slot-release ${b}#1 live`,
  ]);
});

test('two findings naming different paths open their issues within the same PR poll', async () => {
  const site = 'par-site';
  const [a, b] = ['content-left--page', 'content-right--page'];
  // The PR wait retries every minute in real time here, so no PR opens during the test.
  const m = mocks({ paths: { [a]: ['src/left.ts'], [b]: ['src/right.ts'] }, prPolls: 1_000 });

  await withWorker(m.activities, async () => {
    const first = await startApproved(site, a);
    const second = await startApproved(site, b);
    const started = Date.now();
    await until(first, (s) => Boolean(s.issueUrl));
    await until(second, (s) => Boolean(s.issueUrl));
    assert.ok(Date.now() - started < 20_000);
    assert.deepEqual([...m.log].sort(), [`issue:${a}`, `issue:${b}`]);
    assert.equal((await dispatchState(site)).holders.length, 2);

    // A run that ends some other way gives its slot back. Cancelled between PR
    // polls: a run closed mid-attempt stops the test server's time skipping
    // for every later test (`untilBetweenAttempts`).
    for (const handle of [first, second]) {
      await untilBetweenAttempts(handle, 'awaitFixPr');
      await handle.cancel();
      await handle.result().catch(() => undefined);
    }
  });
  const signals = await dispatchSignals(site);
  assert.deepEqual(signals.filter((s) => s.startsWith('slot-release')).sort(), [`slot-release ${a}#1 ended`, `slot-release ${b}#1 ended`]);
});

test('a PR GitHub answers as conflicting is closed naming the sibling, its slot released, and a second issue opens', async () => {
  const site = 'conflict-site';
  const key = 'agent-readiness-descriptor-read-only--mcp';
  const realFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  const posted: string[] = [];
  const pr401 = { closed: false };
  process.env.GITHUB_TOKEN = 'fake-token-for-tests';
  const routes: Record<string, () => unknown> = {
    // Issue 101's PR, 401, conflicts after a sibling merged; issue 102's PR, 402, merges.
    [`GET /repos/${SITE_REPO}/pulls/401`]: () =>
      pr401.closed
        ? { state: 'closed', merged: false }
        : { state: 'open', merged: false, mergeable: false, mergeable_state: 'dirty', created_at: '2026-10-30T06:02:00Z', base: { ref: 'master' } },
    [`GET /repos/${SITE_REPO}/pulls/401/files?per_page=100`]: () => [{ filename: 'public/.well-known/mcp-server' }],
    [`GET /repos/${SITE_REPO}/pulls?state=closed&base=master&sort=updated&direction=desc&per_page=30`]: () => [
      { number: 390, html_url: `https://github.com/${SITE_REPO}/pull/390`, merged_at: '2026-10-30T07:00:00Z' },
    ],
    [`GET /repos/${SITE_REPO}/pulls/390/files?per_page=100`]: () => [{ filename: 'public/.well-known/mcp-server' }],
    [`GET /repos/${SITE_REPO}/issues/401/comments?per_page=100`]: () => [],
    [`POST /repos/${SITE_REPO}/issues/401/comments`]: () => ({ id: 1 }),
    [`PATCH /repos/${SITE_REPO}/pulls/401`]: () => {
      pr401.closed = true;
      return { state: 'closed' };
    },
    [`GET /repos/${SITE_REPO}/pulls/402`]: () => ({ state: 'closed', merged: true, merge_commit_sha: 'm402', merged_at: '2026-10-30T09:00:00Z' }),
  };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? 'GET'} ${u.pathname}${u.search}`;
    if (!(key in routes)) throw new Error(`no scripted route for ${key}`);
    if (init?.method === 'POST') posted.push(JSON.parse(String(init.body)).body);
    return new Response(JSON.stringify(routes[key]()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const m = mocks({ paths: { [key]: ['public/.well-known/mcp-server'] }, realMerge: true });
  let result: FindingWorkflowResult;
  try {
    result = (await withWorker(m.activities, async () => {
      const handle = await startApproved(site, key);
      return await env.client.workflow.getHandle(handle.workflowId).result();
    })) as FindingWorkflowResult;
  } finally {
    globalThis.fetch = realFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }

  assert.equal(pr401.closed, true);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /since https:\/\/github\.com\/.+\/pull\/390 merged, on `public\/\.well-known\/mcp-server`\./);
  assert.equal(m.issues.length, 2);
  assert.equal(m.issues[0].supersedes, null);
  assert.deepEqual(m.issues[1].supersedes, {
    url: `https://github.com/${SITE_REPO}/issues/101`,
    reason: `https://github.com/${SITE_REPO}/pull/401 conflicted with https://github.com/${SITE_REPO}/pull/390 and was closed; the fix is re-cut from the new master`,
  });
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.prUrl, `https://github.com/${SITE_REPO}/pull/402`);
  assert.equal(result.fixAttempts, 2, 'the re-cut is a second attempt, with no fix signal');
  assert.deepEqual(await dispatchSignals(site), [
    `slot-request ${key}#1`,
    `slot-release ${key}#1 conflict`,
    `slot-request ${key}#2`,
    `slot-release ${key}#2 live`,
  ]);
});

test('a holder that ends without releasing is swept within the hour, and the run waiting behind it goes on to resolve', async () => {
  const site = 'sweep-site';
  const [holderKey, waiterKey] = ['content-holder--page', 'content-waiter--page'];
  // The holder's PR never merges, so only the sweep can free its path.
  const m = mocks({ paths: { [holderKey]: ['src/x.ts'], [waiterKey]: ['src/x.ts'] }, openPolls: { 401: 1_000_000 } });

  const result = (await withWorker(m.activities, async () => {
    const holder = await startApproved(site, holderKey);
    await until(holder, (s) => s.step === 'waiting-merge');
    const waiter = await startApproved(site, waiterKey);
    await until(waiter, (s) => s.step === 'waiting-slot' && (s.slotPaths?.length ?? 0) > 0);

    // Terminated: no `finally` runs, so no release is sent. Only between
    // merge polls: `until` sees `waiting-merge` when the poll is scheduled,
    // and a run terminated during its first attempt leaves the test server's
    // time lock held, so the hourly sweep never comes (`untilBetweenAttempts`).
    await untilBetweenAttempts(holder, 'awaitFixPrMerge');
    await holder.terminate('abandoned for the test');
    // Awaiting through the time-skipping client lets the hourly sweep fire.
    return await env.client.workflow.getHandle(waiter.workflowId).result();
  })) as FindingWorkflowResult;

  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(m.log, [`issue:${holderKey}`, `pr:${holderKey}`, `issue:${waiterKey}`, `pr:${waiterKey}`, `live:${waiterKey}`]);
  const signals = await dispatchSignals(site);
  assert.ok(!signals.includes(`slot-release ${holderKey}#1 ended`), 'the holder never released');
  assert.equal(signals.at(-1), `slot-release ${waiterKey}#1 live`);
});

test('a grant to a run that is not running is dropped, so it never blocks a path', async () => {
  const site = 'gone-site';
  const m = mocks({ paths: {} });
  await withWorker(m.activities, async () => {
    await sendSlotRequest(client, site, {
      workflowId: `finding/${site}/content-never-started--page`,
      key: 'content-never-started--page',
      paths: ['src/x.ts'],
      ticket: 1,
      at: '2026-10-30T20:00:00Z',
    });
    // Until the grant's failure is in the dispatcher's history. A query before
    // its first workflow task can fail, so a failed read is one more poll.
    const handle = client.workflow.getHandle(dispatchWorkflowId(site));
    const deadline = Date.now() + 30_000;
    let failed = false;
    while (!failed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const history = await handle.fetchHistory().catch(() => undefined);
      failed = (history?.events ?? []).some((e) => e.signalExternalWorkflowExecutionFailedEventAttributes != null);
    }
    assert.ok(failed, 'the grant was sent and failed');
    // The task that reads the failure drops the entry; it may still be running.
    let state = await dispatchState(site);
    while (state.holders.length + state.waiters.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      state = await dispatchState(site);
    }
    assert.deepEqual(state, { site, holders: [], waiters: [] });
  });
});
