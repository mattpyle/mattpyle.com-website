import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import type { StubInput } from '../helpers/finding-status-stub.js';

const exec = promisify(execFile);
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(STEWARD, 'src', 'cli.ts');
const workflowsPath = fileURLToPath(new URL('../helpers/finding-status-stub.ts', import.meta.url));
const SITE = 'mattpyle-com';
const QUEUE = 'status-stub';

/**
 * `steward finding status` through the real CLI, against a test server whose
 * `findingWorkflow` is a stub (`tests/helpers/finding-status-stub.ts`). The
 * first lines say whether the run is open and how a closed one ended; a closed
 * run's step and gate are headed `last state:`.
 *
 * No time skipping is awaited: the runs close through the plain client, and
 * the CLI is a separate process on the server's loopback address.
 */

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

async function status(key: string): Promise<string[]> {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', CLI, 'finding', 'status', key], {
    cwd: STEWARD,
    env: { ...process.env, TEMPORAL_ADDRESS: env.address, TEMPORAL_NAMESPACE: env.namespace ?? 'default', TEMPORAL_API_KEY: '' },
  });
  return stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean);
}

async function start(key: string, input: StubInput) {
  return await client.workflow.start('findingWorkflow', {
    taskQueue: QUEUE,
    workflowId: `finding/${SITE}/${key}`,
    args: [input],
  });
}

async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    workflowsPath,
    taskQueue: QUEUE,
    bundlerOptions: {},
  });
  return await worker.runUntil(bounded(fn()));
}

test('an open run at waiting-fix leads with run: open, then its step', async () => {
  await withWorker(async () => {
    await start('open-one', { mode: 'open', step: 'waiting-fix', gate: 'done' });
    const lines = await status('open-one');
    assert.equal(lines[0], `  finding/${SITE}/open-one`);
    assert.equal(lines[1], '  run: open');
    assert.equal(lines[2], '  step: waiting-fix  (stop after resolved)');
    assert.equal(lines[3], '  gate: done');
    assert.ok(!lines.includes('  last state:'));
  });
});

test('a cancelled run says when it was cancelled and heads its step as last state', async () => {
  await withWorker(async () => {
    const handle = await start('cancelled-one', { mode: 'open', step: 'waiting-fix', gate: 'done' });
    await handle.cancel();
    await handle.result().catch(() => undefined);
    const lines = await status('cancelled-one');
    assert.match(lines[1], /^  run: cancelled at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(lines[2], /^  failure: /);
    assert.equal(lines[3], '  last state:');
    assert.equal(lines[4], '    step: waiting-fix  (stop after resolved)');
    assert.equal(lines[5], '    gate: done');
  });
});

test('a completed run prints its outcome and the verify workflow', async () => {
  await withWorker(async () => {
    const handle = await start('resolved-one', {
      mode: 'completed',
      step: 'done',
      gate: 'done',
      result: { outcome: 'resolved', verifyWorkflowId: `verify/${SITE}/resolved-one` },
    });
    await handle.result();
    const lines = await status('resolved-one');
    assert.match(lines[1], /^  run: completed at \d{4}-/);
    assert.equal(lines[2], `  outcome: resolved (verify verify/${SITE}/resolved-one)`);
    assert.equal(lines[3], '  last state:');
    assert.equal(lines[4], '    step: done  (stop after resolved)');
  });
});

test('a failed run prints the failure message on one line', async () => {
  await withWorker(async () => {
    const handle = await start('failed-one', { mode: 'failed', step: 'fixing', gate: 'done', failure: 'The fixer\nran out of budget.' });
    await handle.result().catch(() => undefined);
    const lines = await status('failed-one');
    assert.match(lines[1], /^  run: failed at /);
    assert.equal(lines[2], '  failure: The fixer ran out of budget.');
    assert.equal(lines[3], '  last state:');
  });
});
