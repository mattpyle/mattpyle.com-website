/**
 * Builds the call shown in each /webmcp tool card's snippet panel.
 *
 * Shared by the page's frontmatter (which renders the initial snippet at build time) and its
 * client script (which rewrites the snippet as the try-it controls change), so the two cannot
 * disagree about the calling convention.
 *
 * THE CONVENTION IS RUN, NOT REASONED (Chrome 150.0.7871.182, 2026-07-24, against the live origin
 * trial on https://www.mattpyle.com). Two arguments, both fussy:
 *
 *   1. `executeTool` takes a **RegisteredTool object**, not a tool name. A name throws
 *      `TypeError: … The provided value is not of type 'RegisteredTool'`. The objects come from
 *      `document.modelContext.getTools()`, which is the discovery half of the API.
 *   2. Arguments arrive as a **JSON string**. An object throws `UnknownError: Failed to parse input
 *      arguments`.
 *
 * Both arguments are required — calling with one throws "2 arguments required". The return value is
 * a JSON string, so callers parse it themselves.
 *
 * This file previously emitted `executeTool('<name>', '<json>')`, which throws. That string was
 * corrected once already, from the design bundle's `callTool(name, {object})` — a correction that
 * fixed the method and the argument type but kept the wrong first-argument *kind*, because it was
 * reasoned from prose rather than executed. Change this string only against a browser.
 */

/**
 * Escape a JSON payload for embedding in a single-quoted JavaScript string literal.
 *
 * JSON.stringify escapes what JSON needs, not what a JS string literal needs. A `query` of
 * `it's` produces `{"query":"it's"}`, and dropping that between single quotes ends the literal
 * early — the copy button would hand out a snippet that doesn't parse. Backslashes are doubled
 * first so the quote escapes added next aren't themselves re-escaped.
 *
 * @param {string} json
 */
function forSingleQuotedLiteral(json) {
  return json.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * @param {string} name  the registered tool name
 * @param {Record<string, unknown>} [args]  arguments to show, JSON-encoded into the call
 * @returns {string} a runnable two-line snippet
 */
export function buildToolSnippet(name, args = {}) {
  const json = JSON.stringify(args ?? {});
  return [
    `const tool = (await document.modelContext.getTools()).find(t => t.name === '${name}');`,
    `await document.modelContext.executeTool(tool, '${forSingleQuotedLiteral(json)}');`,
  ].join('\n');
}
