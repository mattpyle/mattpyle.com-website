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
 * When the tool behaviour below was last measured against the live origin trial.
 *
 * 2026-08-02 raised this to EXTERNAL-CLIENT level for the WHOLE surface: a client running outside
 * the page (the Model Context Tool Inspector side panel) enumerated all six tools on production and
 * invoked every one of them. Nothing on /webmcp now rests on a page-side measurement.
 *
 * The earlier dates covered narrower claims, and the difference is the point. 2026-07-24 raised
 * this from handler-level to PROTOCOL-level by driving the tools through
 * `document.modelContext.executeTool` on the deployed site rather than calling the handlers
 * directly, which established the real `executeTool` signature (see src/lib/webmcp-snippet.mjs)
 * and reconfirmed that Chrome ignores `inputSchema` — but the caller was the page itself for four
 * of the tools, and only `set_appearance` was ever driven from outside it.
 *
 * NOT a build date. It feeds the visible "verified" line on /webmcp, that page's JSON-LD
 * `dateModified`, and the `/webmcp/` sitemap lastmod, mirroring how SCORECARD_VERIFIED works.
 * Advance it only when the behaviour is re-measured.
 */
export const WEBMCP_VERIFIED = Object.freeze({ iso: '2026-08-02', chrome: '150.0.7871.187' });

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
    returns:
      'An object with posts: title, url, date, tags, description. If a tag matches nothing, ' +
      'posts is empty and the result adds a note, the unmatched tag, the unfiltered count, and the tags that do exist.',
    example: Object.freeze({ limit: 5 }),
  }),

  search_content: Object.freeze({
    kind: 'read',
    returns:
      'An object with results: type, title, url, snippet. A query that matches nothing returns ' +
      'an empty results with a note naming the query and the corpus that was searched.',
    example: Object.freeze({ query: 'webmcp' }),
  }),

  set_appearance: Object.freeze({
    kind: 'write',
    returns: 'An object with mode and message: the mode actually applied.',
    example: Object.freeze({ mode: 'retro' }),
    notes:
      "Writes to this browser's localStorage and nothing else. No server state, no other visitor.",
  }),

  sign_guestbook: Object.freeze({
    kind: 'write',
    returns:
      'An object with ok, the entry that was written, and a confirmation message naming its number. ' +
      'A repeated identical call adds duplicate: true and returns the existing entry, unwritten.',
    example: Object.freeze({
      name: 'an agent reading this page',
      message: 'Called the tool from the catalog to see what the badge looks like.',
    }),
    notes:
      "Writes to this browser's localStorage and nothing else. The entry is recorded as " +
      'agent-written and renders with a [SIGNED BY AGENT] badge in the guest book on the homepage. ' +
      'Safe to retry: a call whose name and message match the most recent entry is treated as a replay ' +
      'and does not write a second entry, because WebMCP clients replay call history.',
  }),

  list_related_sites: Object.freeze({
    kind: 'read',
    returns: 'An object with ring (name, description) and sites: name, url, description, status.',
    example: Object.freeze({}),
  }),
});
