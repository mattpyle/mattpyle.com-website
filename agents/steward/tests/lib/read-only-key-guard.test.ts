import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readOnlyKeyRefusal } from '../../src/lib/read-only-key-guard.js';

const exec = promisify(execFile);
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(STEWARD, 'src', 'cli.ts');

/**
 * `steward up` refuses to start with the read-only key in
 * `TEMPORAL_API_KEY`. The comparison is a pure function; the CLI case proves the
 * verb calls it before it does anything else.
 *
 * The stand-in key is built at run time: the gitleaks job scans full history.
 */
const KEY = ['stand', 'in', 'key'].join('-') + '-' + 'x'.repeat(24);

test('the same value in both variables is refused, naming TEMPORAL_API_KEY', () => {
  const message = readOnlyKeyRefusal({ TEMPORAL_API_KEY: KEY, TEMPORAL_READ_ONLY_API_KEY: KEY });
  assert.ok(message);
  assert.match(message, /TEMPORAL_API_KEY/);
  assert.match(message, /TEMPORAL_READ_ONLY_API_KEY/);
  assert.match(message, /Remove-Item Env:TEMPORAL_API_KEY/);
  // The refusal never echoes the key itself.
  assert.ok(!message.includes(KEY));
});

test('different keys, an unset read-only key and an empty pair all pass', () => {
  assert.equal(readOnlyKeyRefusal({ TEMPORAL_API_KEY: KEY, TEMPORAL_READ_ONLY_API_KEY: `${KEY}-other` }), null);
  assert.equal(readOnlyKeyRefusal({ TEMPORAL_API_KEY: KEY }), null);
  assert.equal(readOnlyKeyRefusal({ TEMPORAL_READ_ONLY_API_KEY: KEY }), null);
  assert.equal(readOnlyKeyRefusal({ TEMPORAL_API_KEY: '', TEMPORAL_READ_ONLY_API_KEY: '' }), null);
  assert.equal(readOnlyKeyRefusal({}), null);
});

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  // The fence for a guard that stops working: with no PATH the child cannot find
  // `git`, `powershell` or `temporal`, so a verb that got past the guard would
  // fail at its first spawn instead of pulling or restarting anything real.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'path') delete env[name];
  env.PATH = path.join(os.tmpdir(), 'steward-no-such-bin');
  env.TEMPORAL_API_KEY = KEY;
  env.TEMPORAL_READ_ONLY_API_KEY = KEY;
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: STEWARD,
      env,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

for (const verb of ['up']) {
  test(`steward ${verb} exits before connecting when TEMPORAL_API_KEY is the read-only key`, async () => {
    const { code, out } = await runCli([verb]);
    assert.equal(code, 1);
    assert.match(out, /Refusing to start: TEMPORAL_API_KEY is set to the same value as TEMPORAL_READ_ONLY_API_KEY/);
    assert.ok(!out.includes(KEY));
  });
}
