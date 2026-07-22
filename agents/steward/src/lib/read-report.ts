import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REVIEWS_DIR, resolveArchivePath, type Collection } from '../config.js';
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
