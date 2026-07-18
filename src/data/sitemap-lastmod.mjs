const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Last significant shared change: the Scorecard navigation link shipped site-wide. */
export const SITEWIDE_LASTMOD = '2026-07-15';

const SCORECARD_VERIFIED_ISO = '2026-07-15';

/** Shared with the public Scorecard snapshot so its machine and visible dates cannot drift. */
export const SCORECARD_VERIFIED = Object.freeze({
  iso: SCORECARD_VERIFIED_ISO,
  label: new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${SCORECARD_VERIFIED_ISO}T00:00:00.000Z`)),
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
  '/scorecard/': '2026-07-15',
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
