/**
 * A date-only frontmatter value (`date: 2026-09-03`) is coerced to UTC midnight. Formatted in a
 * reader's local time west of UTC that is the evening before, so a feed shows the day before the
 * page does. Noon UTC is the same calendar day from UTC-11 to UTC+11. Apply it to date-only
 * fields only, never to a `publishedAt`, which is a real instant.
 *
 * @param {Date} date
 * @returns {Date}
 */
export function dateOnlyToFeedInstant(date) {
  return new Date(date.getTime() + 12 * 60 * 60 * 1000);
}

/**
 * The `<lastBuildDate>` of an RSS feed: the newest content date among its items, in the RFC 822
 * form RSS asks for. Never the build time. The sitemap's lastmod is hand-dated for the same
 * reason (src/data/sitemap-lastmod.mjs): Google ignores a date it finds unreliable, and a build
 * stamp moves on every deploy whether or not any content changed.
 *
 * Returns the full `<lastBuildDate>` element, or an empty string when there is no date to report,
 * so a feed with no items omits the element and scripts/validate-sitemap.mjs fails the build
 * rather than the feed inventing one.
 *
 * @param {Iterable<Date | undefined>} dates
 */
export function lastBuildDateElement(dates) {
  const times = [...dates]
    .filter((date) => date instanceof Date && !Number.isNaN(date.getTime()))
    .map((date) => date.getTime());
  if (times.length === 0) return '';
  return `<lastBuildDate>${new Date(Math.max(...times)).toUTCString()}</lastBuildDate>`;
}
