import fs from 'node:fs/promises';
import path from 'node:path';
import { SITE_DIR } from '../config.js';
import type { PatchProposal, ReviewReport } from '../lib/report.js';
import { timed } from '../lib/logger.js';
// Reused rather than re-derived: the stale check compares this hash against
// `snapshotDraft`'s, so they must be computed identically or every apply would
// look like a spurious content change.
import { sha256 } from './snapshot.js';

export interface ApplyPatchesInput {
  report: ReviewReport;
  /** Patch IDs the human selected. Design rule 1: never "all patches". */
  patchIds: string[];
}

export interface ApplyPatchesResult {
  applied: string[];
  file: string;
  /** Hash after the edits — the workflow uses it to confirm the file moved. */
  contentSha256: string;
}

/** Counts non-overlapping occurrences of a literal string. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Applies one exact-match replacement, enforcing uniqueness (spec §6.2).
 *
 * **0 matches or 2+ matches is a loud failure, never a best guess.** This is the
 * whole safety property of the patch format: `oldText` must identify exactly one
 * site. Replacing the first of several matches would silently edit a line nobody
 * reviewed, and "0 matches" almost always means the file changed underneath the
 * review — which is precisely the condition the stale-hash rule exists to catch.
 */
export function applyOne(content: string, patch: PatchProposal): string {
  const matches = countOccurrences(content, patch.oldText);
  if (matches === 0) {
    throw new Error(
      `${patch.id}: the text to replace was not found in ${patch.file}. It reads "${patch.oldText}". The file has probably changed since the review — re-run \`steward rereview ${'<slug>'}\` and apply against a fresh report.`,
    );
  }
  if (matches > 1) {
    throw new Error(
      `${patch.id}: the text to replace occurs ${matches} times in ${patch.file} ("${patch.oldText}"), so there is no single unambiguous site to edit. Refusing to guess — fix this one by hand.`,
    );
  }
  // The replacement is passed as a *function*, not a string. `String.replace`
  // interprets `$&`, `` $` ``, `$'`, and `$1` inside a string replacement as
  // backreferences — so a patch whose newText legitimately contains `$&` (a
  // shell snippet, a regex in a code fence, a price) would silently insert the
  // matched text instead of itself. A function replacement is taken literally.
  return content.replace(patch.oldText, () => patch.newText);
}

/**
 * Spec §7.3 / §8. Applies the human-selected patches **in the primary checkout**
 * — the one deliberate exception to worktree isolation (design rule 3), because
 * these edits are for the human's working copy, not for a build.
 *
 * All-or-nothing: every patch is validated and applied in memory first, and the
 * file is written once at the end. A patch set that fails halfway through would
 * otherwise leave the post in a state matching neither the old hash nor the new
 * one, with no record of how far it got.
 *
 * Retry policy is 1 attempt (spec §7.4) — edits are not idempotent, so this must
 * fail loudly rather than be replayed.
 */
export async function applyPatchesActivity(input: ApplyPatchesInput): Promise<ApplyPatchesResult> {
  const { result } = await timed('applyPatchesActivity', async () => {
    const { report, patchIds } = input;

    if (patchIds.length === 0) {
      throw new Error('No patch IDs were given. Select patches by ID, e.g. `--patches patch-1,patch-3`.');
    }

    const selected: PatchProposal[] = [];
    for (const id of patchIds) {
      const patch = report.patches.find((p) => p.id === id);
      if (!patch) {
        const available = report.patches.map((p) => p.id).join(', ') || '(none)';
        throw new Error(`No patch "${id}" in this report. Available: ${available}.`);
      }
      selected.push(patch);
    }

    const files = new Set(selected.map((p) => p.file));
    if (files.size > 1) {
      throw new Error(`Patches span multiple files (${[...files].join(', ')}); the Steward edits one post at a time.`);
    }
    const file = selected[0].file;
    const abs = path.join(SITE_DIR, file);

    let content = await fs.readFile(abs, 'utf8');
    for (const patch of selected) {
      content = applyOne(content, patch);
    }

    await fs.writeFile(abs, content, 'utf8');

    return {
      applied: selected.map((p) => p.id),
      file,
      contentSha256: sha256(Buffer.from(content, 'utf8')),
    };
  });

  return result;
}
