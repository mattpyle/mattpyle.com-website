/**
 * The narrow reader for the fixes collection, for build-time consumers that run outside Astro:
 * astro.config.mjs (the sitemap), scripts/validate-sitemap.mjs and scripts/generate-page-paths.mjs.
 *
 * It returns each fix keyed by its `slug`, the segment of its URL, with the date its sitemap
 * entry carries. The date is the day the fix was confirmed on production, `verified`, as a calendar date
 * in America/Vancouver, the zone the pages show it in: that is the field the pages order and date the entries by.
 *
 * NO TOP-LEVEL SIDE EFFECTS.
 */

import { ENTRIES_DIR, readEntries } from '../fix-log-entries.mjs';

/**
 * @param {string} [directory]
 * @returns {Map<string, { draft: boolean, lastmod: string, key: string }>}
 */
export function readFixMetadata(directory = ENTRIES_DIR) {
  const metadata = new Map();
  for (const entry of readEntries(directory)) {
    const slug = entry.data.slug;
    if (typeof slug !== 'string' || slug === '') {
      throw new Error(`${entry.file}: a fix needs a slug before its page can be listed`);
    }
    const verified = new Date(entry.data.verified);
    if (Number.isNaN(verified.getTime())) {
      throw new Error(`${entry.file}: "verified" is not a date`);
    }
    if (metadata.has(slug)) throw new Error(`${entry.file}: slug "${slug}" is used twice`);
    metadata.set(slug, { draft: false, lastmod: verified.toLocaleDateString("en-CA", { timeZone: "America/Vancouver" }), key: String(entry.key) });
  }
  return metadata;
}
