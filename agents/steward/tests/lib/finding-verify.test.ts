import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowNotFoundError } from '@temporalio/client';
import {
  VerifyRefused,
  buildVerifyInput,
  cancelLifecycleRun,
  parseScratchRoot,
  recordHandFix,
  verifyFindingPaths,
  type HandFixDeps,
  type LifecycleRunHandle,
} from '../../src/lib/finding-verify.js';

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

/** `verify --pr`: an approved finding fixed outside its run is written fixing with a merged PR, and nothing else is. */

const KEY = 'agent-readiness-list-items-run-into-one-paragraph--writing-md';
const PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/359';

function handFix(status: string, pr: 'open' | 'merged' | 'closed') {
  const calls: string[] = [];
  const deps: HandFixDeps = {
    repo: 'mattpyle/argus',
    readFinding: async (path) => {
      calls.push(`read ${path}`);
      return { data: { status } };
    },
    readPr: async (url) => {
      calls.push(`pr ${url}`);
      return pr;
    },
    writeFix: async (input) => {
      calls.push(`write ${input.findingPath} ${input.indexPath} ${input.prUrl}`);
      return { commitSha: 'c-fix' };
    },
  };
  return { deps, calls };
}

test('an approved finding with a merged PR is written fixing with that PR, as the lifecycle writes it', async () => {
  const { deps, calls } = handFix('approved', 'merged');
  assert.deepEqual(await recordHandFix(deps, 'mattpyle-com', KEY, PR), { commitSha: 'c-fix' });
  assert.deepEqual(calls, [
    `read sites/mattpyle-com/findings/${KEY}.md`,
    `pr ${PR}`,
    `write sites/mattpyle-com/findings/${KEY}.md sites/mattpyle-com/findings/INDEX.md ${PR}`,
  ]);
});

test('--pr refuses any status but approved, a PR that is not merged, and a URL that is not a PR, writing nothing', async () => {
  for (const status of ['fixing', 'reopened', 'resolved', 'proposed']) {
    const { deps, calls } = handFix(status, 'merged');
    await assert.rejects(recordHandFix(deps, 'mattpyle-com', KEY, PR), (err: Error) => {
      assert.ok(err instanceof VerifyRefused);
      assert.match(err.message, new RegExp(`is ${status}, not approved`));
      return true;
    });
    assert.ok(!calls.some((c) => c.startsWith('write')), `${status} wrote nothing`);
  }
  for (const pr of ['open', 'closed'] as const) {
    const { deps, calls } = handFix('approved', pr);
    await assert.rejects(recordHandFix(deps, 'mattpyle-com', KEY, PR), new RegExp(`pull/359 is ${pr}, not merged`));
    assert.ok(!calls.some((c) => c.startsWith('write')));
  }
  const { deps, calls } = handFix('approved', 'merged');
  await assert.rejects(recordHandFix(deps, 'mattpyle-com', KEY, 'https://github.com/mattpyle/mattpyle.com-website/issues/359'), /not a GitHub pull request URL/);
  assert.deepEqual(calls, [], 'nothing is read for a URL that is not a PR');
});

test('a verify run reads and writes the real store by default, and the scratch copy under --root', () => {
  assert.deepEqual(verifyFindingPaths('mattpyle-com', KEY), {
    findingPath: `sites/mattpyle-com/findings/${KEY}.md`,
    indexPath: 'sites/mattpyle-com/findings/INDEX.md',
  });
  assert.deepEqual(verifyFindingPaths('mattpyle-com', KEY, parseScratchRoot('scratch/verify-cli/')), {
    findingPath: `scratch/verify-cli/sites/mattpyle-com/findings/${KEY}.md`,
    indexPath: 'scratch/verify-cli/sites/mattpyle-com/findings/INDEX.md',
  });
});

test('a root is scratch and then slugs, so it can never name the real store', () => {
  assert.equal(parseScratchRoot('scratch/a/b-2'), 'scratch/a/b-2');
  for (const root of ['', 'scratch', 'scratch/', 'sites/mattpyle-com', 'scratch/../sites', 'scratch/A', '/scratch/a', 'scratch//a']) {
    assert.throws(() => parseScratchRoot(root), VerifyRefused, root);
  }
});

test('under --root, the workflow input carries the scratch paths and nothing else changes', () => {
  const base = { site: 'mattpyle-com', key: KEY, repo: 'mattpyle/argus', origin: 'https://www.mattpyle.com', at: '2026-10-17T06:26:59.000Z' };
  const real = buildVerifyInput(base);
  assert.deepEqual(real, { ...base, findingPath: `sites/mattpyle-com/findings/${KEY}.md`, indexPath: 'sites/mattpyle-com/findings/INDEX.md' });
  const scratch = buildVerifyInput({ ...base, reason: 'scratch run', root: parseScratchRoot('scratch/verify-cli') });
  assert.deepEqual(scratch, {
    ...base,
    findingPath: `scratch/verify-cli/sites/mattpyle-com/findings/${KEY}.md`,
    indexPath: 'scratch/verify-cli/sites/mattpyle-com/findings/INDEX.md',
    reason: 'scratch run',
  });
  assert.ok(!Object.values(scratch).some((v) => typeof v === 'string' && v.startsWith('sites/')), 'no path in the input names the real store');
});
