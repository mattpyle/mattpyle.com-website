import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { NO_SITE_DIR, resolveSiteDir } from '../../src/lib/site-dir.js';

/**
 * `resolveSiteDir` decides which content tree a process reads. The empty default belongs
 * to test processes alone: a false yes would point a worker or the CLI at an empty
 * directory, so every production start shape is pinned here.
 */

const ROOT = path.resolve('/repo');
const shape = (argv1: string, execArgv: string[] = [], env: Record<string, string | undefined> = {}) => ({
  argv: ['node', argv1],
  execArgv,
  env,
});

test('the CLI, the workers and the console launcher read the repository root', () => {
  for (const script of ['src/cli.ts', 'src/worker.ts', 'src/worker-hosted.ts', 'src/hosted-entry.ts', 'scripts/steward.mjs', '']) {
    assert.equal(resolveSiteDir(ROOT, shape(script, ['--import', 'tsx'], { NODE_ENV: 'production' })), ROOT, script);
  }
  assert.equal(resolveSiteDir(ROOT, shape('src/cli.ts', [], { NODE_TEST_CONTEXT: '', STEWARD_SITE_DIR: '' })), ROOT);
});

test('a test process with no STEWARD_SITE_DIR reads an empty directory, not the checkout', () => {
  assert.equal(resolveSiteDir(ROOT, shape('tests/lib/a.test.ts')), NO_SITE_DIR);
  assert.equal(resolveSiteDir(ROOT, shape('', ['--test'])), NO_SITE_DIR);
  // A CLI that a test spawned inherits the runner's context.
  assert.equal(resolveSiteDir(ROOT, shape('src/cli.ts', [], { NODE_TEST_CONTEXT: 'child-v8' })), NO_SITE_DIR);
  assert.notEqual(NO_SITE_DIR, ROOT);
});

test('an explicit STEWARD_SITE_DIR wins in every process', () => {
  const site = path.resolve('/somewhere/else');
  for (const env of [{ STEWARD_SITE_DIR: site }, { STEWARD_SITE_DIR: site, NODE_TEST_CONTEXT: 'child-v8' }]) {
    assert.equal(resolveSiteDir(ROOT, shape('src/cli.ts', [], env)), site);
  }
  assert.equal(resolveSiteDir(ROOT, shape('tests/lib/a.test.ts', ['--test'], { STEWARD_SITE_DIR: site })), site);
});

test('this process, a test, resolved the empty directory through config.ts', async () => {
  if (process.env.STEWARD_SITE_DIR) return; // an outer override wins, as it should
  const { SITE_DIR, REPO_ROOT } = await import('../../src/config.js');
  assert.equal(SITE_DIR, NO_SITE_DIR);
  assert.notEqual(SITE_DIR, REPO_ROOT);
});
