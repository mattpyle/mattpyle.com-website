import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'cli.ts',
);

/**
 * The `scorecard-schedule` verb's argument guards, run through the real CLI.
 *
 * Every case here fails **before** `client()` is called, so no Temporal server
 * is needed and the test is safe on a machine with the stack down — which is
 * also the property that keeps it honest: a guard that only fires after a
 * connection attempt would hang here rather than pass.
 */

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('an unknown action is named, with the six that exist', async () => {
  const { code, out } = await runCli(['scorecard-schedule', 'describe']);
  assert.equal(code, 1);
  assert.match(out, /Unknown action "describe"/);
  assert.match(out, /status, create, pause, unpause, trigger, delete/);
});

test('a create-only option is refused on status too, so the read-only verb stays honest', async () => {
  const { code, out } = await runCli(['scorecard-schedule', 'status', '--at', '09:00']);
  assert.equal(code, 1);
  assert.match(out, /--at applies to `create` only/);
});

test('a create-only option on another verb is refused, not ignored', async () => {
  const { code, out } = await runCli(['scorecard-schedule', 'unpause', '--at', '09:00']);
  assert.equal(code, 1);
  assert.match(out, /--at applies to `create` only/);
});

test('--note is refused on a verb that records no note', async () => {
  const { code, out } = await runCli(['scorecard-schedule', 'trigger', '--note', 'why']);
  assert.equal(code, 1);
  assert.match(out, /--note applies to `pause` and `unpause` only/);
});

test('a malformed --at is rejected before anything is created', async () => {
  const { code, out } = await runCli(['scorecard-schedule', 'create', '--at', '25:00']);
  assert.equal(code, 1);
  assert.match(out, /--at must be a real time of day/);
});

test('the verb is listed in --help alongside the other scorecard verbs', async () => {
  const { code, out } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(out, /scorecard-schedule/);
});
