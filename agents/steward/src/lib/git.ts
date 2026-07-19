import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './proc.js';

/**
 * Worktree management for the build audit (spec §8.5 step 1).
 *
 * The audit needs a checkout it can `npm ci` into, build with `SHOW_DRAFTS=true`,
 * and serve — none of which may happen in the human's working directory while
 * they are editing. A dedicated `git worktree` gives an isolated checkout that
 * still shares the object store, so syncing it is a reset rather than a clone.
 *
 * The subtlety that makes this correct: **the post under review is usually
 * uncommitted.** A worktree reset to HEAD would audit a version of the draft the
 * author has never seen, or no draft at all. So after syncing, the post file is
 * copied byte-for-byte from the primary checkout. The audit reports on what the
 * human actually has on disk.
 */

/** Absolute path to a git binary. `git` is resolved from PATH by execFile. */
const GIT = 'git';

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await run(GIT, args, { cwd });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

export async function currentBranch(repoDir: string): Promise<string> {
  return git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function headSha(repoDir: string): Promise<string> {
  return git(repoDir, ['rev-parse', 'HEAD']);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** True if `dir` is registered as a worktree of `repoDir`. */
export async function worktreeExists(repoDir: string, dir: string): Promise<boolean> {
  const list = await git(repoDir, ['worktree', 'list', '--porcelain']);
  const target = path.resolve(dir);
  return list
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .some((l) => path.resolve(l.slice('worktree '.length).trim()) === target);
}

export interface SyncResult {
  worktreeDir: string;
  /** The commit the worktree was reset to. */
  sha: string;
  /** True if the worktree had to be created rather than reused. */
  created: boolean;
  /** Repo-relative path of the post file copied in from the primary checkout. */
  postFile: string;
}

/**
 * Ensures `worktreeDir` exists and matches the primary checkout's HEAD, then
 * overlays the (possibly uncommitted) post file.
 *
 * Detached HEAD, deliberately: a worktree may not check out a branch that is
 * already checked out in the primary tree, and the primary tree is exactly the
 * branch we want. Resetting to the *commit* sidesteps the restriction entirely
 * and is the more honest description of what this checkout is — a disposable
 * snapshot, not a place work happens.
 */
export async function syncWorktree(
  repoDir: string,
  worktreeDir: string,
  postRelPath: string,
): Promise<SyncResult> {
  const sha = await headSha(repoDir);
  let created = false;

  if (!(await worktreeExists(repoDir, worktreeDir))) {
    // A leftover directory from a previously pruned/aborted worktree would make
    // `worktree add` fail; clear it first, then let git recreate it.
    if (await exists(worktreeDir)) {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    }
    await git(repoDir, ['worktree', 'add', '--detach', worktreeDir, sha]);
    created = true;
  } else {
    await git(worktreeDir, ['reset', '--hard', sha]);
    // `-d` removes untracked *directories* too. Without it a stale `dist/` from
    // the previous audit survives and the next build can serve last run's HTML.
    // `-e` keeps node_modules so the npm ci cache is not defeated every run.
    await git(worktreeDir, ['clean', '-fdx', '-e', 'node_modules']);
  }

  // Overlay the live post file. It may be uncommitted, or committed-but-modified;
  // either way the bytes on the human's disk are the bytes that get audited.
  const src = path.join(repoDir, postRelPath);
  const dest = path.join(worktreeDir, postRelPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);

  return { worktreeDir, sha, created, postFile: postRelPath };
}

/**
 * True if `npm ci` must run: no `node_modules`, or the lockfile changed since
 * the last successful install into this worktree.
 */
export async function needsInstall(
  worktreeDir: string,
  stateFile: string,
): Promise<{ needed: boolean; hash: string }> {
  const lock = await fs.readFile(path.join(worktreeDir, 'package-lock.json'));
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(lock).digest('hex');

  if (!(await exists(path.join(worktreeDir, 'node_modules')))) return { needed: true, hash };
  try {
    const prev = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { lockfileSha256?: string };
    return { needed: prev.lockfileSha256 !== hash, hash };
  } catch {
    return { needed: true, hash };
  }
}

export async function recordInstall(stateFile: string, hash: string): Promise<void> {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ lockfileSha256: hash }, null, 2), 'utf8');
}
