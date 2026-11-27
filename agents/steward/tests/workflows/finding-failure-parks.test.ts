import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowUpdateFailedError, WorkflowUpdateStage, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';
import { bounded, createTestEnv, untilBetweenAttempts } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT, settings } from '../helpers/verdict-measure.js';
import {
  FAILURE_PARKS_PATCH,
  findingStateQuery,
  findingWorkflow,
  requestFixUpdate,
  resumeUpdate,
  verdictUpdate,
  type FindingState,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import type { FindingVerdict } from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * A failure no retry mends parks a finding run (STW-689): the gate's verdict
 * write, the settings reads, the re-issue at a durable call's bound, and the
 * refusal of a second rejection while one is written. Mocked activities and
 * skipped time.
 *
 * A server per test, at most one time-skipping await in each, and a plain
 * client for everything else, as `finding-lifecycle.test.ts` explains.
 */

const FINDINGS = 'steward-findings';
const WATCH = 'steward-findings-watch';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR = `https://github.com/${SITE_REPO}/pull/402`;
const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'cli', at: '2026-11-25T18:00:00Z' };
const APPROVE_AGAIN: FindingVerdict = { status: 'approved', reason: 'Real, and worse than it looked.', source: 'cli', at: '2026-11-25T18:10:00Z' };
const REJECT: FindingVerdict = { status: 'rejected', reason: 'Not worth it.', source: 'cli', at: '2026-11-25T18:20:00Z' };
const RESUME = { source: 'cli' as const, at: '2026-11-25T18:30:00Z' };
const FIX = { source: 'cli' as const, at: '2026-11-25T18:31:00Z' };

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

type Handle = WorkflowHandle<typeof findingWorkflow>;

const commit = { findingCommitSha: 'c-1', indexCommitSha: 'c-2', commitSha: 'c-2' };
const authError = () => ApplicationFailure.create({ message: 'GitHub refused the credential (401)', type: 'AuthError', nonRetryable: true });
const notFound = () => ApplicationFailure.create({ message: 'GitHub answered 404 for config.yaml', type: 'NotFound', nonRetryable: true });
const moved = () => ApplicationFailure.create({ message: 'the finding file says resolved', type: 'FindingMoved', nonRetryable: true });
const down = () => ApplicationFailure.create({ message: 'GitHub answered 500.', type: 'GitHubUnavailable', category: ApplicationFailureCategory.BENIGN });

function input(id: string, over: Partial<FindingWorkflowInput> = {}): FindingWorkflowInput {
  return {
    site: 'mattpyle-com',
    key: DEFECT_KEY,
    repo: 'mattpyle/argus',
    findingPath: `sites/mattpyle-com/findings/${DEFECT_KEY}.md`,
    indexPath: 'sites/mattpyle-com/findings/INDEX.md',
    ...over,
  };
}

async function withWorker<T>(activities: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({ connection: env.nativeConnection, workflowBundle: await workflowBundle(), activities, taskQueue: FINDINGS });
  return await worker.runUntil(bounded(fn()));
}

function start(id: string, over: Partial<FindingWorkflowInput> = {}): Promise<Handle> {
  return client.workflow.start(findingWorkflow, { workflowId: `finding/mattpyle-com/parks-${id}`, taskQueue: FINDINGS, args: [input(id, over)] });
}

async function until(handle: Pick<Handle, 'query'>, ready: (state: FindingState) => boolean, what: string): Promise<FindingState> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = await handle.query(findingStateQuery);
    if (ready(state)) return state;
    if (Date.now() > deadline) assert.fail(`the run never reached ${what}; it is ${state.status} at ${state.step}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`never saw ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The one time-skipping await of a test. */
function skipResult(handle: { workflowId: string }) {
  return env.client.workflow.getHandle<typeof findingWorkflow>(handle.workflowId).result();
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WorkflowUpdateFailedError, `expected a refused Update, got ${String(err)}`);
    return err.cause instanceof Error ? err.cause.message : err.message;
  }
  assert.fail('the Update was accepted');
}

