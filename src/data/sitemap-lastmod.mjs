import scorecardRuns from './scorecard-runs.json' with { type: 'json' };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Last significant shared change: the Scorecard navigation link shipped site-wide. */
export const SITEWIDE_LASTMOD = '2026-07-15';

/**
 * The run-log is the source of truth for the "verified" date (scorecard-audit-spec.md
 * §5.1) — imported directly rather than via `scorecard.ts`, which would create a
 * cycle (`scorecard.ts` itself imports `SCORECARD_VERIFIED` from this file).
 *
 * A real ESM import, not `fs.readFileSync`, because this module is loaded both
 * directly by Node (`astro.config.mjs`) and bundled through Vite during
 * prerendering — the latter inlines JSON imports into the chunk rather than
 * copying the file alongside it, so a runtime file read 404s post-bundle.
 */

/** @param {string} iso */
export function formatVerifiedLabel(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00.000Z`));
}

const SCORECARD_VERIFIED_ISO = scorecardRuns[0].iso;

/**
 * Shared with the public Scorecard snapshot so its machine and visible dates
 * cannot drift. Derived from the newest run in `scorecard-runs.json` — the
 * date can no longer silently lag the last real audit (scorecard-audit-spec.md §5.1).
 */
export const SCORECARD_VERIFIED = Object.freeze({
  iso: SCORECARD_VERIFIED_ISO,
  label: formatVerifiedLabel(SCORECARD_VERIFIED_ISO),
});

/**
 * Authored dates for significant changes to static routes. Advance only the
 * affected route; never replace these with a build or deployment timestamp.
 */
export const STATIC_ROUTE_LASTMOD = Object.freeze({
  '/': '2026-07-15',
  '/about/': '2026-07-15',
  '/builds/': '2026-07-15',
  '/changelog/': '2026-07-17',
  '/scorecard/': '2026-07-18',
  '/writing/': '2026-07-15',
});

/** @param {...(string | undefined)} dates */
export function latestDate(...dates) {
  const presentDates = dates.filter((date) => date !== undefined);
  for (const date of presentDates) {
    if (!DATE_PATTERN.test(date)) {
      throw new TypeError(`Sitemap lastmod must use YYYY-MM-DD; received ${JSON.stringify(date)}`);
    }
    if (new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
      throw new TypeError(`Sitemap lastmod must be a valid calendar date; received ${JSON.stringify(date)}`);
    }
  }
  return presentDates.sort().at(-1);
}

/** @param {string} pathname */
export function resolveStaticLastmod(pathname) {
  const routeDate = STATIC_ROUTE_LASTMOD[pathname];
  return routeDate ? latestDate(SITEWIDE_LASTMOD, routeDate) : undefined;
}

/**
 * @param {string} pathname
 * @param {Map<string, { draft: boolean, lastmod: string }>} writingMetadata
 * @param {Map<string, { draft: boolean, lastmod: string }>} [changelogMetadata]
 */
export function resolveSitemapLastmod(pathname, writingMetadata, changelogMetadata) {
  if (pathname === '/writing/') {
    const publishedDates = [...writingMetadata.values()]
      .filter(({ draft }) => !draft)
      .map(({ lastmod }) => lastmod);
    return latestDate(resolveStaticLastmod(pathname), ...publishedDates);
  }

  if (pathname.startsWith('/writing/')) {
    const slug = decodeURIComponent(pathname.slice('/writing/'.length).replace(/\/$/, ''));
    const entry = writingMetadata.get(slug);
    return entry && !entry.draft
      ? latestDate(SITEWIDE_LASTMOD, entry.lastmod)
      : undefined;
  }

  if (pathname === '/changelog/') {
    const publishedDates = [...(changelogMetadata?.values() ?? [])]
      .filter(({ draft }) => !draft)
      .map(({ lastmod }) => lastmod);
    return latestDate(resolveStaticLastmod(pathname), ...publishedDates);
  }

  if (pathname.startsWith('/changelog/')) {
    const slug = decodeURIComponent(pathname.slice('/changelog/'.length).replace(/\/$/, ''));
    const entry = changelogMetadata?.get(slug);
    return entry && !entry.draft
      ? latestDate(SITEWIDE_LASTMOD, entry.lastmod)
      : undefined;
  }

  if (pathname === '/scorecard/') {
    return latestDate(resolveStaticLastmod(pathname), SCORECARD_VERIFIED.iso);
  }

  return resolveStaticLastmod(pathname);
}
