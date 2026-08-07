/**
 * The routes that render per request, and the one rule that keeps their cost bounded.
 *
 * Everything else on this site is prerendered, and a query string on a prerendered page is not
 * part of the CDN cache key: `/?bust=<random>` returns `X-Vercel-Cache: HIT` with the same `Age`
 * every time. The on-demand routes behave the other way round. Measured on production 2026-08-06
 * (docs/reference/security-audit-2026-08.md, section 2): three requests to `/scorecard/?q=<random>`
 * with three unique values returned `MISS`, `MISS`, `MISS`, and repeating one value returned `MISS`
 * then `HIT`. So a unique query string forces a fresh render and a fresh store read, for the cost
 * of one HTTP request.
 *
 * The fix is a redirect rather than a rewrite: the middleware answers a query-carrying request to
 * one of these paths with a 308 to the bare path, so the render only ever happens against a URL
 * the cache already has. A rewrite would strip the query for the origin but leave the CDN keying
 * on it, which is the half that costs money.
 *
 * SCOPE IS EXACTLY THESE PATHS. Stripping query strings site-wide would be wrong twice over: it
 * buys nothing on a prerendered page, and it would eat `utm_*` before client-side analytics reads
 * it.
 *
 * Pure and dependency-free so tests/on-demand-routes.test.mjs can diff this list against
 * middleware.ts's literal matcher without a deploy. Same split as agent-surfaces.mjs and
 * markdown-negotiation.mjs.
 */

/**
 * The on-demand paths, in every shape the site serves them in.
 *
 * `/scorecard` and `/scorecard/` are the page (the nav links to the first, the canonical is the
 * second). `/scorecard.md` is its markdown sibling, answered by a curated on-demand route because
 * there is no built HTML file for the emit step to convert (see markdown-negotiation.mjs).
 *
 * This doubles as the mirror of the middleware's `config.matcher` entries for these paths: Vercel
 * reads that matcher statically at build time and cannot evaluate an imported constant, so the
 * literal lives there and this copy exists to be diffed against it.
 */
export const ON_DEMAND_PATHS = ['/scorecard', '/scorecard/', '/scorecard.md'];

const ON_DEMAND = new Set(ON_DEMAND_PATHS);

/**
 * Does this request need canonicalising, and to where?
 *
 * Returns the query-free path to redirect to, or null to leave the request alone. A path not in
 * the list, or one carrying no query string at all, is never touched — which is every request the
 * site actually wants to serve.
 *
 * @param {string} pathname
 * @param {string} search the URL's search component, `?q=1` or ''
 * @returns {string | null}
 */
export function canonicalOnDemandPath(pathname, search) {
  if (!search) return null;
  if (!ON_DEMAND.has(pathname)) return null;
  return pathname;
}
