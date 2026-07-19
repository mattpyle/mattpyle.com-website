import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { REVIEWS_DIR, SITE_DIR, postRelPath } from '../config.js';
import { ReviewReport, type Collection } from './report.js';

/**
 * Archive statistics, for the README's E-Prime re-decision rule (operational
 * rule 4) and anything else that needs to count across reviews.
 *
 * **Why this exists as code rather than a documented shell one-liner.** The
 * README carried a PowerShell pipeline for this and it was wrong in two ways at
 * once, both found by running it rather than reading it: the archive layout had
 * moved under `reviews/<collection>/`, and — more subtly — filtering on
 * `mode -eq 'gate'` returned *nothing*, because reports written before audit
 * mode existed have no `mode` key in their raw JSON at all. Only Zod parsing
 * supplies the default. A shell filter reimplements that default by hand, or
 * silently returns an empty set; both have now happened.
 *
 * Parsing through `ReviewReport` means the schema stays the single owner of what
 * a missing `mode` or `collection` means.
 */

export interface ReviewStat {
  slug: string;
  collection: Collection;
  mode: 'gate' | 'audit';
  qualifies: boolean;
  ePrimeHits: number;
  words: number;
  /** E-Prime hits per 100 words. Null when the post file is no longer on disk. */
  ePrimePer100: number | null;
}

/** Fixtures are planted defects, not writing. README rule 4, criterion 3. */
const FIXTURE = /smoke-test|fixture/;

async function wordCount(collection: Collection, slug: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(SITE_DIR, postRelPath(slug, collection)), 'utf8');
    // Body only — frontmatter is metadata, and counting it would inflate short
    // changelog entries far more than long writing posts, which is precisely
    // the distortion this normalisation exists to remove.
    const body = matter(raw).content;
    return body.split(/\s+/).filter(Boolean).length;
  } catch {
    // The post may have been renamed or unpublished since the review. That is
    // not an error; it just means this review cannot be normalised.
    return null;
  }
}

export async function collectStats(): Promise<ReviewStat[]> {
  const stats: ReviewStat[] = [];

  for (const collection of ['writing', 'changelog'] as const) {
    const dir = path.join(REVIEWS_DIR, collection);
    let slugs: string[];
    try {
      slugs = await fs.readdir(dir);
    } catch {
      continue; // No reviews in this collection yet.
    }

    for (const slug of slugs) {
      const latest = path.join(dir, slug, 'latest.json');
      let parsed;
      try {
        parsed = ReviewReport.parse(JSON.parse(await fs.readFile(latest, 'utf8')));
      } catch (err) {
        // Design rule 11: a directory that exists but whose report will not parse
        // is a bug, not an absence. Counting it as zero would quietly understate
        // the very number this function exists to report.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`Could not read the archived report at ${latest}: ${(err as Error).message}`);
      }

      const ePrimeHits = parsed.passes
        .filter((p) => p.pass === 'vale')
        .flatMap((p) => p.findings)
        .filter((f) => /E-Prime/.test(f.message)).length;

      const words = await wordCount(parsed.collection, parsed.slug);

      stats.push({
        slug: parsed.slug,
        collection: parsed.collection,
        mode: parsed.mode,
        // README rule 4: writing only, gate only, not a fixture.
        qualifies:
          parsed.collection === 'writing' && parsed.mode === 'gate' && !FIXTURE.test(parsed.slug),
        ePrimeHits,
        words: words ?? 0,
        ePrimePer100: words && words > 0 ? Number(((ePrimeHits / words) * 100).toFixed(2)) : null,
      });
    }
  }

  return stats.sort((a, b) => a.slug.localeCompare(b.slug));
}
