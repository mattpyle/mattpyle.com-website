import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { REVIEWS_DIR, SITE_DIR, postRelPath } from '../config.js';
import { ReviewReport, type Collection } from './report.js';
import {
  FORMAT_DRIVEN_TELLS,
  TELL_CATEGORIES,
  VOICE_DRIVEN_TELLS,
  type TellCategory,
} from './tells.js';

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

  // --- ai-tells (Phase 2 Part A) --------------------------------------------
  //
  // Carried HERE, through the same `wordCount`, rather than normalised by the
  // study's own code. The per-100-words denominator is the one thing every
  // cross-collection comparison in this project depends on — the corpus has a
  // ~9x genre gap between a changelog entry and a writing post — and this module
  // already owns it. The E-Prime README command was hand-rolled twice and was
  // wrong both times; a second normaliser is how that happens a third time.

  /** The composite, from the archived report's `ai_tells` pass. Null if the pass did not run. */
  aiLikenessScore: number | null;
  /** Per-tell finding counts. Null if the pass did not run. */
  tellCounts: Record<TellCategory, number> | null;
  /**
   * Per-tell findings per 100 words.
   *
   * **Densities, never raw counts, are what may be compared across collections.**
   * Raw per-tell totals are a length measurement first and a style measurement
   * second. Null when the pass did not run or the post is no longer on disk.
   */
  tellsPer100: Record<TellCategory, number> | null;
  /** Total tell findings per 100 words, all eight categories. */
  tellTotalPer100: number | null;
  /**
   * Per 100 words, counting only the four voice-driven tells — the re-ranking
   * the study's hypothesis (c) turns on. Excludes the changelog's house format
   * AND excludes the unclassified `EM_DASH_DENSITY`.
   */
  voiceTellsPer100: number | null;
  /** Per 100 words, counting only the three format-driven tells. */
  formatTellsPer100: number | null;
}

/** Fixtures are planted defects, not writing. README rule 4, criterion 3. */
const FIXTURE = /smoke-test|fixture/;

export interface TellSummary {
  tellsPer100: Record<TellCategory, number> | null;
  tellTotalPer100: number | null;
  voiceTellsPer100: number | null;
  formatTellsPer100: number | null;
}

/**
 * The per-100-words normalisation for ai-tells, extracted as a pure function so
 * the arithmetic the whole study rests on is testable without a fixture tree.
 *
 * `words` of 0 (or a post no longer on disk) yields nulls rather than zeroes or
 * Infinity: an unnormalisable review is a gap in the data, and a 0 would be read
 * as "no tells" by anything ranking these.
 */
export function summariseTells(
  tellCounts: Record<TellCategory, number> | null,
  words: number | null,
): TellSummary {
  const none: TellSummary = {
    tellsPer100: null,
    tellTotalPer100: null,
    voiceTellsPer100: null,
    formatTellsPer100: null,
  };
  if (!tellCounts || !words || words <= 0) return none;

  const per100 = (n: number): number => Number(((n / words) * 100).toFixed(3));
  const sumOf = (cats: readonly TellCategory[]): number =>
    cats.reduce((acc, c) => acc + (tellCounts[c] ?? 0), 0);

  return {
    tellsPer100: Object.fromEntries(
      TELL_CATEGORIES.map((c) => [c, per100(tellCounts[c] ?? 0)]),
    ) as Record<TellCategory, number>,
    tellTotalPer100: per100(sumOf(TELL_CATEGORIES)),
    voiceTellsPer100: per100(sumOf(VOICE_DRIVEN_TELLS)),
    formatTellsPer100: per100(sumOf(FORMAT_DRIVEN_TELLS)),
  };
}

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

      // The ai-tells pass is optional (workflow input `enableAiTells`), so its
      // absence is a normal state and yields nulls rather than zeroes. A zero
      // would claim the scorer looked and found nothing, which is a different
      // and much stronger statement than "the scorer did not run".
      const aiPass = parsed.passes.find((p) => p.pass === 'ai_tells');
      const rawScore = aiPass?.metrics?.aiLikenessScore;
      const rawCounts = aiPass?.metrics?.tellCounts as Record<string, number> | undefined;

      const tellCounts = rawCounts
        ? (Object.fromEntries(
            TELL_CATEGORIES.map((c) => [c, rawCounts[c] ?? 0]),
          ) as Record<TellCategory, number>)
        : null;

      const tells = summariseTells(tellCounts, words);

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
        aiLikenessScore: typeof rawScore === 'number' ? rawScore : null,
        tellCounts,
        ...tells,
      });
    }
  }

  return stats.sort((a, b) => a.slug.localeCompare(b.slug));
}