function markers(history: { events?: Array<{ markerRecordedEventAttributes?: { details?: Record<string, { payloads?: Array<{ data?: Uint8Array | null }> | null }> | null } | null }> | null }): string[] {
  return (history.events ?? [])
    .map((e) => e.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0]?.data)
    .filter((d): d is Uint8Array => d instanceof Uint8Array)
    .map((d) => (JSON.parse(Buffer.from(d).toString('utf8')) as { id: string }).id);
}

/** A gate whose first verdict write is refused for good, then lands, at a site that stops at the verdict. */
function gateMocks() {
  const writes: Array<{ status: string; reason: string }> = [];
  return {
    writes,
    activities: {
      writeFindingVerdict: async (i: { status: string; reason: string }) => {
        writes.push({ status: i.status, reason: i.reason });
        if (writes.length === 1) throw authError();
        return commit;
      },
      readFindingSettings: async () => STOPS_AT_VERDICT,
    },
  };
}

test('a verdict write refused for good parks at verdict, held and unwritten; request-fix is refused and resume writes it', async () => {
  const m = gateMocks();
  const out = await withWorker(m.activities, async () => {
    const handle = await start('verdict-resume');
    const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: WorkflowUpdateStage.ACCEPTED });
    const answered = await refusal(update.result());
    const parked = await until(handle, (s) => s.step === 'parked', 'the park');
    const status = (await handle.describe()).status.name;
    const fix = await refusal(handle.executeUpdate(requestFixUpdate, { args: [FIX] }));
    const resumed = await handle.executeUpdate(resumeUpdate, { args: [RESUME] });
    const result = await skipResult(handle);
    return { answered, parked, status, fix, resumed, result, history: await handle.fetchHistory() };
  });
  assert.match(out.answered, /The verdict was not written: GitHub refused the credential/);
  assert.equal(out.status, 'RUNNING', 'the run did not fail');
  assert.equal(out.parked.parked?.stage, 'verdict');
  assert.equal(out.parked.status, 'held');
  assert.equal(out.parked.parked?.reason, 'The approved verdict was not written: GitHub refused the credential (401).');
  assert.equal(out.parked.commitSha, null);
  assert.equal(out.parked.verdict?.status, 'approved');
  assert.match(out.parked.parked?.moves ?? '', /resume .* writes the verdict again/);
  assert.match(out.fix, /The verdict is not written yet/);
  assert.deepEqual(out.resumed, { stage: 'verdict', attempt: 0 });
  assert.equal(out.result.commitSha, 'c-2');
  assert.equal(m.writes.length, 2);
  assert.ok(markers(out.history).includes(FAILURE_PARKS_PATCH));
});

test('a rejection at a park at verdict replaces the held approval, is written, and ends the run rejected', async () => {
  const m = gateMocks();
  const out = await withWorker(m.activities, async () => {
    const handle = await start('verdict-reject', { stopAfter: 'resolved', handoffPath: 'h.md', branch: 'fix/x', origin: ORIGIN });
    const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: WorkflowUpdateStage.ACCEPTED });
    await refusal(update.result());
    await until(handle, (s) => s.step === 'parked', 'the park');
    const answer = await handle.executeUpdate(verdictUpdate, { args: [REJECT] });
    return { answer, result: await skipResult(handle) };
  });
  assert.equal(out.answer.first, true);
  assert.equal(out.answer.verdict.status, 'rejected');
  assert.equal(out.answer.commitSha, 'c-2');
  assert.equal(out.result.outcome, 'rejected');
  assert.equal(out.result.verdict.status, 'rejected');
  assert.deepEqual(m.writes.map((w) => w.status), ['approved', 'rejected']);
});

