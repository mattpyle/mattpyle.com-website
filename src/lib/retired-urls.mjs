/**
 * URLs that shipped publicly and then moved, and the 301s that keep them alive.
 *
 * Scope is whole sections. A section root, its `.md` sibling, and everything beneath it all
 * redirect to the same shape under the new root. `/builds` became `/projects` on 2026-08-20 —
 * the collection, the routes, and every internal link moved with it, but the old URLs are in
 * cached feeds, in llms.txt copies agents have already read, and in whatever external links
 * exist, so none of them may 404.
 *
 * WHY THIS IS IN THE MIDDLEWARE AND NOT `vercel.json`'s `redirects`. The middleware runs before
 * the platform's routing rules, so a config-level redirect is shadowed for an
 * `Accept: text/markdown` request: negotiation sees it first and proxies to a `.md` route that
 * no longer exists. That is the request shape most likely to be held by an agent, and it is the
 * one that must not 404. The same reasoning already put RETIRED_WRITING_SLUGS in middleware.ts;
 * that map stays there because `/writing/:path*` is already a negotiable page path, so it needs
 * no matcher entry of its own. These do.
 *
 * Pure and dependency-free so tests/retired-urls.test.mjs can cover it without a deploy. Same
 * split as agent-surfaces.mjs, markdown-negotiation.mjs, on-demand-routes.mjs and
 * trailing-slash.mjs.
 */

/** Old section root -> new section root. Both spelled without a trailing slash. */
export const RETIRED_SECTIONS = Object.freeze({
  '/builds': '/projects',
});

/**
 * Matches every shape a section URL arrives in: the root with or without a trailing slash, its
 * `.md` sibling, and anything beneath it. A path whose first segment carries a dot is a file at
 * the root and is never a section.
 */
const SECTION = /^(\/[^/.]+)(\.md)?(\/.*)?$/;

/**
 * The location a retired URL redirects to, or null to leave the request alone.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
export function retiredUrlRedirect(pathname) {
  const match = pathname.match(SECTION);
  if (!match) return null;
  const target = RETIRED_SECTIONS[match[1]];
  if (!target) return null;
  // The `.md` sibling is an extension on a slash-less path; the page carries a trailing slash.
  if (match[2]) return `${target}.md`;
  return `${target}${match[3] ?? '/'}`;
}

/**
 * The matcher entries a retired section needs in middleware.ts, so an old URL reaches the
 * function at all rather than 404ing at the routing layer. Vercel reads `config.matcher`
 * statically, so the literal list lives there and this copy exists to be diffed against it by
 * tests/retired-urls.test.mjs — and so tests/agent-surfaces.test.mjs can account for two matcher
 * entries that are neither negotiable pages nor agent surfaces.
 */
export const RETIRED_URL_MATCHER = ['/builds/:path*', '/builds.md'];
