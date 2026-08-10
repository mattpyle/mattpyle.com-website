import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REVIEWS_DIR, SITE_DIR, postRelPath, resolveArchivePath, type Collection } from '../config.js';
import { parseFrontmatter } from './frontmatter.js';
import { ReviewReport as ReviewReportSchema, type ReviewReport, type ReviewStateResult } from './report.js';

/**
 * Reads the full archived report for a review. The workflow query returns only a
 * summary; the findings live in the archived JSON.
 *
 * **Design rule 11 — this reader must not fail soft.** It distinguishes two
 * states that a `return null on any error` reader conflates:
 *
 * - *No report exists yet* — `state.reportPath` is absent. A legitimate `null`.
 * - *A report is recorded but could not be read or parsed* — a bug (a wrong
 *   path, a truncated write, malformed JSON). Throws, naming every path tried.
 *
 * The second case has now produced three separate incidents in this project
 * (the Phase 1b `SITE_DIR` coupling, and the Phase 3b archive-migration orphan).
 * Each time the CLI rendered a correct header and summary above a silently empty
 * findings table — which is strictly worse than a crash, because the output
 * still looks like a report.
 */
export async function readArchivedReport(
  state: ReviewStateResult,
): Promise<ReviewReport | null> {
  if (!state.reportPath) return null;

  // A workflow parked before the reviews/<collection>/<slug>/ migration has the
  // *old* path baked into its history, and history is immutable — so the
  // recorded path points at a file that has moved. Falling back to the migrated
  // location keeps those reviews readable. The live `hello-world` review is
  // exactly this case.
  const candidates = [state.reportPath];
  const migrated = state.reportPath.replace(
    /^(agents\/steward\/reviews)\/(?!writing\/|changelog\/)/,
    '$1/writing/',
  );
  if (migrated !== state.reportPath) candidates.push(migrated);

  const attempted: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolveArchivePath(candidate);
    attempted.push(resolved);
    let raw: string;
    try {
      raw = await readFile(resolved, 'utf8');
    } catch (err) {
      // Only "not there" justifies trying the next candidate shape. A file that
      // exists but cannot be read (permissions, a directory in its place) is a
      // real failure and must not be masked by the fallback.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(
        `Could not read the archived report at ${resolved}: ${(err as Error).message}`,
      );
    }
    try {
      return JSON.parse(raw) as ReviewReport;
    } catch (err) {
      throw new Error(
        `The archived report at ${resolved} exists but is not valid JSON: ${(err as Error).message}`,
      );
    }
  }

  throw new Error(
    'The review records an archived report, but no file was found. Tried:\n' +
      attempted.map((p) => `  - ${p}`).join('\n'),
  );
}

/**
 * Reads the LATEST archived report for a slug directly off disk —
 * `reviews/<collection>/<slug>/latest.json` — with no live workflow involved.
 *
 * This is `steward report`'s path, distinct from `readArchivedReport` above:
 * that function starts from a workflow's `ReviewStateResult` (a live query),
 * which `report` deliberately does not need — the archive is the dataset, and
 * a slug that was reviewed once and then closed (approved, published,
 * rejected — the workflow long gone) must still be reportable. Same
 * design-rule-11 contract: absence is a legitimate `null`, a broken or
 * unparsable archive is not.
 */
/**
 * What the file behind a slug turns out to be, which is what decides which verb
 * can actually review it. `missing` is its own state rather than an assumed
 * `published`, because a mistyped slug and a published post need different
 * advice and guessing between them is how the old message went wrong.
 */
export type PostState = 'draft' | 'published' | 'missing';

/**
 * Reads a slug's draft state off disk. Only `ENOENT` becomes `missing` — an
 * unreadable file is a real failure and must not be reported as an absent post,
 * the same distinction design rule 11 makes for the archive above.
 */
export async function readPostState(collection: Collection, slug: string): Promise<PostState> {
  const file = path.join(SITE_DIR, postRelPath(slug, collection));
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  return parseFrontmatter(raw).data.draft === true ? 'draft' : 'published';
}

/**
 * The message `steward report` fails with when the archive has nothing.
 *
 * It used to say "run `steward review <slug>` first" unconditionally. `review`
 * is gate mode and refuses anything without `draft: true`, so for a published
 * post that instruction cannot work: you run it, get a second refusal, and have
 * to already know `audit` exists to get anywhere. Naming the verb that will run
 * against *this* file is the fix; naming both, with the distinction stated, is
 * what stops the next person hitting the mirror image of the same wall.
 *
 * Pure, so the wording is testable without a workflow, a server, or an archive.
 */
export function describeMissingReport(
  collection: Collection,
  slug: string,
  state: PostState,
): string {
  const label = `${collection}/${slug}`;
  const audit = `steward audit ${collection} ${slug}`;
  const review = `steward review ${slug}`;

  if (state === 'missing') {
    return (
      `No report found for ${label}, and no post at \`${postRelPath(slug, collection)}\` either. ` +
      `Check the slug and \`--collection\` (\`report\` defaults to writing; \`audit\` takes the ` +
      `collection as a positional argument instead).`
    );
  }

  const lines =
    state === 'draft'
      ? [
          `No report found for ${label}. It is a draft, so review it with \`${review}\`.`,
          `(\`review\` is gate mode and only accepts \`draft: true\`. Once it is published, \`${audit}\` is the one that runs.)`,
        ]
      : [
          `No report found for ${label}. It is published, so audit it with \`${audit}\`.`,
          `(\`review\` is gate mode and refuses anything without \`draft: true\`, so it cannot run against this file.)`,
        ];

  // The archive split, stated here because this is where it gets mistaken for a
  // broken archive: a piece can have been scored by the study and still have no
  // report, which looks identical to "the archive lost my report".
  lines.push(
    '`review` and `audit` archive to `reviews/<collection>/<slug>/`; `score` writes to `reviews/_study/` and produces no report.',
  );
  return lines.join('\n  ');
}

export async function readLatestReport(
  collection: Collection,
  slug: string,
): Promise<ReviewReport | null> {
  const resolved = path.join(REVIEWS_DIR, collection, slug, 'latest.json');
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read the archived report at ${resolved}: ${(err as Error).message}`);
  }
  try {
    return ReviewReportSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(
      `The archived report at ${resolved} exists but is not valid JSON, or fails the ReviewReport schema: ${(err as Error).message}`,
    );
  }
}
