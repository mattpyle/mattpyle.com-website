import type { APIRoute } from 'astro';
import { createTools } from '../../lib/webmcp-tools.mjs';
import { WEBMCP_TOOL_NOTES, WEBMCP_VERIFIED } from '../../data/webmcp-catalog.mjs';

/**
 * The machine-readable tool manifest, prerendered to dist/webmcp/tools.json at build.
 *
 * It exists for the agents that can't execute JavaScript — which today is most of them. Those
 * agents cannot call the tools (registration is a browser API), but they can at least read what
 * the surface is without scraping /webmcp's HTML.
 *
 * NOT a convention. WebMCP defines no discovery path, well-known file, or manifest format; this
 * URL is this site's own invention. The path conventions that do exist (/.well-known/mcp-server,
 * /mcp) belong to hosted MCP servers, which this site does not run, and are deliberately unused.
 *
 * GENERATED FROM THE REAL TOOLS. `name`, `description`, and `inputSchema` are read off the tool
 * objects createTools() returns, so the manifest is definitionally what an agent receives. Only
 * the editorial fields (kind/returns/example) come from src/data/webmcp-catalog.mjs.
 */

/**
 * Build-time stub for the tools' index fetch. createTools() only calls getIndex inside a handler's
 * execute(), never while building the definitions — so this must never fire. It throws rather than
 * returning an empty object so a future refactor that moves I/O into definition time fails loudly
 * here instead of silently emitting a manifest built from nothing.
 */
const throwingGetIndex = () => {
  throw new Error('tools.json reads tool definitions only; it must never execute a handler');
};

/** Exported so tests/webmcp-catalog.test.mjs can assert the payload without running Astro. */
export function buildToolsPayload(base: string) {
  return {
    generated: new Date().toISOString(),
    docs: `${base}/webmcp/`,
    index: `${base}/webmcp/index.json`,
    verified: { date: WEBMCP_VERIFIED.iso, chrome: WEBMCP_VERIFIED.chrome },
    note:
      'An experiment, not a supported API. These tools are registered on document.modelContext in ' +
      'the browser, so only an in-browser agent that implements WebMCP can call them. If you are ' +
      'reading this file rather than executing JavaScript on the live site, fetch the index URL ' +
      'above instead — it holds the same content these tools read.',
    tools: createTools(throwingGetIndex).map((tool) => {
      const notes = WEBMCP_TOOL_NOTES[tool.name as keyof typeof WEBMCP_TOOL_NOTES];
      return {
        name: tool.name,
        description: tool.description,
        kind: notes.kind,
        inputSchema: tool.inputSchema,
        returns: notes.returns,
        example: notes.example,
        // `in` rather than a truthiness check: only the write tool carries this field, so a
        // plain `notes.notes` doesn't type-check against the union of the four note objects.
        ...('notes' in notes ? { notes: notes.notes } : {}),
      };
    }),
  };
}

export const GET: APIRoute = async ({ site }) => {
  // Derive the host from astro.config.mjs `site` so this file can never emit a
  // different host than the canonicals and sitemap do.
  const base = site!.toString().replace(/\/$/, '');

  return new Response(JSON.stringify(buildToolsPayload(base), null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
