import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', '..', 'src', 'cli.ts');

/**
 * `steward credential rotate`, through the real CLI, for the cases that make no
 * call: an unknown name and `--dry-run`. The steps themselves are tested against
 * fakes in `tests/lib/credential-rotate.test.ts`.
 */

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: path.resolve(HERE, '..', '..'),
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('an unknown credential is named, with the two that exist', async () => {
  const { code, out } = await runCli(['credential', 'rotate', 'github-token']);
  assert.equal(code, 1);
  assert.match(out, /github-token is not a credential this command rotates/);
  assert.match(out, /temporal-metrics, healthcheck-base/);
});

test('--dry-run prints the seven-step plan for each credential and exits 0', async () => {
  for (const name of ['temporal-metrics', 'healthcheck-base']) {
    const { code, out } = await runCli(['credential', 'rotate', name, '--dry-run']);
    assert.equal(code, 0, out);
    assert.ok(out.includes(`Plan for ${name} (dry run, no call is made)`), out);
    for (const step of ['1. issue', '2. store', '3. push', '4. env', '5. wait', '6. verify', '7. retire']) {
      assert.ok(out.includes(step), `${name} plan has ${step}`);
    }
  }
});

test('a bad --duration is refused before any call', async () => {
  const { code, out } = await runCli(['credential', 'rotate', 'temporal-metrics', '--duration', 'soon']);
  assert.equal(code, 1);
  assert.match(out, /--duration soon is not a duration/);
});
