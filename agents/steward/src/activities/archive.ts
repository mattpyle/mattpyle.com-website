import fs from 'node:fs/promises';
import path from 'node:path';
import { REVIEWS_DIR } from '../config.js';
import { ReviewReport } from '../lib/report.js';
import { log, timed } from '../lib/logger.js';

export interface ArchiveResult {
  /** Repo-relative path to the hash-keyed archive file. */
  reportPath: string;
  latestPath: string;
}

/**
 * Spec §8.9. Writes `reviews/<slug>/<hash12>.json` plus a `latest.json` **copy**
 * (not a symlink — Windows, and design rule 8).
 *
 * The report is validated against the Zod schema on the way out. An archive that
 * doesn't match the contract is worse than no archive: the whole point is that
 * `reviews/` is a dataset.
 *
 * Phase 1a does not git-commit the archive from inside the activity. See
 * "Deviations from spec" in the README.
 */
export async function archiveReport(report: ReviewReport): Promise<ArchiveResult> {
  const { result } = await timed('archiveReport', async () => {
    const parsed = ReviewReport.parse(report);
    const dir = path.join(REVIEWS_DIR, parsed.slug);
    await fs.mkdir(dir, { recursive: true });

    const hash12 = parsed.contentSha256.slice(0, 12);
    const json = JSON.stringify(parsed, null, 2) + '\n';
    const file = path.join(dir, `${hash12}.json`);
    const latest = path.join(dir, 'latest.json');
    await fs.writeFile(file, json, 'utf8');
    await fs.writeFile(latest, json, 'utf8');

    log.info({ slug: parsed.slug, hash12, overall: parsed.overall }, 'review archived');
    return {
      reportPath: path.relative(path.resolve(REVIEWS_DIR, '..', '..', '..'), file).split(path.sep).join('/'),
      latestPath: path.relative(path.resolve(REVIEWS_DIR, '..', '..', '..'), latest).split(path.sep).join('/'),
    };
  });
  return result;
}
