/**
 * Which paths count as an agent surface, and what one log line about a request to one looks like.
 *
 * Pure and dependency-free so it can be tested (tests/agent-surfaces.test.mjs) without a deploy;
 * `middleware.ts` is the only caller and does nothing with the result but `console.log` it and
 * fall through to `next()`. Same split as src/lib/a2a-responder.mjs and its transport.
 *
 * Why this exists at all: static files never reach a function, so on this plan a fetch of
 * /llms.txt or /agents.md leaves no trace in the dashboard logs. Routing Middleware runs before
 * static serving, so listing a path in the matcher is what makes the request visible.
 */

/**
 * The discovery documents the site advertises, matched exactly.
 *
 * Included because each one is a document this site publishes *for* agents and points at from
 * somewhere machine-readable: llms.txt and llms-full.txt (the llms.txt convention), agents.md
 * (linked from llms.txt and robots-adjacent convention), robots.txt (names the sitemap and the
 * AI crawlers), and the two WebMCP catalogs.
 *
 * The sitemaps are in for one reason: robots.txt names sitemap-index.xml, so it is a surface an
 * agent is told to fetch. Expect crawler noise there; it is separable by path.
 *
 * Deliberately out: /rss.xml (feed pollers would swamp the signal and a reader is not an agent),
 * favicons, /site.webmanifest, and OG images (browser furniture, no discovery meaning).
 */
export const AGENT_SURFACE_PATHS = [
  '/llms.txt',
  '/llms-full.txt',
  '/agents.md',
  '/robots.txt',
  '/webmcp/tools.json',
  '/webmcp/index.json',
  '/sitemap-index.xml',
  '/sitemap-0.xml',
];

const EXACT = new Set(AGENT_SURFACE_PATHS);

/**
 * The whole /.well-known subtree, not just agent-card.json. A request for a well-known path this
 * site does not serve is the more interesting record of the two: it says what a client expected
 * to find. Those 404 exactly as before; the middleware only watches them.
 */
const WELL_KNOWN_PREFIX = '/.well-known/';

/**
 * The well-known documents this site actually serves, named rather than left to the prefix rule.
 *
 * isAgentSurface() already returns true for every one of these — the prefix covers them and the
 * matcher fronts the subtree — so nothing about logging depends on this list. It exists because
 * "covered by a prefix" is not the same as "checked": scripts/agent-surface-parity.mjs probes
 * these by name across a deploy, and tests/agent-surfaces.test.mjs asserts each is recognised, so
 * a regression in the prefix rule fails against real paths instead of hypothetical ones.
 *
 * The Agent Skills entries are the instrument for that card's hypothesis. The index and the skill
 * are separate lines in the log on purpose: "something fetched the index" and "something that
 * fetched the index went on to fetch the skill" are different findings, and only the second one
 * says an agent did anything with what it discovered.
 */
export const WELL_KNOWN_SURFACE_PATHS = [
  '/.well-known/agent-card.json',
  '/.well-known/agent-skills/index.json',
  '/.well-known/agent-skills/using-mattpyle-com/SKILL.md',
];

/** Trailing slash tolerated so /llms.txt/ logs as the same surface; '/' itself is not a surface. */
function normalize(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

export function isAgentSurface(pathname) {
  const path = normalize(pathname);
  return EXACT.has(path) || path.startsWith(WELL_KNOWN_PREFIX);
}

/**
 * One line, key=value, values JSON-quoted so a value containing spaces stays one field. Matches
 * the [a2a] line's shape on purpose: whatever reads these later (the store and page on the
 * agent-hit-counter card) should never have to parse prose.
 *
 * Three fields and no more, per the card's Done when: path, client, and what it asked for. No IP,
 * no headers beyond Accept, nothing that identifies a person.
 */
export function formatSurfaceLine({ path, ua, accept }) {
  const fields = {
    path,
    ua: ua ?? '',
    accept: accept ?? '',
  };
  return `[agent-surface] ${Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ')}`;
}
