import { STATIC_ROUTE_LASTMOD } from './sitemap-lastmod.mjs';

/**
 * The canonical set of pages the live site publishes.
 *
 * One definition, two consumers with different ways of reading content:
 * `scripts/validate-sitemap.mjs` passes slugs it read off disk with
 * `readWritingMetadata`, and `/scorecard` passes slugs it got from
 * `getCollection`. Both must produce the same set — the sitemap is what
 * /scorecard's coverage line measures itself against, and a count derived
 * separately would eventually disagree with the sitemap the validator checks.
 *
 * Draft filtering is the caller's, and it is unconditional in both: a draft is
 * absent from the sitemap in every environment (see `src/lib/show-drafts.ts`),
 * so it is not a live page here either.
 *
 * @param {{ writingSlugs: Iterable<string>, changelogSlugs: Iterable<string> }} published
 * @returns {string[]} canonical pathnames, each with a trailing slash
 */
export function livePagePaths({ writingSlugs, changelogSlugs }) {
  return [
    ...Object.keys(STATIC_ROUTE_LASTMOD),
    ...[...writingSlugs].map((slug) => `/writing/${slug}/`),
    ...[...changelogSlugs].map((slug) => `/changelog/${slug}/`),
  ];
}
