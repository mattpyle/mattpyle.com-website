import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowUpdateStage, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT, settings } from '../helpers/verdict-measure.js';
import {
  findingStateQuery,
  findingWorkflow,
  fixSignal,
  verdictSignal,
  verdictUpdate,
  type FindingState,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import type { WriteFindingVerdictMeasureInput } from '../../src/activities/findings-verdict-measure.js';
import type { FindingVerdict } from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * The retry policies of `findingWorkflow`'s GitHub calls (STW-680), with
 * mocked activities and skipped time: an outage is waited out, a permanent
 * failure ends a call as it did, and the park's comment stays bounded.
 *
 * A server per test, one time-skipping await in each, and a plain client for
 * everything else, as `finding-lifecycle.test.ts` explains.
 */

const QUEUE = 'steward-findings';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR = `https://github.com/${SITE_REPO}/pull/401`;
const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'cli', at: '2026-11-25T18:00:00Z' };

/** The first attempt that runs more than an hour after the first: the waits before it add up to 3722 seconds. */
const AFTER_AN_HOUR = 13;

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

/** GitHub answering 500, and BENIGN so a retried one logs at DEBUG. */
const down = () => ApplicationFailure.create({ message: 'GitHub answered 500.', type: 'GitHubUnavailable', category: ApplicationFailureCategory.BENIGN });
const attempt = () => Context.current().info.attempt;
const commit = { findingCommitSha: 'c-1', indexCommitSha: 'c-2', commitSha: 'c-2' };
const issue = { repo: SITE_REPO, number: 101, url: `https://github.com/${SITE_REPO}/issues/101`, reused: false };

/** A site that fixes findings, a finding with no checks, and a PR that stays open. */
function activities(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    writeFindingVerdict: async () => commit,
    readFindingSettings: async () => settings(),
    readFinding: async (_repo: string, path: string) => ({ path, text: DEFECT_FINDING, sha: 'sha-1', data: parseFrontmatter(DEFECT_FINDING).data }),
    readVerifyBlock: async () => ({ handoff: null, hasBlock: false, checks: [], source: 'finding' as const }),
    writeFindingVerdictMeasure: async () => ({ commitSha: null }),
    requestFixSlot: async () => ({ paths: [], dispatched: false }),
    openFixIssue: async () => issue,
    awaitFixPr: async () => ({ prUrl: PR, branch: 'claude/issue-101-20261125-0000' }),
    writeFindingFix: async () => commit,
    commentOnFixPr: async () => ({ posted: true }),
    awaitFixPrMerge: async () => {
      throw ApplicationFailure.create({ message: 'still open', type: 'PrStillOpen', category: ApplicationFailureCategory.BENIGN });
    },
    ...over,
  };
}

async function withWorker<T>(mocks: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: mocks,
    taskQueue: QUEUE,
  });
  return await worker.runUntil(bounded(fn()));
}

function start(id: string, stopAfter: 'verdict' | 'resolved' = 'resolved') {
  const base = {
    site: 'mattpyle-com',
    key: DEFECT_KEY,
    repo: 'mattpyle/argus',
    findingPath: `sites/mattpyle-com/findings/${DEFECT_KEY}.md`,
    indexPath: 'sites/mattpyle-com/findings/INDEX.md',
  };
  const input: FindingWorkflowInput =
    stopAfter === 'verdict'
      ? { ...base, stopAfter }
      : { ...base, stopAfter, handoffPath: `sites/mattpyle-com/handoffs/${DEFECT_KEY}.md`, branch: `fix/finding-${id}`, origin: ORIGIN };
  return client.workflow.start(findingWorkflow, { workflowId: `finding/mattpyle-com/durable-${id}`, taskQueue: QUEUE, args: [input] });
}

/** The run as it stands while an activity of it is in an attempt. */
async function seenFromActivity(): Promise<{ status: string; state: FindingState }> {
  const handle = client.workflow.getHandle<typeof findingWorkflow>(Context.current().info.workflowExecution!.workflowId);
  return { status: (await handle.describe()).status.name, state: await handle.query(findingStateQuery) };
}

