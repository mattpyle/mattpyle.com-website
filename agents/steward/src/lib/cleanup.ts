import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  currentBranch,
  defaultBranch,
  git,
  headSha,
  inProgressOperation,
  pathState,
} from './git.js';
import { resolvePostPayload } from './post-payload.js';

/**
 * `steward cleanup <slug>` — post-publish reconciliation of the author's own
 * checkout.
 *
 * **Why this exists.** Steward reads the draft from the primary checkout but
 * commits it in its own worktree (design rule 3), so a draft the author never
 * committed survives the whole flow as an untracked local file. Once the publish
 * PR merges, that file is a stale twin of a now-published post — it still says
 * `draft: true` — and `git pull` refuses with "untracked working tree file would
 * be overwritten by merge" until someone deletes it by hand. Hit for real on the
 * `accessibility-and-ai` publish (PR 52), where the leftover read as either a
 * failed flag flip or a broken pull.
 *
 * **Operator-invoked, never automatic.** An automatic version would fire while
 * the checkout sits on another branch mid-edit — precisely the class of surprise
 * design rule 3 exists to prevent. So this is a verb the human types, after the
 * merge, when they are ready.
 *
 * **Three guards, and a refusal touches nothing.** Every refusal returns the
 * exact manual commands instead, because a cleanup command that half-acts and
 * then explains itself is worse than one that never acted at all.
 */

export interface CleanupInput {
  /** The primary checkout — the author's working directory. */
  repoDir: string;
  /** Repo-relative path of the published post. */
  relPath: string;
  slug: string;
  /**
   * The SHA-256 of the exact bytes the gate reviewed, from the archived report.
   *
   * This is what makes deletion provably lossless, and it cannot be softened
   * into a frontmatter or length check: `publishPost` refuses to publish unless
   * the on-disk file hashes to this value, so a local file that still matches it
   * is byte-for-byte the thing that was published, and nothing is lost by
   * removing it. A file that does not match holds edits made after the review,
   * which exist nowhere else.
   */
  reviewedSha256: string;
}

export type CleanupGuard = 'lossless' | 'branch' | 'fast-forward';

export interface CleanupRefusal {
  guard: CleanupGuard;
  /** Plain-language statement of what stopped it. */
  why: string;
  /** The exact commands to run by hand instead. Never empty. */
  commands: string[];
}

export type CleanupResult =
  | {
      ok: true;
      /** False when there was no twin to remove — the idempotent second run. */
      deleted: boolean;
      /** Untracked twins of the post's other payload files that were removed. */
      companionsDeleted: string[];
      /**
       * Tracked payload files whose local edit was dropped because `origin/<base>`
       * already carries those exact bytes. In practice: `cspell.shared.yaml`
       * after a publish that carried a `dict-add`.
       */
      companionsRestored: string[];
      /** False when the checkout was already at origin's tip. */
      pulled: boolean;
      base: string;
      from: string;
      to: string;
    }
  | { ok: false; refusal: CleanupRefusal };

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function refuse(guard: CleanupGuard, why: string, commands: string[]): CleanupResult {
  return { ok: false, refusal: { guard, why, commands } };
}

/**
 * True if the file on disk is byte-identical to origin's copy at the same path.
 *
 * Compared through git's own blob hashes rather than by reading both files:
 * `hash-object` applies the checkout's line-ending and filter rules, so this
 * asks the question git will ask at merge time rather than a subtly different
 * one about raw bytes.
 */
async function matchesUpstream(repoDir: string, base: string, posix: string): Promise<boolean> {
  try {
    const upstream = await git(repoDir, ['rev-parse', `origin/${base}:${posix}`]);
    const local = await git(repoDir, ['hash-object', '--', posix]);
    return upstream === local;
  } catch {
    return false;
  }
}

/** True if `origin/<base>` holds anything at all at this path. */
async function carriedUpstream(repoDir: string, base: string, posix: string): Promise<boolean> {
  try {
    await git(repoDir, ['cat-file', '-e', `origin/${base}:${posix}`]);
    return true;
  } catch {
    return false;
  }
}

