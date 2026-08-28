/**
 * Slash normalisation: which request paths owe a 308 to the trailing-slash form.
 *
 * The site has one canonical shape for a page URL and it carries a trailing slash. Every canonical,
 * sitemap entry, OG URL, and JSON-LD `item` says so, and since 2026-08-07 every internal link does
 * too. This is the rule that makes the slash-less form redirect instead of serving a duplicate.
 *
 * WHY THIS IS IN THE MIDDLEWARE AND NOT `vercel.json`. The obvious spelling is `"trailingSlash":
 * true`, one line of platform config. It was built that way first and measured on a preview
 * deployment, and it broke two things, because the platform's redirect fires *before* middleware:
 *
 *   - `Accept: text/markdown` on a slash-less page URL 308'd instead of returning markdown. The
 *     negotiation below never saw the request. That is the request shape most likely to be held by
 *     an agent, which is the whole point of the negotiation.
 *   - `POST /a2a` 308'd. It is an extension-less function route, so the platform rule caught it, and
 *     a client that does not follow redirects on POST loses the endpoint the Agent Card, agents.md,
 *     and the `_a2a._agents` DNS record all publish.
 *
 * Doing it here puts the ordering under our control: negotiation answers first and this runs after,
 * so a markdown request is served rather than redirected. And the matcher decides the blast radius,
 * so `/a2a` — deliberately not in it — is never reached by this rule at all.
 *
 * Pure so tests/trailing-slash.test.mjs can cover it without a deploy. Same split as
 * agent-surfaces.mjs, markdown-negotiation.mjs, and on-demand-routes.mjs — and its one import is
 * from the first of those, for the reason the exemption below gives.
 */

import { WELL_KNOWN_SURFACE_PATHS } from './agent-surfaces.mjs';

/**
 * Discovery documents whose path is fixed by a specification and carries no extension.
 *
 * `/.well-known/mcp-server` is the first: draft-serra-mcp-discovery-uri spells the path without a
 * suffix, so the final-segment rule below reads it as a page and would 308 it to a slash form that
 * serves nothing. A client fetching a well-known path is following a specification, not a link, and
 * it has no reason to expect a redirect there.
 *
 * Named rather than exempting the whole `/.well-known/` subtree, because the subtree also holds
 * directory-shaped paths — `/.well-known/agent-skills` — that should keep redirecting. The list is
 * the one agent-surfaces.mjs already keeps of the well-known documents this site actually serves,
 * so a new one is exempt by being registered rather than by being remembered here.
 */
const EXTENSIONLESS_DOCUMENTS = new Set(WELL_KNOWN_SURFACE_PATHS);

/**
 * The slash-form path to redirect to, or null to leave the request alone.
 *
 * Three paths are left alone, and all of them matter:
 *
 *   - Anything already ending in `/`, which is every canonical URL the site emits. Returning a
 *     target here would be a redirect loop.
 *   - Anything whose final segment carries a `.`, which is how every non-page URL on this site is
 *     spelled: the `.md` siblings, llms.txt, agents.md, robots.txt, the WebMCP JSON manifests, the
 *     `.well-known` documents. An extension path is a file, not a page, and it has no slash form.
 *     Checking only the final segment is deliberate — `/.well-known/agent-skills/foo` has a dot in
 *     an earlier segment and is still a directory-shaped path.
 *   - The extension-less well-known documents named above, which look like pages to the rule and
 *     are files.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
export function trailingSlashRedirectFor(pathname) {
  if (pathname.endsWith('/')) return null;
  if (EXTENSIONLESS_DOCUMENTS.has(pathname)) return null;
  const finalSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (finalSegment.includes('.')) return null;
  return `${pathname}/`;
}
