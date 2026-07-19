import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { syncWorktree, worktreeExists, needsInstall, recordInstall } from '../../src/lib/git.js';

const exec = promisify(execFile);

/**
 * Worktree sync, exercised against a throwaway git repo in the temp dir.
 *
 * A real repo rather than mocks: the behaviour under test is almost entirely
 * git's (detached worktrees, hard reset, clean), and a mocked `git` would only
 * assert that we call the commands we already decided to call.
 */

let repo: string;
let worktree: string;
const POST = 'src/content/writing/temp-post.md';

async function git(cwd: string, ...args: string[]) {
  await exec('git', args, { cwd });
}

before(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-wt-'));
  repo = path.join(base, 'repo');
  worktree = path.join(base, 'worktree');
  await fs.mkdir(path.join(repo, 'src', 'content', 'writing'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, POST), '---\ntitle: "committed"\n---\n', 'utf8');
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{"v":1}', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
});

after(async () => {
  await fs.rm(path.dirname(repo), { recursive: true, force: true }).catch(() => {});
});

test('creates a detached worktree on first sync', async () => {
  assert.equal(await worktreeExists(repo, worktree), false);

  const result = await syncWorktree(repo, worktree, POST);

  assert.equal(result.created, true);
  assert.equal(await worktreeExists(repo, worktree), true);
  // Detached on purpose: git refuses to check out a branch already checked out
  // in the primary tree, and the primary tree holds exactly the branch we want.
  const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree });
  assert.equal(stdout.trim(), 'HEAD');
});

test('reuses an existing worktree rather than recreating it', async () => {
  const result = await syncWorktree(repo, worktree, POST);
  assert.equal(result.created, false);
});

test('copies the UNCOMMITTED post file so the audit sees what the human has', async () => {
  // The whole point of step 1: the draft under review is normally not committed.
  const live = '---\ntitle: "uncommitted edit"\n---\n\nBody the human is still writing.\n';
  await fs.writeFile(path.join(repo, POST), live, 'utf8');

  await syncWorktree(repo, worktree, POST);

  assert.equal(await fs.readFile(path.join(worktree, POST), 'utf8'), live);
  // ...and the primary checkout is untouched by the sync.
  assert.equal(await fs.readFile(path.join(repo, POST), 'utf8'), live);
});

test('copies a post file that does not exist in HEAD at all', async () => {
  const brandNew = 'src/content/writing/never-committed.md';
  await fs.writeFile(path.join(repo, brandNew), '---\ntitle: "new"\n---\n', 'utf8');

  await syncWorktree(repo, worktree, brandNew);

  assert.match(await fs.readFile(path.join(worktree, brandNew), 'utf8'), /title: "new"/);
});

test('a hard reset discards edits made inside the worktree', async () => {
  const strayPath = path.join(worktree, 'src', 'content', 'writing', 'stray.md');
  await fs.writeFile(strayPath, 'left over from a previous audit', 'utf8');

  await syncWorktree(repo, worktree, POST);

  // `clean -fdx` must remove it, or the next audit builds last run's files.
  await assert.rejects(() => fs.stat(strayPath));
});

test('npm ci is required initially, then cached on an unchanged lockfile', async () => {
  const stateFile = path.join(os.tmpdir(), `steward-install-${Date.now()}.json`);

  // No node_modules yet.
  const first = await needsInstall(worktree, stateFile);
  assert.equal(first.needed, true);

  await fs.mkdir(path.join(worktree, 'node_modules'), { recursive: true });
  await recordInstall(stateFile, first.hash);

  const second = await needsInstall(worktree, stateFile);
  assert.equal(second.needed, false, 'unchanged lockfile should not reinstall');

  // Changing the lockfile invalidates the cache.
  await fs.writeFile(path.join(worktree, 'package-lock.json'), '{"v":2}', 'utf8');
  const third = await needsInstall(worktree, stateFile);
  assert.equal(third.needed, true);
  assert.notEqual(third.hash, second.hash);

  await fs.rm(stateFile, { force: true });
});