/** Repo-relative paths with any pending change, staged or not, tracked or not. */
async function dirtyPaths(repoDir: string): Promise<string[]> {
  const out = await git(repoDir, ['status', '--porcelain']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // `XY path` or, for a rename, `XY old -> new`. The destination is the one
      // the working tree holds.
      const rest = line.slice(line.indexOf(' ') + 1).trim();
      const arrow = rest.lastIndexOf(' -> ');
      return arrow === -1 ? rest : rest.slice(arrow + 4);
    })
    .map((p) => p.replace(/^"|"$/g, ''));
}

export async function cleanupPublishedTwin(input: CleanupInput): Promise<CleanupResult> {
  const { repoDir, relPath, slug } = input;
  const posix = relPath.split(path.sep).join('/');
  const abs = path.join(repoDir, relPath);

  const base = await defaultBranch(repoDir);
  if (!base) {
    return refuse(
      'branch',
      "This checkout has no `origin/HEAD`, so there is no way to tell which branch is the base. " +
        'Setting it is a one-off.',
      ['git remote set-head origin -a', `steward cleanup ${slug}`],
    );
  }

  // Fetching is not touching: it moves a remote-tracking ref and nothing in the
  // working tree. Every guard below needs to know what origin actually holds,
  // and a stale `origin/<base>` would make all three answer about the past.
  try {
    await git(repoDir, ['fetch', 'origin', base]);
  } catch (err) {
    return refuse(
      'fast-forward',
      `Could not fetch origin/${base}: ${(err as Error).message.split('\n')[0]}`,
      ['git fetch origin', `steward cleanup ${slug}`],
    );
  }

  // --- Guard 1: deleting the twin must be provably lossless -----------------
  let twin: Buffer | null = null;
  try {
    twin = await fs.readFile(abs);
  } catch {
    // No local file. Not a refusal: this is the idempotent second run, or a
    // publish where the author had already tidied up by hand. The fast-forward
    // is still worth doing, so fall through with nothing to delete.
  }

  if (twin) {
    const state = await pathState(repoDir, posix);
    if (state === 'unknown') {
      return refuse('lossless', `Could not read git status for ${posix} in ${repoDir}.`, [
        `cd ${repoDir}`,
        `git status --porcelain -- ${posix}`,
      ]);
    }
    if (state === 'clean' && (await matchesUpstream(repoDir, base, posix))) {
      // Already reconciled. This is the second run of the same command, or a
      // publish someone tidied up by hand: the file on disk is not a twin at
      // all, it is origin's published copy. Saying "tracked, refusing" here
      // would report a finished job as a problem.
      twin = null;
    } else if (state !== 'untracked') {
      // Tracked means git is holding a copy: staged, or committed locally. The
      // committed-but-unpushed case is the one that stings — the merge brings
      // its own copy of the same path and you get an add/add conflict — but
      // deleting the file would not fix that and would throw away a commit's
      // worth of intent, so this is the human's call.
      return refuse(
        'lossless',
        `${posix} is tracked by git (${state === 'clean' ? 'committed' : 'staged or modified'}), ` +
          `not an untracked twin. Deleting a file git is holding a copy of is not lossless, ` +
          `so cleanup refuses it.`,
        [
          `git log --oneline origin/${base}..HEAD -- ${posix}`,
          `git pull --ff-only origin ${base}`,
          `# if the pull reports an add/add conflict, keep origin's published copy:`,
          `#   git checkout --theirs -- ${posix}`,
        ],
      );
    } else {
      const actual = sha256(twin);
      if (actual !== input.reviewedSha256) {
        return refuse(
          'lossless',
          `${posix} does not match the draft that was reviewed and published ` +
            `(reviewed ${input.reviewedSha256.slice(0, 12)}, on disk ${actual.slice(0, 12)}). ` +
            `It has changed since it was reviewed, so those edits exist nowhere else and ` +
            `deleting it would lose them.`,
          [
            `git show origin/${base}:${posix} > /tmp/published.md`,
            `git diff --no-index -- /tmp/published.md ${posix}`,
            `# then, once you are sure nothing in it is worth keeping:`,
            `rm ${posix}`,
            `git pull --ff-only origin ${base}`,
          ],
        );
      }

      // The twin's bytes must survive the deletion somewhere, and
      // `origin/<base>` carrying the published post is that somewhere. Without
      // this check, running cleanup before the PR merges would delete the only
      // copy of the draft in existence — Steward's own worktree branch is not a
      // copy the author can find.
      try {
        await git(repoDir, ['cat-file', '-e', `origin/${base}:${posix}`]);
      } catch {
        return refuse(
          'lossless',
          `origin/${base} does not carry ${posix} yet, so the publish PR has not merged. ` +
            `The local file is currently the only copy of this draft; deleting it now would ` +
            `destroy it.`,
          [`# merge the publish PR on GitHub first, then:`, `steward cleanup ${slug}`],
        );
      }
    }
  }

  // --- Guard 1b: the rest of the post's payload -----------------------------
  //
  // The post has not been the only file the publish carries since 2026-09-04:
  // its asset folder, the `public/` files it names and, when it changed,
  // `cspell.shared.yaml` all ride the same commit. Every one of them is an
  // untracked twin in this checkout for exactly the same reason the post is,
  // and `git pull` refuses on the FIRST such path the merge would overwrite —
  // so cleaning up the post alone leaves the pull blocked on the hero image
  // instead.
  //
  // Losslessness is proved differently here than for the post. There is no
  // reviewed hash for an image, so the proof is `origin/<base>` already holding
  // a byte-identical copy: what is on disk exists in published history, and
  // removing it loses nothing. A companion that does NOT match is a refusal —
  // the same call the tracked-file guard makes about the post.
  const companionsDeleted: string[] = [];
  const companionsRestored: string[] = [];
  const handled = new Set<string>([posix]);

  // Compared against HEAD rather than origin: the question here is what is dirty
  // in this checkout and therefore in the pull's way, not what differed at
  // publish time.
  let companions: string[] = [];
  try {
    const payload = await resolvePostPayload(repoDir, relPath, { compareRef: 'HEAD' });
    companions = payload.files.filter((f) => f !== payload.post);
  } catch {
    // No post on disk (the idempotent second run), or a reference that no longer
    // resolves. Neither is a reason to refuse the fast-forward: the companions
    // were handled on the first run, or they are not there to handle.
  }

  for (const companion of companions) {
    const state = await pathState(repoDir, companion);
    if (state === 'clean' || state === 'unknown') continue;

    // A path origin does not carry is not in the merge's way, so it is none of
    // cleanup's business: an image the author added after the publish, or a
    // `public/` file the PR never picked up. Leaving it is the whole action.
    if (!(await carriedUpstream(repoDir, base, companion))) continue;

    if (!(await matchesUpstream(repoDir, base, companion))) {
      return refuse(
        'lossless',
        `${companion} travels with this post, and the copy on disk does not match the one ` +
          `origin/${base} carries. It holds changes that exist nowhere else, so cleanup will ` +
          `not touch it.`,
        [
          `git diff origin/${base} -- ${companion}`,
          `# then commit, stash or discard it, and:`,
          `steward cleanup ${slug}`,
        ],
      );
    }

    handled.add(companion);
    if (state === 'untracked') {
      companionsDeleted.push(companion);
    } else {
      // Tracked and modified, with origin holding the identical bytes: the local
      // edit is the same edit the merge brings in, so dropping it back to HEAD
      // loses nothing and lets the fast-forward through. This is the dictionary
      // after a publish that carried a `dict-add`; without it every such cleanup
      // would refuse on a file whose content already agrees with origin.
      companionsRestored.push(companion);
    }
  }

  // --- Guard 2: the checkout is on the base branch, mid-nothing -------------
  const branch = await currentBranch(repoDir);
  if (branch !== base) {
    return refuse(
      'branch',
      `The checkout is on \`${branch}\`, not \`${base}\`. Cleanup only ever touches the base ` +
        `branch, because switching branches under you is exactly the surprise it exists to avoid.`,
      [`git switch ${base}`, `steward cleanup ${slug}`],
    );
  }

  const operation = await inProgressOperation(repoDir);
  if (operation) {
    return refuse(
      'branch',
      `There is ${operation} in progress in this checkout. Finishing it is yours to do, and ` +
        `pulling underneath it would make the mess worse.`,
      ['git status', `# finish or abort it, then:`, `steward cleanup ${slug}`],
    );
  }

  // --- Guard 3: the pull must be a fast-forward -----------------------------
  const from = await headSha(repoDir);
  const target = await git(repoDir, ['rev-parse', `origin/${base}`]);

  let canFastForward = true;
  try {
    await git(repoDir, ['merge-base', '--is-ancestor', 'HEAD', `origin/${base}`]);
  } catch {
    canFastForward = false;
  }
  if (!canFastForward) {
    return refuse(
      'fast-forward',
      `HEAD is not an ancestor of origin/${base}, so the checkout has diverged and the pull ` +
        `cannot fast-forward. Reconciling divergent history is a decision, not a cleanup.`,
      [
        `git log --oneline origin/${base}..HEAD`,
        `git pull --rebase origin ${base}   # or merge, if you prefer`,
        `steward cleanup ${slug}`,
      ],
    );
  }

  // `--ff-only` would refuse on its own if the incoming commits touched a file
  // the author is mid-edit on — but only *after* the twin had been deleted,
  // leaving exactly the half-done state these guards exist to prevent. So the
  // collision is detected before anything is removed.
  const incoming = (await git(repoDir, ['diff', '--name-only', 'HEAD', `origin/${base}`]))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const dirty = new Set((await dirtyPaths(repoDir)).filter((p) => !handled.has(p)));
  const collisions = incoming.filter((p) => dirty.has(p));
  if (collisions.length > 0) {
    return refuse(
      'fast-forward',
      `The incoming commits change ${collisions.join(', ')}, which you have uncommitted work in. ` +
        `The pull would refuse, and it would refuse after the twin had already been deleted.`,
      [
        `git status --porcelain`,
        `# commit or stash that work, then:`,
        `steward cleanup ${slug}`,
      ],
    );
  }

  // --- Act ------------------------------------------------------------------
  //
  // Every companion's bytes are held before it is touched, for the same reason
  // the post's are: if the pull fails after all three guards passed, the disk
  // goes back exactly as it was found.
  const held = new Map<string, Buffer>();
  for (const companion of [...companionsDeleted, ...companionsRestored]) {
    held.set(companion, await fs.readFile(path.join(repoDir, companion)));
  }

  let deleted = false;
  if (twin) {
    await fs.rm(abs);
    deleted = true;
  }
  for (const companion of companionsDeleted) {
    await fs.rm(path.join(repoDir, companion));
  }
  for (const companion of companionsRestored) {
    await git(repoDir, ['checkout', 'HEAD', '--', companion]);
  }

  try {
    await git(repoDir, ['pull', '--ff-only', 'origin', base]);
  } catch (err) {
    // Put it back. The guards said this would work; if git disagrees, the
    // author's disk goes back to how it was found rather than losing the twin to
    // a failure nobody predicted.
    if (twin) await fs.writeFile(abs, twin);
    for (const [companion, bytes] of held) {
      await fs.mkdir(path.dirname(path.join(repoDir, companion)), { recursive: true });
      await fs.writeFile(path.join(repoDir, companion), bytes);
    }
    return refuse(
      'fast-forward',
      `The fast-forward pull failed after every guard passed: ` +
        `${(err as Error).message.split('\n').slice(0, 3).join(' ')}. ` +
        `Nothing was changed; the local files have been restored.`,
      [`git pull --ff-only origin ${base}`],
    );
  }

  return {
    ok: true,
    deleted,
    companionsDeleted,
    companionsRestored,
    pulled: target !== from,
    base,
    from,
    to: await headSha(repoDir),
  };
}
