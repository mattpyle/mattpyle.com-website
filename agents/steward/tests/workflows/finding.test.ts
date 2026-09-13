import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { createTestEnv } from '../helpers/test-env.js';
import {
  findingStateQuery,
  findingWorkflow,
  verdictSignal,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import type { FindingVerdict } from '../../src/lib/findings.js';
import type { WriteFindingVerdictInput } from '../../src/activities/findings.js';

/**
 * `findingWorkflow` with its one activity mocked: which verdict source writes,
 * that the first verdict stands, and that the stop point in the input is the
 * only one honoured.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE = 'steward-findings';

let env: TestWorkflowEnvironment;

before(async () => {
  env = await createTestEnv();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

function mockActivities() {
  const writes: WriteFindingVerdictInput[] = [];
  const activities = {
    writeFindingVerdict: async (input: WriteFindingVerdictInput) => {
      writes.push(input);
      return { findingCommitSha: 'c-file', indexCommitSha: 'c-index', commitSha: 'c-index' };
    },
  };
  return { activities, writes };
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

function input(key: string, overrides: Partial<FindingWorkflowInput> = {}): FindingWorkflowInput {
  return {
    site: 'mattpyle-com',
    key,
    repo: 'mattpyle/argus',
    findingPath: `sites/mattpyle-com/findings/${key}.md`,
    indexPath: 'sites/mattpyle-com/findings/INDEX.md',
    stopAfter: 'verdict',
    ...overrides,
  };
}

const CLI_APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'cli', at: '2026-09-12T18:00:00Z' };
const FILE_REJECT: FindingVerdict = { status: 'rejected', reason: 'By design.', source: 'file', at: '2026-09-12T19:05:00Z' };

test('a CLI verdict writes the file and completes with the verdict and the commit', async () => {
  const { activities, writes } = mockActivities();
  const result = await withWorker(activities, async () => {
    const handle = await env.client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/cli-one',
      taskQueue: QUEUE,
      args: [input('cli-one')],
    });
    assert.equal((await handle.query(findingStateQuery)).status, 'waiting');
    await handle.signal(verdictSignal, CLI_APPROVE);
    const r = await handle.result();
    assert.equal((await handle.query(findingStateQuery)).status, 'done');
    return r;
  });
  assert.deepEqual(result.verdict, CLI_APPROVE);
  assert.equal(result.commitSha, 'c-index');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'approved');
  assert.equal(writes[0].source, 'cli');
  assert.equal(writes[0].repo, 'mattpyle/argus');
  assert.equal(writes[0].findingPath, 'sites/mattpyle-com/findings/cli-one.md');
});

test('a file verdict writes nothing and completes with source file', async () => {
  const { activities, writes } = mockActivities();
  const result = await withWorker(activities, async () => {
    const handle = await env.client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/file-one',
      taskQueue: QUEUE,
      args: [input('file-one')],
    });
    await handle.signal(verdictSignal, FILE_REJECT);
    return handle.result();
  });
  assert.deepEqual(result.verdict, FILE_REJECT);
  assert.equal(result.commitSha, null);
  assert.equal(writes.length, 0);
});

test('the first verdict stands and a second in the same breath is ignored', async () => {
  const { activities, writes } = mockActivities();
  const result = await withWorker(activities, async () => {
    const handle = await env.client.workflow.signalWithStart(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/twice',
      taskQueue: QUEUE,
      args: [input('twice')],
      signal: verdictSignal,
      signalArgs: [FILE_REJECT],
    });
    await handle.signal(verdictSignal, CLI_APPROVE).catch(() => undefined);
    return handle.result();
  });
  assert.equal(result.verdict.status, 'rejected');
  assert.equal(result.verdict.source, 'file');
  assert.equal(writes.length, 0, 'the ignored CLI verdict wrote nothing');
});

test('a malformed verdict is ignored and the workflow keeps waiting', async () => {
  const { activities } = mockActivities();
  await withWorker(activities, async () => {
    const handle = await env.client.workflow.start(findingWorkflow, {
      workflowId: 'finding/mattpyle-com/malformed',
      taskQueue: QUEUE,
      args: [input('malformed')],
    });
    await handle.signal(verdictSignal, { status: 'maybe', source: 'cli', reason: '', at: '' } as never);
    const state = await handle.query(findingStateQuery);
    assert.equal(state.status, 'waiting');
    assert.equal(state.verdict, null);
    await handle.signal(verdictSignal, CLI_APPROVE);
    await handle.result();
  });
});

test('stopAfter is honoured: an unknown stop point fails rather than guessing', async () => {
  const { activities } = mockActivities();
  await withWorker(activities, async () => {
    await assert.rejects(
      env.client.workflow.execute(findingWorkflow, {
        workflowId: 'finding/mattpyle-com/unknown-stop',
        taskQueue: QUEUE,
        args: [input('unknown-stop', { stopAfter: 'handoff' as never })],
      }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowFailedError);
        assert.match(String((err.cause as Error)?.message), /stopAfter "handoff"/);
        return true;
      },
    );
  });
});