test('a new approval at a park at verdict replaces the held one and is written with its own reason', async () => {
  const m = gateMocks();
  const out = await withWorker(m.activities, async () => {
    const handle = await start('verdict-replace');
    const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: WorkflowUpdateStage.ACCEPTED });
    await refusal(update.result());
    await until(handle, (s) => s.step === 'parked', 'the park');
    const answer = await handle.executeUpdate(verdictUpdate, { args: [APPROVE_AGAIN] });
    return { answer, result: await skipResult(handle) };
  });
  assert.equal(out.answer.first, true);
  assert.equal(out.answer.verdict.reason, APPROVE_AGAIN.reason);
  assert.equal(out.result.verdict.reason, APPROVE_AGAIN.reason);
  assert.deepEqual(m.writes.map((w) => w.reason), [APPROVE.reason, APPROVE_AGAIN.reason]);
});

test('a verdict write that meets a file decided elsewhere ends the run closed, with nothing written', async () => {
  const out = await withWorker(
    {
      writeFindingVerdict: async () => {
        throw moved();
      },
      readFindingSettings: async () => settings({ status: 'resolved' }),
    },
    async () => {
      const handle = await start('verdict-moved');
      const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: WorkflowUpdateStage.ACCEPTED });
      const answered = await refusal(update.result());
      const result = await skipResult(handle);
      return { answered, result, last: await handle.query(findingStateQuery) };
    },
  );
  assert.match(out.answered, /the finding file says resolved/);
  assert.equal(out.last.status, 'held', 'the closed run reads as held and unwritten');
  assert.equal(out.last.commitSha, null);
  assert.equal(out.result.outcome, 'closed');
  assert.equal(out.result.commitSha, null);
  assert.match(out.result.note ?? '', /Closed at its verdict: the finding file says resolved/);
});

test('a settings read refused for good at the gate parks at settings, refuses a rejection until resume, and resume reads again', async () => {
  let reads = 0;
  const out = await withWorker(
    {
      writeFindingVerdict: async () => commit,
      readFindingSettings: async () => {
        reads++;
        if (reads === 1) throw notFound();
        return STOPS_AT_VERDICT;
      },
    },
    async () => {
      const handle = await start('settings-gate');
      const answer = await handle.executeUpdate(verdictUpdate, { args: [APPROVE] });
      const parked = await until(handle, (s) => s.step === 'parked', 'the park');
      const reject = await refusal(handle.executeUpdate(verdictUpdate, { args: [REJECT] }));
      const fix = await refusal(handle.executeUpdate(requestFixUpdate, { args: [FIX] }));
      const resumed = await handle.executeUpdate(resumeUpdate, { args: [RESUME] });
      return { answer, parked, reject, fix, resumed, result: await skipResult(handle) };
    },
  );
  assert.equal(out.answer.commitSha, 'c-2');
  assert.equal(out.parked.parked?.stage, 'settings');
  assert.equal(out.parked.status, 'done');
  assert.match(out.parked.parked?.reason ?? '', /settings could not be read: GitHub answered 404/);
  assert.equal(out.parked.parked?.reason, "The site's settings could not be read: GitHub answered 404 for config.yaml.");
  assert.match(out.reject, /send resume first/);
  assert.match(out.fix, /cannot read its site's settings yet/);
  assert.equal(out.resumed.stage, 'settings');
  assert.equal(reads, 2);
  assert.equal(out.result.commitSha, 'c-2');
});

test("a park's reason ends in one full stop when the activity's message brings its own", async () => {
  let writes = 0;
  let reads = 0;
  const out = await withWorker(
    {
      writeFindingVerdict: async () => {
        if (++writes === 1) throw ApplicationFailure.nonRetryable('x.md has no index line.', 'FindingMissing');
        return commit;
      },
      readFindingSettings: async () => {
        if (++reads === 1) throw ApplicationFailure.nonRetryable('config.yaml is not there.', 'NotFound');
        return STOPS_AT_VERDICT;
      },
    },
    async () => {
      const handle = await start('one-full-stop');
      const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: WorkflowUpdateStage.ACCEPTED });
      await refusal(update.result());
      const verdict = await until(handle, (s) => s.parked?.stage === 'verdict', 'the park at verdict');
      await handle.executeUpdate(resumeUpdate, { args: [RESUME] });
      const atSettings = await until(handle, (s) => s.parked?.stage === 'settings', 'the park at settings');
      await handle.executeUpdate(resumeUpdate, { args: [RESUME] });
      await skipResult(handle);
      return { verdict: verdict.parked?.reason, settings: atSettings.parked?.reason };
    },
  );
  assert.equal(out.verdict, 'The approved verdict was not written: x.md has no index line.');
  assert.equal(out.settings, "The site's settings could not be read: config.yaml is not there.");
});

