/**
 * The editorial layer over the real WebMCP tools, plus the dates /webmcp is allowed to state.
 *
 * IMPORTS NOTHING, ON PURPOSE. src/data/sitemap-lastmod.mjs imports this file, and that module
 * is loaded natively by Node from astro.config.mjs (no Vite, no TS, no `astro:` virtual modules).
 * Anything imported here would have to survive that too. Keep it pure data.
 *
 * The split is deliberate: `name`, `description`, and `inputSchema` come off the real tool objects
 * in src/lib/webmcp-tools.mjs, so neither /webmcp nor /webmcp/tools.json can describe a surface the
 * site doesn't register. Only what the tool objects genuinely lack — whether a tool reads or writes,
 * what it returns in prose, and a runnable example — lives here.
 * tests/webmcp-catalog.test.mjs guards the join in both directions.
 */

/**
 * When the tool behaviour below was last measured against the live origin trial — the date and
 * Chrome version in the doc comment at the top of src/lib/webmcp-tools.mjs.
 *
 * NOT a build date. It feeds the visible "verified" line on /webmcp, that page's JSON-LD
 * `dateModified`, and the `/webmcp/` sitemap lastmod, mirroring how SCORECARD_VERIFIED works.
 * Advance it only when the behaviour is re-measured.
 */
export const WEBMCP_VERIFIED = Object.freeze({ iso: '2026-07-17', chrome: '150' });

/**
 * When this origin's WebMCP origin-trial token expires — after which Chrome ignores it and the
 * tools silently stop registering. Matches the token comment in src/layouts/Layout.astro; keep
 * the two in sync if the token is renewed.
 */
export const ORIGIN_TRIAL_EXPIRY = '2026-11-17';

/**
 * Per-tool editorial notes, keyed by the tool's registered `name`.
 *
 * - `kind`      — 'read' or 'write'. The catalog badge and the card's top rule.
 * - `returns`   — one plain line describing the return value.
 * - `example`   — arguments the try-it console pre-fills and the manifest advertises. Must validate
 *                 against that tool's own inputSchema (asserted in tests/webmcp-catalog.test.mjs).
 * - `notes`     — optional extra sentence, used for the write tool's scope caveat.
 */
export const WEBMCP_TOOL_NOTES = Object.freeze({
  describe_site: Object.freeze({
    kind: 'read',
    returns: 'An object with person, site, and sections.',
    example: Object.freeze({}),
  }),

  get_recent_writing: Object.freeze({
    kind: 'read',
    returns: 'An object with posts: title, url, date, tags, description.',
    example: Object.freeze({ limit: 5 }),
  }),

  search_content: Object.freeze({
    kind: 'read',
    returns: 'An object with results: type, title, url, snippet.',
    example: Object.freeze({ query: 'webmcp' }),
  }),

  set_appearance: Object.freeze({
    kind: 'write',
    returns: 'An object with mode and message: the mode actually applied.',
    example: Object.freeze({ mode: 'retro' }),
    notes:
      "Writes to this browser's localStorage and nothing else. No server state, no other visitor.",
  }),
});
