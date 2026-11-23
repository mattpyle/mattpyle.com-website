import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(STEWARD, 'src', 'cli.ts');

/**
 * `steward finding`: the argument guards through the real CLI, every one of
 * which fails before `client()` so no server is needed.
 */

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: STEWARD });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('a key that could traverse is refused before anything connects', async () => {
  const { code, out } = await runCli(['finding', 'approve', '../../etc']);
  assert.equal(code, 1);
  assert.match(out, /Invalid key/);
});

test('fix refuses a key or a site that could traverse, before anything connects', async () => {
  const key = await runCli(['finding', 'fix', '../../etc']);
  assert.equal(key.code, 1);
  assert.match(key.out, /Invalid key/);
  const site = await runCli(['finding', 'fix', 'some-key', '--site', 'a/b']);
  assert.equal(site.code, 1);
  assert.match(site.out, /Invalid site/);
});

test('verify takes one key or --all-fixing, never both or neither, and refuses before anything connects', async () => {
  const neither = await runCli(['finding', 'verify']);
  assert.equal(neither.code, 1);
  assert.match(neither.out, /Give one finding key, or --all-fixing/);
  const both = await runCli(['finding', 'verify', 'some-key', '--all-fixing']);
  assert.equal(both.code, 1);
  assert.match(both.out, /Give one finding key, or --all-fixing/);
  const key = await runCli(['finding', 'verify', '../../etc']);
  assert.equal(key.code, 1);
  assert.match(key.out, /Invalid key/);
  // The checks run against one origin, and the origin is this site's.
  const site = await runCli(['finding', 'verify', 'some-key', '--site', 'temporal-io']);
  assert.equal(site.code, 1);
  assert.match(site.out, /production origin of mattpyle-com only, not temporal-io/);
});

test('verify --pr takes one key and a pull request URL, and --reason must say something, all before anything connects', async () => {
  const notPr = await runCli(['finding', 'verify', 'some-key', '--pr', 'https://github.com/mattpyle/mattpyle.com-website/issues/356']);
  assert.equal(notPr.code, 1);
  assert.match(notPr.out, /is not a GitHub pull request URL/);
  const all = await runCli(['finding', 'verify', '--all-fixing', '--pr', 'https://github.com/mattpyle/mattpyle.com-website/pull/356']);
  assert.equal(all.code, 1);
  assert.match(all.out, /--pr names the fix of one finding/);
  const blank = await runCli(['finding', 'verify', 'some-key', '--reason', '  ']);
  assert.equal(blank.code, 1);
  assert.match(blank.out, /--reason must say something/);
});

test('verify --root takes scratch/<name> and one key, all before anything connects', async () => {
  for (const root of ['sites', 'scratch', 'scratch/../sites', 'tmp/verify-1', '/scratch/verify-1']) {
    const bad = await runCli(['finding', 'verify', 'some-key', '--root', root]);
    assert.equal(bad.code, 1, root);
    assert.match(bad.out, /is not scratch\/<name>/, root);
  }
  const all = await runCli(['finding', 'verify', '--all-fixing', '--root', 'scratch/verify-1']);
  assert.equal(all.code, 1);
  assert.match(all.out, /--root verifies one scratch copy/);
  const pr = await runCli([
    'finding', 'verify', 'some-key', '--root', 'scratch/verify-1',
    '--pr', 'https://github.com/mattpyle/mattpyle.com-website/pull/356',
  ]);
  assert.equal(pr.code, 1);
  assert.match(pr.out, /--root verifies one scratch copy/);
});

test('the spike verb is gone: the fixer starts from a finding, not a handoff path', async () => {
  const { code, out } = await runCli(['fixer', 'spike', 'docs/handoffs/x.md']);
  assert.equal(code, 1);
  assert.match(out, /unknown command 'fixer'/);
});

test('reject needs a reason', async () => {
  const { code, out } = await runCli(['finding', 'reject', 'some-key']);
  assert.equal(code, 1);
  assert.match(out, /--reason/);
});

test('the finding verbs are listed in help', async () => {
  const { code, out } = await runCli(['finding', '--help']);
  assert.equal(code, 0);
  for (const verb of ['list', 'status', 'approve', 'reject', 'fix']) {
    assert.match(out, new RegExp(`\\b${verb}\\b`));
  }
  // Steward starts no finding's workflow by scanning an index: the reconciler's verbs are gone.
  for (const verb of ['schedule', 'sync']) {
    assert.doesNotMatch(out, new RegExp(`^\\s+${verb}\\b`, 'm'));
  }
});
