import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { FULL, SHORT, findingStore } from '../helpers/finding-key-fixtures.js';
import { createLocalEnv } from '../helpers/test-env.js';

const exec = promisify(execFile);
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(STEWARD, 'src', 'cli.ts');

/**
 * Both forms of a finding key through the real CLI, one command of each family:
 * `finding approve`, which needs the full key for its workflow ID, and
 * `fix-log confirm`, which needs the short key and the finding file. The child
 * process holds the fake GitHub and a local dev server with no finding run, so
 * each command's own answer names the key it resolved.
 */

let env: TestWorkflowEnvironment;
before(async () => {
  env = await createLocalEnv();
});
after(async () => {
  await env?.teardown();
});

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  const imports = ['tsx', './tests/helpers/no-real-credentials.ts', './tests/helpers/fake-github-preload.ts'];
  try {
    const { stdout, stderr } = await exec(process.execPath, [...imports.flatMap((i) => ['--import', i]), CLI, ...args], {
      cwd: STEWARD,
      env: {
        ...process.env,
        TEMPORAL_ADDRESS: env.address,
        TEMPORAL_NAMESPACE: 'default',
        STEWARD_FAKE_GITHUB_SEED: JSON.stringify(findingStore()),
      },
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('finding approve reaches the same workflow from the short key, either case, and the full key', async () => {
  for (const key of [SHORT, SHORT.toLowerCase(), FULL]) {
    const { code, out } = await runCli(['finding', 'approve', key]);
    assert.equal(code, 1, key);
    assert.match(out, new RegExp(`No open workflow finding/mattpyle-com/${FULL}\\.`), key);
  }
});

test('fix-log confirm takes the full key and the short key', async () => {
  for (const key of [SHORT.toLowerCase(), FULL]) {
    const { code, out } = await runCli(['fix-log', 'confirm', key]);
    assert.equal(code, 0, out);
    // No entry is seeded: the path named is the short key's.
    assert.match(out, /skipped: src\/content\/fixes\/mp-901\.md is not on main/, key);
  }
});

test('an unknown short key fails both families, naming the key and the site', async () => {
  for (const args of [['finding', 'approve', 'mp-999'], ['fix-log', 'confirm', 'MP-999']]) {
    const { code, out } = await runCli(args);
    assert.equal(code, 1, args.join(' '));
    assert.match(out, /No finding with key MP-999 in site mattpyle-com\./);
  }
});
