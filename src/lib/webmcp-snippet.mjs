/**
 * Builds the one-line call shown in each /webmcp tool card's "How an agent calls it" panel.
 *
 * Shared by the page's frontmatter (which renders the initial snippet at build time) and its
 * client script (which rewrites the snippet as the try-it controls change), so the two can't
 * disagree about the calling convention.
 *
 * THE CONVENTION IS MEASURED, NOT ASSUMED (Chrome 150, 2026-07-17): the method is `executeTool`,
 * and its arguments arrive as a JSON **string**. Passing an object throws
 * `Failed to parse input arguments`.
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
 * @returns {string}
 */
export function buildToolSnippet(name, args = {}) {
  const json = JSON.stringify(args ?? {});
  return `await document.modelContext.executeTool('${name}', '${forSingleQuotedLiteral(json)}')`;
}
