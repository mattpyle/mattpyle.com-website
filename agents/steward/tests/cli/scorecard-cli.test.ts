import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.ts');

/**
 * `steward scorecard`'s argument guards, run through the real CLI.
 *
 * Every case here fails **before** `client()` is called, which is the point as
 * well as what makes the test safe with the stack down: the timeless-commentary
 * rule is enforced again inside `publishScorecardRun`, but reaching that backstop
 * costs a full twelve-minute audit first. A typo in `--note` should cost
 * milliseconds.
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

test('a present-relative --note is refused before the audit starts', async () => {
  const { code, out } = await runCli([
    'scorecard',
    '--dry-run',
    '--note',
    'Re-run to confirm the currently published numbers',
  ]);
  assert.equal(code, 1);
  assert.match(out, /--note reads as present-relative/);
  assert.match(out, /currently/);
  // The guard has to fire before anything reaches Temporal, or it is not saving
  // the twelve minutes it exists to save.
  assert.doesNotMatch(out, /starting scorecard audit/);
});

test('an empty --note is refused rather than silently ignored', async () => {
  const { code, out } = await runCli(['scorecard', '--note', '   ']);
  assert.equal(code, 1);
  assert.match(out, /--note needs some text/);
});

test('--note is listed in the help for scorecard', async () => {
  const { code, out } = await runCli(['scorecard', '--help']);
  assert.equal(code, 0);
  assert.match(out, /--note <text>/);
});