async function untilState(handle: WorkflowHandle<typeof findingWorkflow>, ready: (state: FindingState) => boolean, what: string): Promise<FindingState> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const state = await handle.query(findingStateQuery);
    if (ready(state)) return state;
    if (Date.now() > deadline) assert.fail(`the run never reached ${what}; it is ${state.status} at ${state.step}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a verdict write that gets 5xx for an hour then succeeds: the run stays open and the Update is answered', async () => {
  let attempts = 0;
  let late: { status: string; state: FindingState } | undefined;
  const mocks = activities({
    readFindingSettings: async () => STOPS_AT_VERDICT,
    writeFindingVerdict: async () => {
      attempts = attempt();
      if (attempts === AFTER_AN_HOUR - 1) late = await seenFromActivity();
      if (attempts < AFTER_AN_HOUR) throw down();
      return commit;
    },
  });
  await withWorker(mocks, async () => {
    const handle = await start('verdict-outage', 'verdict');
    const update = await handle.startUpdate(verdictUpdate, { args: [APPROVE], waitForStage: WorkflowUpdateStage.ACCEPTED });
    await env.sleep('90 minutes');
    const recorded = await update.result();
    assert.equal(recorded.commitSha, 'c-2');
    assert.equal(recorded.first, true);
  });
  assert.equal(attempts, AFTER_AN_HOUR);
  assert.equal(late?.status, 'RUNNING');
  assert.equal(late?.state.status, 'writing');
});

test('a fix issue and a fix write that get 5xx are waited out, and the run knows its PR while the write retries', async () => {
  let issueAttempts = 0;
  let atIssue: { status: string; state: FindingState } | undefined;
  let atWrite: { status: string; state: FindingState } | undefined;
  const mocks = activities({
    openFixIssue: async () => {
      issueAttempts = attempt();
      if (issueAttempts === AFTER_AN_HOUR - 1) atIssue = await seenFromActivity();
      if (issueAttempts < AFTER_AN_HOUR) throw down();
      return issue;
    },
    writeFindingFix: async () => {
      if (attempt() === 6) atWrite = await seenFromActivity();
      if (attempt() < 7) throw down();
      return commit;
    },
  });
  await withWorker(mocks, async () => {
    const handle = await start('issue-outage');
    await handle.signal(verdictSignal, APPROVE);
    await handle.signal(fixSignal, { source: 'cli', at: '2026-11-25T18:05:00Z' });
    await env.sleep('90 minutes');
    const state = await untilState(handle, (s) => s.step === 'waiting-merge', 'waiting-merge');
    assert.equal(state.fixAttempts, 1, 'the one attempt waited the outage out');
    assert.equal(state.lastFixError, null);
    await handle.terminate('test over');
  });
  assert.equal(issueAttempts, AFTER_AN_HOUR);
  assert.equal(atIssue?.status, 'RUNNING');
  assert.equal(atIssue?.state.step, 'fixing');
  assert.equal(atWrite?.state.step, 'fixing');
  assert.equal(atWrite?.state.prUrl, PR);
});

test('a fix issue that is refused for good is tried once and sends the run back to its fix wait', async () => {
  let calls = 0;
  const mocks = activities({
    openFixIssue: async () => {
      calls++;
      throw ApplicationFailure.nonRetryable('The finding is not fixable.', 'FindingNotFixable');
    },
  });
  await withWorker(mocks, async () => {
    const handle = await start('issue-refused');
    await handle.signal(verdictSignal, APPROVE);
    await handle.signal(fixSignal, { source: 'cli', at: '2026-11-25T18:05:00Z' });
    const state = await untilState(handle, (s) => s.step === 'waiting-fix' && Boolean(s.lastFixError), 'waiting-fix');
    assert.match(state.lastFixError ?? '', /not fixable/);
    await handle.terminate('test over');
  });
  assert.equal(calls, 1);
});

test('the reads of the measurement at the verdict outlast more than their old three attempts', async () => {
  let measured: WriteFindingVerdictMeasureInput | undefined;
  let reads = 0;
  const mocks = activities({
    readFinding: async (_repo: string, path: string) => {
      reads = attempt();
      if (reads < 6) throw down();
      return { path, text: DEFECT_FINDING, sha: 'sha-1', data: parseFrontmatter(DEFECT_FINDING).data };
    },
    writeFindingVerdictMeasure: async (input: WriteFindingVerdictMeasureInput) => {
      measured = input;
      return { commitSha: null };
    },
  });
  await withWorker(mocks, async () => {
    const handle = await start('measure-outage');
    await handle.signal(verdictSignal, APPROVE);
    await env.sleep('10 minutes');
    await untilState(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
    await handle.terminate('test over');
  });
  assert.equal(reads, 6);
  assert.equal(measured?.measure.reason, 'the finding has no checks', 'the read answered, so the finding was not recorded as unreadable');
});

test('the comment of a park gives up after five attempts, so the park still takes its messages', async () => {
  let comments = 0;
  const mocks = activities({
    awaitFixPrMerge: async () => {
      throw ApplicationFailure.nonRetryable('The PR answered 404.', 'NotFound');
    },
    commentOnFixPr: async () => {
      comments = attempt();
      throw down();
    },
  });
  await withWorker(mocks, async () => {
    const handle = await start('comment-outage');
    await handle.signal(verdictSignal, APPROVE);
    await handle.signal(fixSignal, { source: 'cli', at: '2026-11-25T18:05:00Z' });
    await env.sleep('5 minutes');
    const state = await untilState(handle, (s) => s.step === 'parked' && Boolean(s.parked?.commentError), 'parked, the comment failed');
    assert.equal(state.parked?.stage, 'merge');
    await handle.terminate('test over');
  });
  assert.equal(comments, 5);
});
