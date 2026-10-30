/**
 * Builds the call shown in each /webmcp tool card's snippet panel.
 *
 * Shared by the page's frontmatter (which renders the initial snippet at build time) and its
 * client script (which rewrites the snippet as the try-it controls change), so the two cannot
 * disagree about the calling convention.
 *
 * THE TOOL ARGUMENT IS RUN, NOT REASONED (Chrome 150.0.7871.182, 2026-07-24, against the live
 * origin trial on https://www.mattpyle.com). Two arguments, both fussy:
 *
 *   1. `executeTool` takes a **RegisteredTool object**, not a tool name. A name throws
 *      `TypeError: … The provided value is not of type 'RegisteredTool'`. The objects come from
 *      `document.modelContext.getTools()`, which is the discovery half of the API.
 *   2. Arguments are a plain **object**. Chrome 150 took a JSON string and threw `UnknownError:
 *      Failed to parse input arguments` on an object. The spec changed on 2026-08-17
 *      (webmachinelearning/webmcp#246) and Chromium followed in CL 8250826 (main@{#1695589},
 *      2026-09-10), which ships in M155: `inputObject` is now `optional object`, and a string
 *      rejects with `TypeError` (WPT `webmcp/imperative/object-arguments.https.html`). This half
 *      comes from the spec, the CL and the WPT, not a live run on Chrome 155+.
 *
 * Both arguments are required — calling with one throws "2 arguments required" (Chrome 150). The
 * return value is a JSON string, so callers parse it themselves.
 *
 * This file previously emitted `executeTool('<name>', '<json>')`, which throws. That string was
 * corrected once already, from the design bundle's `callTool(name, {object})` — a correction that
 * fixed the method and the argument type but kept the wrong first-argument *kind*, because it was
 * reasoned from prose rather than executed. Change this string only against a browser.
 */

/**
 * @param {string} name  the registered tool name
 * @param {Record<string, unknown>} [args]  arguments to show, as an object literal in the call
 * @returns {string} a runnable two-line snippet
 */
export function buildToolSnippet(name, args = {}) {
  // JSON.stringify output is a valid JavaScript object literal, so it needs no quote escaping.
  const literal = JSON.stringify(args ?? {});
  return [
    `const tool = (await document.modelContext.getTools()).find(t => t.name === '${name}');`,
    `await document.modelContext.executeTool(tool, ${literal});`,
  ].join('\n');
}
