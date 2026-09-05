import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './proc.js';
// Circular by design and safe: `post-payload.ts` imports `git()` and
// `defaultBranch()` from here, and both modules touch each other only from
// inside hoisted function bodies, never at module evaluation. The alternative —
// resolving the payload in every caller and passing it in — would let a caller
// overlay a set the resolver never named, which is the drift this build exists
// to remove.
import { resolvePostPayload, type PostPayload } from './post-payload.js';

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

/**
 * Runs git in `cwd` and returns trimmed stdout, throwing on a non-zero exit with
 * git's own stderr attached.
 *
 * Exported so the publish leg (§8.7) drives branches, commits, and pushes
 * through the same wrapper the build audit uses, rather than growing a second
 * spawn path with its own error handling.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
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

/**
 * How git sees one path in the working tree.
 *
 * The distinction that matters to every caller here is `untracked` vs
 * `uncommitted`: an untracked file exists only on disk, so deleting it is a
 * decision about disk alone, while a staged or modified file also exists in the
 * index or in a commit and deleting it throws away something git was holding.
 *
 * `unknown` rather than a throw when git itself fails: the callers are a review
 * check and an operator command, and neither should turn "this checkout isn't a
 * git repo" into a failure of the thing they were actually asked to do.
 */
export type PathState = 'untracked' | 'uncommitted' | 'clean' | 'unknown';

export async function pathState(repoDir: string, relPath: string): Promise<PathState> {
  let out: string;
  try {
    // `--` so a path that looks like a revision cannot be read as one.
    out = await git(repoDir, ['status', '--porcelain', '--', relPath]);
  } catch {
    return 'unknown';
  }
  if (!out.trim()) return 'clean';
  // Porcelain v1: two status columns, then a space, then the path.
  return out.startsWith('??') ? 'untracked' : 'uncommitted';
}

/**
 * The default branch, read from `origin/HEAD`.
 *
 * Deliberately git-local rather than the GitHub API: this is consumed by an
 * operator command that must work without `GITHUB_TOKEN` and without a network
 * round-trip, and a clone sets `origin/HEAD` for free. Returns `null` when the
 * ref is missing (some older clones), so the caller can say so rather than
 * guessing a branch name and acting on the guess.
 */
export async function defaultBranch(repoDir: string): Promise<string | null> {
  try {
    const ref = await git(repoDir, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
    const name = ref.replace(/^origin\//, '').trim();
    return name || null;
  } catch {
    return null;
  }
}

/** A merge, rebase, cherry-pick, revert or bisect the human has not finished. */
export async function inProgressOperation(repoDir: string): Promise<string | null> {
  let gitDir: string;
  try {
    gitDir = await git(repoDir, ['rev-parse', '--absolute-git-dir']);
  } catch {
    return null;
  }
  const markers: [string, string][] = [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect'],
  ];
  for (const [marker, label] of markers) {
    if (await exists(path.join(gitDir, marker))) return label;
  }
  return null;
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
  /** Every repo-relative path copied in, post first. */
  copied: string[];
  /** The resolved payload, so the caller can report what travelled. */
  payload: PostPayload;
}

/**
 * Ensures `worktreeDir` exists and matches the primary checkout's HEAD, then
 * overlays the (possibly uncommitted) post **and everything it needs**.
 *
 * Detached HEAD, deliberately: a worktree may not check out a branch that is
 * already checked out in the primary tree, and the primary tree is exactly the
 * branch we want. Resetting to the *commit* sidesteps the restriction entirely
 * and is the more honest description of what this checkout is — a disposable
 * snapshot, not a place work happens.
 *
 * The overlay used to be one file. A draft's hero image, body images and any
 * `public/` media it names are untracked in the author's checkout exactly as the
 * draft is, so the reset tree held none of them and the build failed on the
 * first reference it could not resolve. `resolvePostPayload` names the whole set
 * and every file in it is overlaid the same way the post always was: the bytes
 * on the human's disk win, committed-but-modified included.
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

  // Overlay the live payload. Any of it may be uncommitted, or
  // committed-but-modified; either way the bytes on the human's disk are the
  // bytes that get audited.
  const payload = await resolvePostPayload(repoDir, postRelPath);
  for (const rel of payload.files) {
    const dest = path.join(worktreeDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(repoDir, rel), dest);
  }

  return { worktreeDir, sha, created, postFile: postRelPath, copied: payload.files, payload };
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
