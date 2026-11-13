/**
 * One copy of the workflow runtime. Two copies of `@temporalio/workflow` in one bundle is the
 * mixed-install failure the Temporal docs warn about, and it is what an npm workspace on an older
 * SDK produced for this harness. The lockfile and the built bundle are both checked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { bundleWorkflowCode } from '@temporalio/worker';
import { AgentHarnessPlugin } from '@temporalio/agent-harness-worker';
import { StrandsPlugin } from '@temporalio/agent-harness-worker/ai-sdks/strands-agents';
import { bundlerOptions } from '../src/sdk-compat.js';
import { workflowsPath } from '../src/worker.js';

test('the lockfile holds one @temporalio/workflow, at the version Steward pins', () => {
  const lock = JSON.parse(fs.readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
  const steward = JSON.parse(fs.readFileSync(new URL('../../steward/package.json', import.meta.url), 'utf8'));
  const own = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const paths = Object.keys(lock.packages).filter((p) => p.endsWith('node_modules/@temporalio/workflow'));
  assert.deepEqual(paths, ['node_modules/@temporalio/workflow']);
  assert.equal(lock.packages[paths[0]!].version, steward.dependencies['@temporalio/workflow']);
  for (const [name, version] of Object.entries<string>(own.dependencies)) {
    if (name.startsWith('@temporalio/') && !name.startsWith('@temporalio/agent-harness')) {
      assert.equal(version, steward.dependencies['@temporalio/workflow'], name);
    }
  }
});

test('the workflow bundle loads @temporalio/workflow from one place', async () => {
  const { code } = await bundleWorkflowCode({
    workflowsPath,
    webpackConfigHook: bundlerOptions.webpackConfigHook,
    plugins: [new StrandsPlugin(), new AgentHarnessPlugin()],
  });
  // Webpack names each module by its path. Collect what precedes every `@temporalio/workflow/lib/`
  // back to the start of that path: one copy means one prefix.
  const needle = 'node_modules/@temporalio/workflow/lib/';
  const roots = new Set<string>();
  for (let i = code.indexOf(needle); i >= 0; i = code.indexOf(needle, i + needle.length)) {
    const before = code.slice(Math.max(0, i - 200), i);
    const start = Math.max(before.lastIndexOf('"'), before.lastIndexOf("'"), before.lastIndexOf(' '));
    roots.add(before.slice(start + 1));
  }
  assert.ok(roots.size > 0, 'the bundle names its modules by path');
  assert.equal(roots.size, 1, `copies found under: ${[...roots].join(', ')}`);
});