test("a settings read refused for good in the fix wait parks at settings and posts nothing on the attempt's closed PR", async () => {
  let reads = 0;
  const comments: string[] = [];
  const out = await withWorker(
    {
      writeFindingVerdict: async () => commit,
      readFindingSettings: async () => {
        reads++;
        // The gate's read, the decision, then the parked run's first daily read.
        if (reads === 3) throw notFound();
        return settings({ autoFix: true });
      },
      readFinding: async (_repo: string, path: string) => ({ path, text: DEFECT_FINDING, sha: 'sha-1', data: parseFrontmatter(DEFECT_FINDING).data }),
      readVerifyBlock: async () => ({ handoff: null, hasBlock: false, checks: [], source: 'finding' as const }),
      writeFindingVerdictMeasure: async () => ({ commitSha: null }),
      requestFixSlot: async () => ({ paths: [], dispatched: false }),
      openFixIssue: async () => ({ repo: SITE_REPO, number: 102, url: `https://github.com/${SITE_REPO}/issues/102`, reused: false }),
      awaitFixPr: async () => ({ prUrl: PR, branch: 'claude/issue-102-20261125-0000' }),
      writeFindingFix: async () => commit,
      awaitFixPrMerge: async () => ({ prUrl: PR, state: 'closed' as const }),
      writeFindingReturned: async () => commit,
      commentOnFixPr: async (i: { marker: string }) => {
        comments.push(i.marker);
        return { posted: true };
      },
    },
    async () => {
      const handle = await start('settings-lifecycle', { stopAfter: 'resolved', handoffPath: 'h.md', branch: 'fix/x', origin: ORIGIN });
      await handle.executeUpdate(verdictUpdate, { args: [APPROVE] });
      await until(handle, (s) => s.step === 'waiting-fix' && s.issueUrl !== null && (s.fixAttempts ?? 0) === 1, 'the fix wait after the closed PR');
      // The one time-skipping await: past the parked run's one-day read.
      await env.sleep('25 hours');
      const parked = await until(handle, (s) => s.step === 'parked', 'the park');
      const fix = await refusal(handle.executeUpdate(requestFixUpdate, { args: [FIX] }));
      const resumed = await handle.executeUpdate(resumeUpdate, { args: [RESUME] });
      const back = await until(handle, (s) => s.step === 'waiting-fix', 'the fix wait again');
      await handle.terminate('test over');
      return { parked, fix, resumed, back };
    },
  );
  assert.equal(out.parked.parked?.stage, 'settings');
  assert.equal(out.parked.prUrl, PR, 'the earlier, closed PR is still in the state');
  assert.equal(out.parked.parked?.reason, "The site's settings could not be read: GitHub answered 404 for config.yaml.");
  assert.equal(out.parked.parked?.commentError ?? null, null);
  // Probe (2026-11-25): a `park()` that posted at every stage failed this line; reverted.
  assert.deepEqual(comments, [], 'no comment on the closed PR');
  assert.match(out.fix, /cannot read its site's settings/);
  assert.equal(out.resumed.stage, 'settings');
  assert.equal(reads, 4);
  assert.equal(out.back.parked ?? null, null);
});

test('a durable call that ends on its bound is issued again, and the run does not fail', async () => {
  let schedules = 0;
  const out = await withWorker(
    {
      writeFindingVerdict: async () => {
        if (Context.current().info.attempt === 1) schedules++;
        // A delay past the 7-day bound: the server closes the call on its bound at once.
        if (schedules === 1) throw ApplicationFailure.create({ message: 'GitHub answered 500.', type: 'GitHubUnavailable', nextRetryDelay: '8 days' });
        return commit;
      },
      readFindingSettings: async () => STOPS_AT_VERDICT,
    },
    async () => {
      const handle = await start('bound');
      const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: WorkflowUpdateStage.ACCEPTED });
      const result = await skipResult(handle);
      return { answer: await update.result(), result, history: await handle.fetchHistory() };
    },
  );
  assert.equal(out.answer.commitSha, 'c-2');
  assert.equal(out.result.commitSha, 'c-2');
  assert.equal(schedules, 2);
  const events = out.history.events ?? [];
  assert.equal(events.filter((e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'writeFindingVerdict').length, 2);
  const closed = events.find((e) => e.activityTaskFailedEventAttributes)?.activityTaskFailedEventAttributes;
  assert.equal(closed?.retryState, 3, 'RETRY_STATE_TIMEOUT');
  assert.ok(markers(out.history).includes(FAILURE_PARKS_PATCH));
});

