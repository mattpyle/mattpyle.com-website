/**
 * The narrow reader for the fixes collection, for build-time consumers that run outside Astro:
 * astro.config.mjs (the sitemap), scripts/validate-sitemap.mjs and scripts/generate-page-paths.mjs.
 *
 * It returns each fix keyed by its `slug`, the segment of its URL, with the date its sitemap
 * entry carries: the later of `verified` (the day the fix was confirmed on production) and the
 * optional `updated`, as calendar dates: `verified` in America/Vancouver, the zone the pages show times in, `updated` as written.
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
    const day = (date) => date.toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
    const updated = entry.data.updated ? new Date(entry.data.updated) : null;
    if (updated && Number.isNaN(updated.getTime())) throw new Error(`${entry.file}: "updated" is not a date`);
    // `updated` is a calendar date, read as UTC like `found`. The later of `verified` and `updated`: an edit to the text moves the sitemap date.
    const lastmod = [day(verified), ...(updated ? [updated.toISOString().slice(0, 10)] : [])].sort().at(-1);
    metadata.set(slug, { draft: false, lastmod, key: String(entry.key) });
  }
  return metadata;
}
