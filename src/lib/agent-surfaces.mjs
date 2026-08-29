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
 * `/mcp/server-card` is the only entry here that is not at the site root, and the only one whose
 * path is derived rather than fixed: SEP-2127 reserves `<streamable-http-url>/server-card`, and
 * this endpoint lives at /mcp. It is the canonical location of the Server Card, and its alias at
 * `/.well-known/mcp/server-card.json` is listed separately below. Two paths, one document, one
 * question: which convention does a client actually reach for.
 *
 * It is a sibling of /mcp and not /mcp itself, which the matcher note in middleware.ts is emphatic
 * about keeping unmatched. Adding a static file beside a POST endpoint does not put the endpoint in
 * the matcher, and tests/trailing-slash.test.mjs asserts exactly that with an equality check.
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
  '/mcp/server-card',
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
 * `/.well-known/mcp-server` is the one whose log line says the most per fetch. Nothing on this site
 * links it and no page renders it: a client that asks for it has gone looking for an MCP server
 * without being told the URL, which is the entire behaviour the discovery draft exists to enable.
 * Whether anything does that is a question the log can answer and nothing else here can.
 *
 * `/.well-known/ard.json` is the same instrument aimed at ARD. Nothing on the site links it as a
 * page; it is named only by the rel="ard" element and the well-known path itself, so a fetch of it
 * is evidence that some crawler resolves ARD entry sources at all — which is the whole question the
 * catalogue was published to answer. ARD's robots.txt directive named it too until 2026-08-28;
 * src/pages/robots.txt.ts says why it no longer does.
 *
 * `/.well-known/ai-catalog.json` is ARD's predecessor path, served by a vercel.json rewrite onto
 * ard.json rather than by a file of its own. It is listed separately from ard.json because that is
 * the measurement: the two paths carry the same bytes, so the only thing a fetch of one rather
 * than the other says is which dialect the client speaks, and a single merged line would throw
 * exactly that away.
 *
 * `/.well-known/mcp/server-card.json` is the Server Card's scanner path, served by a vercel.json
 * rewrite onto /mcp/server-card rather than by a file of its own, exactly as ai-catalog.json is
 * onto ard.json. It is listed separately from the canonical path for the same reason the two
 * catalogue paths are listed separately, and here the split is the whole experiment: SEP-2127's
 * discovery.md argues that a server card does not belong under `.well-known` at all, while
 * Cloudflare's scanner probes nowhere else. The two paths carry the same bytes, so the only thing a
 * fetch of one rather than the other says is which of those two the client believes — which is
 * precisely the finding, and a single merged line would throw it away.
 *
 * The Agent Skills entries are the instrument for that card's hypothesis. The index and each skill
 * are separate lines in the log on purpose: "something fetched the index" and "something that
 * fetched the index went on to fetch the skill" are different findings, and only the second one
 * says an agent did anything with what it discovered. One line per skill rather than one for the
 * subtree, so which skill an agent came for is answerable too.
 */
export const WELL_KNOWN_SURFACE_PATHS = [
  '/.well-known/agent-card.json',
  '/.well-known/mcp-server',
  '/.well-known/ard.json',
  '/.well-known/ai-catalog.json',
  '/.well-known/mcp/server-card.json',
  '/.well-known/agent-skills/index.json',
  '/.well-known/agent-skills/implement-markdown-negotiation/SKILL.md',
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
 * One line, `[tag] key=value ...`, every value JSON-quoted so a value containing a space, a quote,
 * or a newline stays one field. Matches the [a2a] line's shape on purpose: whatever reads these
 * later (the store and page on the agent-hit-counter card) should never have to parse prose.
 *
 * Every structured log line on the site goes through here. That is the point of the function
 * rather than of any one call site: a request-controlled value reaching a hand-built line is how
 * forged records get in, and a slug is request-controlled twice over — Astro decodes the pathname
 * with `decodeURI` before deriving params, so `%0A` arrives as a real newline that a template
 * literal would happily emit as a second, entirely fictional log line.
 */
export function formatLogLine(tag, fields) {
  return `[${tag}] ${Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value ?? '')}`)
    .join(' ')}`;
}

/**
 * Three fields and no more, per the agent-hit-counter card's Done when: path, client, and what it
 * asked for. No IP, no headers beyond Accept, nothing that identifies a person.
 */
export function formatSurfaceLine({ path, ua, accept }) {
  return formatLogLine('agent-surface', { path, ua: ua ?? '', accept: accept ?? '' });
}