test('a durable call refused for good never reads the marker: the fix issue sends the run back to its fix wait', async () => {
  let reads = 0;
  const out = await withWorker(
    {
      writeFindingVerdict: async () => commit,
      readFindingSettings: async () => (reads++, settings({ autoFix: true })),
      readFinding: async (_repo: string, path: string) => ({ path, text: DEFECT_FINDING, sha: 'sha-1', data: parseFrontmatter(DEFECT_FINDING).data }),
      readVerifyBlock: async () => ({ handoff: null, hasBlock: false, checks: [], source: 'finding' as const }),
      writeFindingVerdictMeasure: async () => ({ commitSha: null }),
      requestFixSlot: async () => ({ paths: [], dispatched: false }),
      openFixIssue: async () => {
        throw notFound();
      },
    },
    async () => {
      const handle = await start('permanent-durable', { stopAfter: 'resolved', handoffPath: 'h.md', branch: 'fix/x', origin: ORIGIN });
      await handle.executeUpdate(verdictUpdate, { args: [APPROVE] });
      const state = await until(handle, (s) => s.step === 'waiting-fix' && (s.fixAttempts ?? 0) === 1, 'the fix wait');
      const history = await handle.fetchHistory();
      await handle.terminate('test over');
      return { state, history };
    },
  );
  assert.match(out.state.lastFixError ?? '', /404/);
  // Probe (2026-11-25): a `durable` that read the marker before testing the
  // bound recorded it here, and this line failed; reverted.
  assert.ok(!markers(out.history).includes(FAILURE_PARKS_PATCH), 'no failure-parks marker');
});

test('a second rejection while the first is being written is refused, at a watch', async () => {
  let writes = 0;
  const findings = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    taskQueue: FINDINGS,
    activities: {
      readFindingSettings: async () => settings({ stopAfter: 'verdict', origin: null, watch: true }),
      writeFindingVerdict: async () => {
        writes++;
        throw down();
      },
    },
  });
  const watch = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: WATCH,
    activities: {
      watchFinding: async () => {
        throw ApplicationFailure.create({ type: 'StillPresent', message: 'still present', nextRetryDelay: '1 day', category: ApplicationFailureCategory.BENIGN });
      },
    },
  });
  const out = await watch.runUntil(
    findings.runUntil(
      bounded(
        (async () => {
          // The verdict is in the file, so the gate writes nothing: every write is the rejection's.
          const handle = await start('second-rejection', { verdict: { ...APPROVE, source: 'file' } });
          await until(handle, (s) => s.step === 'watching', 'watching');
          await handle.startUpdate(verdictUpdate, { args: [REJECT], waitForStage: WorkflowUpdateStage.ACCEPTED });
          await waitFor(() => writes >= 1, 'the rejection write');
          const second = await refusal(handle.executeUpdate(verdictUpdate, { args: [{ ...REJECT, reason: 'Another reason.' }] }));
          await untilBetweenAttempts(handle, 'writeFindingVerdict');
          await handle.terminate('test over');
          return { second };
        })(),
      ),
    ),
  );
  assert.match(out.second, /A rejection is already being written/);
});
