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

import { trailingSlashRedirectFor } from './trailing-slash.mjs';

/**
 * The on-demand paths, in every shape the site serves them in.
 *
 * `/activity` and `/activity/` are the page (internal links use the first shape as well as the
 * second, which is the canonical). `/activity.md` is its markdown sibling, answered by a curated
 * on-demand route because there is no built HTML file for the emit step to convert (see
 * markdown-negotiation.mjs).
 *
 * `/scorecard` was on this list until 2026-08-22 and is not any more: the store read moved to
 * /activity and that page went back to prerendering, where a query string is not part of the CDN
 * cache key and there is nothing to protect. `/activity.json` is deliberately absent too — it is
 * an on-demand render, but see the note on the endpoint below.
 *
 * This doubles as the mirror of the middleware's `config.matcher` entries for these paths: Vercel
 * reads that matcher statically at build time and cannot evaluate an imported constant, so the
 * literal lives there and this copy exists to be diffed against it.
 */
export const ON_DEMAND_PATHS = ['/activity', '/activity/', '/activity.md', '/activity.json'];

const ON_DEMAND = new Set(ON_DEMAND_PATHS);

/**
 * Does this request need canonicalising, and to where?
 *
 * Returns the query-free path to redirect to, or null to leave the request alone. A path not in
 * the list, or one carrying no query string at all, is never touched — which is every request the
 * site actually wants to serve.
 *
 * The target is the *fully* canonical shape, not merely the query-free one: `/activity?q=1` goes
 * straight to `/activity/`, slash included. Returning the bare `/activity` would be correct as far
 * as this rule goes and then immediately earn a second 308 from the slash normalisation in
 * src/lib/trailing-slash.mjs, so a cache-busting request would cost two round trips instead of one
 * and every such URL would sit behind a redirect chain. One hop, always.
 *
 * `/activity.md` and `/activity.json` are the exceptions that prove it: an extension path has no
 * slash form, so its canonical target is itself, query stripped. The JSON endpoint is here because
 * it costs a store read exactly like the page does, which is the whole reason this list exists.
 *
 * @param {string} pathname
 * @param {string} search the URL's search component, `?q=1` or ''
 * @returns {string | null}
 */
export function canonicalOnDemandPath(pathname, search) {
  if (!search) return null;
  if (!ON_DEMAND.has(pathname)) return null;
  return trailingSlashRedirectFor(pathname) ?? pathname;
}
