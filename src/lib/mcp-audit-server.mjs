/**
 * The MCP server the /mcp endpoint serves: one tool, and the shape of what it hands back.
 *
 * Pure in the sense that matters here — it imports the MCP SDK and zod and nothing of this site's,
 * and the audit itself arrives as an injected function. That is what lets tests/mcp-audit-server
 * .test.mjs drive the whole tool with a fake auditor and no network, and it is also why this file
 * does not import `@mattpyle/steward`: that import is a TypeScript source file the Vite build
 * transpiles, and a plain `node --test` run cannot load it. The transport file makes the import and
 * passes the function in. Same split as src/lib/a2a-responder.mjs and src/pages/a2a.ts.
 *
 * **One tool, and the report comes back in the call.** The stage-1 local server's `audit_site`
 * starts a Temporal workflow and returns an ID, because a deep audit is minutes long and no MCP
 * client holds a tool call open that long. The public tier is the fast checks only, which is
 * seconds, so it answers synchronously — and that is not merely convenient. Chat clients
 * (claude.ai, Claude desktop, Cowork) call tools but cannot read resources, so a report reachable
 * only through a resource is unreachable from the largest population of agents; the stage-2 card's
 * design-input rule is that every document a caller needs is reachable through a tool. A
 * synchronous call satisfies it by construction: there is nothing to fetch afterwards.
 *
 * Both renderings ship in the one response. The canonical JSON goes in `structuredContent`, for a
 * caller that wants to reason about individual checks; the markdown summary goes in the text
 * content, for a caller that is going to read it to a person. They are the same measurement — the
 * markdown is a pure function of the JSON — so the two cannot disagree.
 *
 * There is no tier switch on the tool. The deep tier renders pages in a real browser and stays CLI
 * and local (stage-2 card); an argument that can only take one value is a promise the endpoint
 * would have to keep later.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const SERVER_NAME = 'mattpyle-com-audit';
export const SERVER_VERSION = '0.1.0';

/** The one tool. Named here so the endpoint's GET help and the tests read it from one place. */
export const TOOL_NAME = 'audit_site';

/**
 * The output schema, mirroring the audit document's top level and going no deeper.
 *
 * Every nested object is loose on purpose. The canonical schema lives in Steward's `result.ts` and
 * this is a second copy of it by definition, so the interesting question is what happens when the
 * two drift: a strict copy turns a successful audit into an `Output validation error` and the
 * caller gets nothing, which is a far worse failure than a client seeing a field this schema did
 * not announce. Declaring the top level is enough for a client to know what it is holding;
 * `schemaVersion` is in the document for the rest.
 */
const AUDIT_OUTPUT_SHAPE = {
  schemaVersion: z.number().describe('The audit document schema version.'),
  tool: z.looseObject({ name: z.string(), version: z.string() }),
  target: z.looseObject({ input: z.string(), origin: z.string() }),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  requests: z.number().describe('How many HTTP requests the audit made at the target.'),
  categories: z
    .array(z.looseObject({ category: z.string() }))
    .describe('Per-category pass/fail counts. There is deliberately no composite score.'),
  checks: z
    .array(
      z.looseObject({
        id: z.string(),
        title: z.string(),
        category: z.string(),
        severity: z.string(),
        status: z.string().describe('pass, fail, not-applicable or error.'),
        observed: z.string(),
      }),
    )
    .describe('Every check, with its verdict, its evidence, and a fix where it failed.'),
  notes: z.array(z.string()).describe('What the audit could not do, in its own words.'),
};

const INSTRUCTIONS =
  'Audits any website for agent-readiness and returns the report in the same call. It checks what ' +
  'a site says about itself over plain HTTP: robots.txt and its AI-agent rules, Content Signals, ' +
  'the sitemap, llms.txt and whether its links resolve, agents.md, the well-known MCP and A2A ' +
  'discovery documents, and whether the homepage and a content page actually serve markdown when ' +
  'asked for it. It checks behaviour rather than presence — a 200 from /llms.txt that is really ' +
  "the site's HTML 404 page is a failure here. It obeys the target's robots.txt, identifies " +
  'itself honestly, and takes seconds. Rendered-page checks (Lighthouse, axe) are not part of this ' +
  'endpoint.';

const TOOL_DESCRIPTION =
  'Audits one site for agent-readiness and returns the finished report in this call — there is ' +
  'nothing to poll and no second request to make. Takes seconds. structuredContent carries the ' +
  'canonical JSON, one entry per check with evidence and a fix; the text content is the same ' +
  'report as a markdown summary, ready to read to a person. The unit audited is a site, not a ' +
  'page: any path in the URL is ignored.';

/**
 * The one refusal the tool makes before doing any work: a target it cannot audit at all.
 *
 * Separate from the checks, because "this is not a URL" and "this site has no llms.txt" are
 * different kinds of answer — the second is a finding and the first is a request that never
 * started. Returned as a thrown error so the SDK renders it as a tool error the client can see,
 * rather than as an empty report a model would summarise as a clean site.
 *
 * The scheme is read off the parsed URL and NOT off the origin, which is the shape this was first
 * written in and is wrong: a URL with a non-special scheme has the opaque origin `"null"`, so
 * `file:///etc/passwd` reached `new URL('null')` and came back as a bare `TypeError: Invalid URL`.
 * Same refusal either way, but the caller was told nothing about why.
 *
 * @param {string} url
 * @param {(input: string) => { origin: string, url: URL }} normalise
 * @returns {string} the origin to audit
 */
export function originFor(url, normalise) {
  let target;
  try {
    target = normalise(url);
  } catch {
    throw new Error(`"${url}" is not a URL. Try https://example.com, or just example.com.`);
  }
  if (!/^https?:$/.test(target.url.protocol)) {
    throw new Error(`Only http and https targets are audited; "${url}" is neither.`);
  }
  return target.origin;
}

/**
 * Builds the server.
 *
 * @param {{
 *   runAudit: (url: string) => Promise<any>,
 *   renderSummary: (audit: any) => string,
 *   normaliseTarget: (input: string) => { origin: string, url: URL },
 * }} engine
 * @returns {McpServer}
 */
export function createAuditServer({ runAudit, renderSummary, normaliseTarget }) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    TOOL_NAME,
    {
      title: 'Audit a site for agent-readiness',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe(
            'The site to audit: https://example.com, or just example.com. Any path is ignored — ' +
              'the unit audited is a site.',
          ),
      },
      outputSchema: AUDIT_OUTPUT_SHAPE,
      annotations: {
        // It reads a third party's site and changes nothing, anywhere. Not idempotent in the sense
        // that matters to a client, though: two calls are two audits, and the second one may
        // legitimately disagree with the first because the site changed underneath it.
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      // Validated before the audit starts, so a caller who typed a hostname wrong is told so
      // immediately rather than after the fetch layer refuses it.
      originFor(url, normaliseTarget);
      const audit = await runAudit(url);
      return {
        structuredContent: audit,
        content: [{ type: 'text', text: renderSummary(audit) }],
      };
    },
  );

  return server;
}
