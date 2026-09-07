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
 * Tools this site declares on one page, in markup, rather than registering site-wide in script.
 *
 * A different kind of thing from `WEBMCP_TOOL_NOTES` below, which is an editorial layer over tool
 * objects that src/lib/webmcp-tools.mjs really builds. There is no object here to layer over: a
 * declarative tool is three attributes on a form, and Chrome builds the tool — including the input
 * schema, from the form's own controls — when it parses the page. So this list is what /webmcp and
 * /webmcp/tools.json can say about a surface that exists only in another file's markup, and
 * tests/webmcp-catalog.test.mjs joins the two by reading the `toolname` attributes out of `src/`:
 * an entry here with no form, or a form with no entry here, fails there.
 *
 * MEASURED, not assumed. Chrome 152.0.7977.76, against production on 2026-09-06: a form carrying
 * `toolname` and `tooldescription`, with `toolparamdescription` on its input, is listed by
 * `document.modelContext.getTools()` beside the six registered in script, with
 * `inputSchema` built from the form (`{"type":"object","properties":{"url":{"type":"string",
 * "description":…}},"required":["url"]}` — `required` taken from the field's own `required`
 * attribute). A form without `toolname` registers nothing; removing the form deregisters the tool.
 * `WEBMCP_VERIFIED` is deliberately not advanced by that measurement: it covers the six site-wide
 * tools driven end to end by an external client, and this was a page-side read of a tool list.
 *
 * The strings live in src/data/audit-copy.mjs beside the rest of that page's words, so the
 * description an agent reads and the attribute the form carries cannot come apart.
 */
export const WEBMCP_PAGE_TOOLS = Object.freeze([
  Object.freeze({
    name: 'run_audit',
    page: '/audit/',
    kind: 'write',
    declaredBy: 'form attributes',
    returns:
      'Nothing directly: submitting the form posts the address and the browser lands on the ' +
      'rendered report at /audit/?url=<origin>, which also answers markdown when asked for it.',
    notes:
      'The same form a visitor uses, running the same audit through the same rate limiter and the ' +
      "same 45-second budget as this site's /mcp and /a2a surfaces. It fetches the address given, " +
      "about a dozen requests, obeying that site's robots.txt.",
  }),
]);

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
