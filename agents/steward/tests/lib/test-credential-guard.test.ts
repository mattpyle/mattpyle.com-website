import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  guardTestCredentials,
  isTestProcess,
  TEST_GUARD_MARKER,
  TEST_GUARDED_VARIABLES,
} from '../../src/lib/test-credential-guard.js';

/**
 * The detection decides whether a process loses its credentials, so each signal is pinned
 * here, and so is every production start shape: a false yes would blank a worker's keys.
 */

const shape = (argv1: string, execArgv: string[] = [], env: Record<string, string | undefined> = {}) => ({
  argv: ['node', argv1],
  execArgv,
  env,
});

test('NODE_TEST_CONTEXT marks a test process, whatever the script', () => {
  assert.equal(isTestProcess(shape('/app/agents/steward/src/cli.ts', [], { NODE_TEST_CONTEXT: 'child-v8' })), true);
});

test('--test in execArgv marks a test process', () => {
  assert.equal(isTestProcess(shape('', ['--import', 'tsx', '--test', '--test-isolation=none'])), true);
});

test('a *.test.* script run directly marks a test process', () => {
  for (const name of ['a.test.ts', 'a.test.mts', 'a.test.cts', 'a.test.js', 'a.test.mjs', 'C:\\repo\\tests\\lib\\a.test.ts']) {
    assert.equal(isTestProcess(shape(name)), true, name);
  }
});

test('a worker or CLI start is not a test process', () => {
  for (const script of ['src/worker.ts', 'src/worker-hosted.ts', 'src/cli.ts', 'scripts/steward.mjs', 'src/lib/test-credential-guard.ts', 'latest.ts']) {
    assert.equal(isTestProcess(shape(script, ['--import', 'tsx'], { NODE_ENV: 'production' })), false, script);
  }
  // Flags that only look like the runner's, an empty context and no script at all.
  assert.equal(isTestProcess(shape('src/worker.ts', ['--test-timeout=1', '--testing'], { NODE_TEST_CONTEXT: '' })), false);
  assert.equal(isTestProcess({ argv: ['node'], execArgv: [], env: {} }), false);
});

test('outside a test process the guard changes nothing', () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'kept', GITHUB_TOKEN: 'kept' };
  assert.equal(guardTestCredentials(shape('src/worker.ts', [], env)), false);
  assert.deepEqual(env, { ANTHROPIC_API_KEY: 'kept', GITHUB_TOKEN: 'kept' });
});

test('in a test process every guarded variable is blanked, set or not', () => {
  const env: Record<string, string | undefined> = { NODE_TEST_CONTEXT: 'child-v8', GITHUB_TOKEN: 'from-shell', OTHER: 'kept' };
  assert.equal(guardTestCredentials(shape('a.test.ts', [], env)), true);
  for (const name of TEST_GUARDED_VARIABLES) assert.equal(env[name], '', name);
  assert.equal(env.OTHER, 'kept');
  assert.equal(env[TEST_GUARD_MARKER], '1');
});

test('the guard blanks once: a value set after the first call survives the second', () => {
  const env: Record<string, string | undefined> = { NODE_TEST_CONTEXT: 'child-v8' };
  guardTestCredentials(shape('a.test.ts', [], env));
  env.STEWARD_GITHUB_APP_ID = 'fake-app';
  // The second call stands for `config.ts` after the `--import`, and for a child CLI that inherits the marker.
  assert.equal(guardTestCredentials(shape('src/cli.ts', [], env)), true);
  assert.equal(env.STEWARD_GITHUB_APP_ID, 'fake-app');
});

test('the list covers the GitHub, model and preview credentials', () => {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'STEWARD_GITHUB_APP_PRIVATE_KEY', 'ANTHROPIC_API_KEY', 'VERCEL_AUTOMATION_BYPASS_SECRET']) {
    assert.ok(TEST_GUARDED_VARIABLES.includes(name), name);
  }
});
