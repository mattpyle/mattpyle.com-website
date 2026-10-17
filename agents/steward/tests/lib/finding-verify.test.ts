import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowNotFoundError } from '@temporalio/client';
import { cancelLifecycleRun, type LifecycleRunHandle } from '../../src/lib/finding-verify.js';

/** After a hand verify resolves a finding, its open lifecycle run is cancelled; a closed or missing one is left alone. */

const ID = 'finding/mattpyle-com/ux-more-menu-never-closes--sitewide';

function fakeRun(status: string | 'missing', closes = true) {
  const calls: string[] = [];
  const handle: LifecycleRunHandle = {
    workflowId: ID,
    describe: async () => {
      calls.push('describe');
      if (status === 'missing') throw new WorkflowNotFoundError('not found', ID, undefined);
      return { status: { name: status } };
    },
    cancel: async () => {
      calls.push('cancel');
    },
    result: () => {
      calls.push('result');
      return closes ? Promise.reject(new Error('Workflow cancelled')) : new Promise(() => {});
    },
  };
  return { handle, calls };
}

test('an open run is cancelled, and the call waits for it to close', async () => {
  const run = fakeRun('RUNNING');
  assert.equal(await cancelLifecycleRun(run.handle), 'cancelled');
  assert.deepEqual(run.calls, ['describe', 'cancel', 'result']);
});

test('a closed run and a missing one are left alone', async () => {
  for (const status of ['COMPLETED', 'CANCELLED', 'FAILED', 'missing']) {
    const run = fakeRun(status);
    assert.equal(await cancelLifecycleRun(run.handle), 'none', status);
    assert.deepEqual(run.calls, ['describe'], status);
  }
});

test('a run that does not close in time is reported as requested, not cancelled', async () => {
  const run = fakeRun('RUNNING', false);
  assert.equal(await cancelLifecycleRun(run.handle, 20), 'requested');
  assert.deepEqual(run.calls, ['describe', 'cancel', 'result']);
});
