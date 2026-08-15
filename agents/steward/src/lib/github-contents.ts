import { ApplicationFailure } from '@temporalio/activity';
import { GITHUB_REPO } from '../config.js';
import { gh } from './github.js';

/**
 * The repo-write primitives the Scorecard's persistence runs on, over the
 * GitHub REST API rather than a local git worktree.
 *
 * **Why this exists at all.** `publishScorecardRun` and `archiveScorecardRun`
 * used to drive git in `WORKTREE_DIR`, which made them local activities: they
 * needed a checkout, so they needed the laptop, so the whole scorecard run
 * needed the laptop. That is what kept the daily Schedule laptop-bound. Every
 * one of those git operations was really "read a file on master, write a file
 * on a branch, open a PR" — three things the API does directly — so the
 * checkout was never the requirement, only the credential was
 * (always-on-audit-worker card, leg 2b).
 *
 * The trade is deliberate and worth naming: a worktree gives you the whole repo
 * atomically, and this gives you one file per call. That is fine here because
 * every write the Scorecard makes is a single append-only JSON file, and it is
 * the reason nothing else in Steward has been moved onto these helpers.
 * `publishPost` still drives a worktree, because publishing a post is a
 * multi-file change that wants to be one commit.
 *
 * The Contents API is used rather than the Git Data API (blob → tree → commit →
 * ref) for the same reason `github.ts` uses `fetch` rather than `octokit`: one
 * file per commit is exactly what these callers need, and the four-call dance
 * buys nothing when the tree has one changed entry.
 */

/** `main`/`master`, whichever this repo actually uses. Never assumed. */
export async function defaultBranch(): Promise<string> {
  const repo = await gh(`/repos/${GITHUB_REPO}`);
  return repo.default_branch as string;
}

/** The commit a branch currently points at. */
export async function branchSha(branch: string): Promise<string> {
  const ref = await gh(`/repos/${GITHUB_REPO}/git/ref/heads/${encodeURIComponent(branch)}`);
  return ref.object.sha as string;
}

export interface RepoFile {
  /** Decoded UTF-8 file content. */
  text: string;
  /** The **blob** sha, which is what a Contents API write must echo back — not the commit sha. */
  sha: string;
}

/**
 * Reads one file at one ref, or `undefined` if it is not there.
 *
 * A missing file is a fact rather than a failure here — the archive's "is this
 * id free" check is built on it — so `gh`'s non-retryable `NotFound` is caught
 * and mapped to `undefined`.
 *
 * **The size branch is not defensive padding.** The Contents API's JSON
 * envelope inlines base64 content only up to 1MB. Past that it answers with
 * `encoding: "none"` and `content: ""`, which is a success rather than an
 * error: read naively, a run-log that crossed the line would decode to an empty
 * string, parse as "no runs have ever been published", and silently reset the
 * publish gate's baseline so the next run looked like the first one ever. The
 * run-log grows about 1KB per run, so the line is years away and would arrive
 * unannounced. `download_url` carries the file at any size.
 */
export async function readRepoFile(path: string, ref: string): Promise<RepoFile | undefined> {
  let meta: any;
  try {
    meta = await gh(`/repos/${GITHUB_REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`);
  } catch (err) {
    if (err instanceof ApplicationFailure && err.type === 'NotFound') return undefined;
    throw err;
  }
  if (Array.isArray(meta)) {
    throw ApplicationFailure.nonRetryable(`${path} at ${ref} is a directory, not a file.`, 'NotAFile');
  }

  if (meta.encoding === 'base64') {
    return { text: Buffer.from(meta.content, 'base64').toString('utf8'), sha: meta.sha as string };
  }

  const res = await fetch(meta.download_url as string);
  if (!res.ok) {
    throw new Error(`fetching ${path} at ${ref} from download_url failed: ${res.status}`);
  }
  return { text: await res.text(), sha: meta.sha as string };
}

/**
 * Points `branch` at `sha`, creating it if it does not exist.
 *
 * The force update is the API translation of the worktree's `checkout -B branch
 * origin/base` plus `push --force-with-lease`: a re-run of a failed publish has
 * to start from base rather than stacking a second commit on whatever the last
 * attempt left behind. Force is safe on exactly these branches because Steward
 * is their only writer and a human's only interaction with one is merging the
 * PR that is open against it.
 */
export async function resetBranch(branch: string, sha: string): Promise<void> {
  try {
    await gh(`/repos/${GITHUB_REPO}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    return;
  } catch (err) {
    // 422 "Reference already exists" is the ordinary path on any re-run; every
    // other 422 is a real rejection and must surface.
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) throw err;
  }
  await gh(`/repos/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha, force: true }),
  });
}

/** Creates the branch only if absent, and leaves an existing one where it is. */
export async function ensureBranch(branch: string, fromSha: string): Promise<void> {
  try {
    await gh(`/repos/${GITHUB_REPO}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) throw err;
  }
}

export interface WriteFileInput {
  path: string;
  /** UTF-8 content. Base64 encoding is this function's business, not the caller's. */
  text: string;
  message: string;
  branch: string;
  /**
   * The blob sha being replaced. **Omitted means "this file must not exist"** —
   * the API answers 422 if it does, which is the atomic claim
   * `archiveScorecardRun` relies on instead of a check-then-write race.
   */
  sha?: string;
}

export interface WriteFileResult {
  commitSha: string;
  /** The new blob sha. */
  contentSha: string;
}

export async function writeRepoFile(input: WriteFileInput): Promise<WriteFileResult> {
  const body: Record<string, unknown> = {
    message: input.message,
    content: Buffer.from(input.text, 'utf8').toString('base64'),
    branch: input.branch,
  };
  if (input.sha) body.sha = input.sha;

  const res = await gh(`/repos/${GITHUB_REPO}/contents/${encodeURI(input.path)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return { commitSha: res.commit.sha as string, contentSha: res.content.sha as string };
}

/** Raised by {@link writeRepoFile} through `gh`'s 422 mapping when a create collided. */
export function isAlreadyExists(err: unknown): boolean {
  if (!(err instanceof ApplicationFailure) || err.type !== 'UnprocessableRequest') return false;
  return /already exists|sha.*wasn't supplied|does not match/i.test(err.message);
}

export interface OpenPrInput {
  branch: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

/**
 * Opens the PR for `branch`, or updates the one already open against it.
 *
 * Idempotent by the same reasoning `publishPost` uses: a retried publish must
 * not open a second PR for the same run, and the head-branch query is the only
 * reliable identity a PR has before it has a number.
 */
export async function openOrUpdatePr(input: OpenPrInput): Promise<string> {
  const owner = GITHUB_REPO.split('/')[0];
  const existing = await gh(
    `/repos/${GITHUB_REPO}/pulls?head=${encodeURIComponent(`${owner}:${input.branch}`)}&state=open`,
  );

  if (Array.isArray(existing) && existing.length > 0) {
    const updated = await gh(`/repos/${GITHUB_REPO}/pulls/${existing[0].number}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: input.title, body: input.body }),
    });
    return updated.html_url as string;
  }

  const created = await gh(`/repos/${GITHUB_REPO}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.branch,
      base: input.base,
      draft: input.draft === true,
    }),
  });
  return created.html_url as string;
}
