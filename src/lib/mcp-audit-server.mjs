/**
 * The MCP server the /mcp endpoint serves: its tools, and the shape of what they hand back.
 *
 * Pure in the sense that matters here — it imports the MCP SDK and zod and nothing of this site's,
 * and the audit itself arrives as an injected function. That is what lets tests/mcp-audit-server
 * .test.mjs drive the whole tool with a fake auditor and no network, and it is also why this file
 * does not import `@mattpyle/steward`: that import is a TypeScript source file the Vite build
 * transpiles, and a plain `node --test` run cannot load it. The transport file makes the import and
 * passes the function in. Same split as src/lib/a2a-responder.mjs and src/pages/a2a.ts.
 *
 * **Two tiers, two shapes, and the shape follows from the cost.** `audit_site` is the fast checks —
 * a dozen HTTP round trips, seconds — so it runs inside the function that answered the request and
 * the report comes back in the call. `deep_audit` renders pages in a real browser on a hosted
 * worker and takes minutes, past what any MCP client holds a tool call open for, so it returns a
 * durable handle and `get_audit` reads it back. Neither shape is a preference; each is the only one
 * its tier can have.
 *
 * The deep half is registered only when the transport hands this file a Temporal connection, so a
 * deployment without one serves the fast tool alone and a test can drive that tool with no Temporal
 * anywhere.
 *
 * **Every document is reachable through a tool, and this server registers no resources at all.**
 * Chat clients (claude.ai, Claude desktop, Cowork) call tools but cannot read resources, so a report
 * reachable only through a resource is unreachable from the largest population of agents. That is
 * the stage-2 card's design-input rule; the fast tool satisfies it by construction, and `get_audit`
 * is what satisfies it for the deep tier.
 *
 * Both renderings ship in the one response. The canonical JSON goes in `structuredContent`, for a
 * caller that wants to reason about individual checks; the markdown summary goes in the text
 * content, for a caller that is going to read it to a person. They are the same measurement — the
 * markdown is a pure function of the JSON — so the two cannot disagree.
 *
 * There is no tier switch argument on either tool, and there are two tool names instead. A `deep:
 * true` flag on `audit_site` would make one tool answer synchronously sometimes and asynchronously
 * otherwise, which is two contracts wearing one name — and a client that passed the flag by
 * accident would get a workflow ID where it expected findings.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * The name a client sees after `initialize`, and the name the registry listing carries.
 *
 * `steward-audit`, matching the auditor's User-Agent product token exactly. One identity: the
 * server a client connects to, the visitor a target site sees in its access log, and the page
 * `/steward` that explains both are the same thing under the same name. The previous name,
 * `mattpyle-com-audit`, described where the endpoint is hosted rather than what is doing the
 * auditing, and would have left a site owner with two names to connect by hand.
 */
export const SERVER_NAME = 'steward-audit';

/** The fast tool. Named here so the endpoint's GET help and the tests read it from one place. */
export const TOOL_NAME = 'audit_site';

/**
 * The deep tier's two tools, registered only when the endpoint has a Temporal
 * connection to hand them (`createAuditServer`'s `deep` argument).
 *
 * Two rather than one for the reason stage 1 established and nothing since has
 * changed: a deep audit renders pages in a real browser and takes minutes, which
 * is longer than any MCP client holds a tool call open, so `deep_audit` hands back
 * a durable handle and `get_audit` reads it. That is not a convenience — it is the
 * only shape in which this tool can exist at all.
 *
 * **Tools, not resources.** The chat clients that make up the largest population
 * of agents — claude.ai, Claude desktop, Cowork — call tools and do not read
 * resources, so a report reachable only through a resource is unreachable from
 * most of the callers this endpoint exists for. The stage-2 rule stands: every
 * document a caller needs is reachable through a tool. This endpoint registers no
 * resources at all, which is the same rule with nothing left over.
 */
export const DEEP_TOOL_NAME = 'deep_audit';
export const GET_AUDIT_TOOL_NAME = 'get_audit';

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

/**
 * What a client is told this server is, before it calls anything.
 *
 * The User-Agent is interpolated rather than written out, because it is the auditor's and this file
 * is not where the auditor is defined. Every number and string describing the auditor comes in from
 * `AUDIT_VERSION` and `AUDIT_USER_AGENT` in the Steward workspace, through the one exports entry the
 * transport already imports; nothing here is a copy that can go stale.
 *
 * @param {string} userAgent the string the audit's requests actually carry
 * @param {boolean} withDeep whether the deep tools are registered on this server
 * @returns {string}
 */
function instructionsFor(userAgent, withDeep) {
  const base =
    'Audits any website for agent-readiness. It checks what a site says about itself over plain ' +
    'HTTP: robots.txt and its AI-agent rules, Content Signals, the sitemap, llms.txt and whether ' +
    'its links resolve, agents.md, the well-known MCP and A2A discovery documents, and whether the ' +
    'homepage and a content page actually serve markdown when asked for it. It checks behaviour ' +
    'rather than presence — a 200 from /llms.txt that is really the site\'s HTML 404 page is a ' +
    `failure here. It obeys the target's robots.txt and arrives as \`${userAgent}\`, so one audit ` +
    'is one visitor in the target log. ';
  const fast =
    `\`${TOOL_NAME}\` runs those checks and returns the finished report in the same call, in ` +
    'seconds — there is nothing to poll.';
  if (!withDeep) {
    return `${base}${fast} Rendered-page checks (Lighthouse, axe) are not part of this endpoint.`;
  }
  return (
    `${base}${fast} ` +
    `\`${DEEP_TOOL_NAME}\` adds the rendered half: it opens up to three of the site's own pages in ` +
    'a real browser and reports Lighthouse per-axis scores and axe-core violation counts across ' +
    'them. That takes minutes rather than seconds, so it returns a workflow ID immediately and ' +
    `\`${GET_AUDIT_TOOL_NAME}(workflowId, view)\` reads it back: view "status" until "done" is ` +
    'true, then "report" for the canonical JSON or "summary" for markdown. Deep audits are capped ' +
    'per caller and in total per day, because each one costs real browser time on a hosted worker. ' +
    'Powered by Temporal: a started audit is durable and survives a worker restart.'
  );
}

const TOOL_DESCRIPTION =
  'Audits one site for agent-readiness and returns the finished report in this call — there is ' +
  'nothing to poll and no second request to make. Takes seconds. structuredContent carries the ' +
  'canonical JSON, one entry per check with evidence and a fix; the text content is the same ' +
  'report as a markdown summary, ready to read to a person. The unit audited is a site, not a ' +
  'page: any path in the URL is ignored.';

/**
 * Request shapes this endpoint refuses outright, before the rate limiter and before the transport.
 *
 * Exactly one of them: a JSON-RPC **batch**. The endpoint's whole cost model is one audit per POST
 * — that is what the rate limiter counts and what the 429 promises — and an array body silently
 * breaks the arithmetic. The SDK's transport parses an array into N messages and dispatches every
 * one, so a batch of ten `tools/call` members is ten audits at a stranger's origin against a single
 * increment: a 10x bypass of both the per-caller and the global limit, and a way to drain the day's
 * budget for everyone else in one request.
 *
 * Counting the members instead was the obvious alternative and is worse: it makes the limiter's
 * unit ambiguous (is a refused batch one strike or ten?), it has to stay in step with a fan-out
 * happening inside the SDK, and it buys a client nothing. **Batching was removed from the MCP
 * protocol in 2025-06-18**, the version this server speaks, so nothing conformant sends one; a
 * client old enough to try is one that would also be sending a protocol version this server does
 * not negotiate.
 *
 * A non-array body is returned as `null` even when it is plainly invalid — a string, a number,
 * `null` itself. This guard has one job, and the SDK's own schema parse produces a better error for
 * those than a second opinion here would.
 *
 * @param {unknown} body the parsed request body
 * @returns {{ status: number, payload: object } | null} the refusal, or null to carry on
 */
export function refusalForBody(body) {
  if (!Array.isArray(body)) return null;
  return {
    status: 400,
    payload: {
      jsonrpc: '2.0',
      // A batch has no single id to answer under, which is the case the spec reserves null for.
      id: null,
      error: {
        code: -32600,
        message:
          'Invalid Request: this endpoint takes one request per POST, not a JSON-RPC batch. ' +
          'Batching was removed from the MCP specification in version 2025-06-18. Send each ' +
          'request as its own POST.',
      },
    },
  };
}

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
 * `version` and `userAgent` are injected for the same reason `runAudit` is: they belong to the
 * auditor, which lives in the Steward workspace, and this file imports nothing of it. The transport
 * (src/pages/mcp.ts) already imports that workspace and passes them straight through, so the server
 * a client connects to and the visitor the target site logs cannot announce different versions.
 *
 * `deep` is optional and is the whole of the deep tier's presence here: absent,
 * the two deep tools are not registered and the endpoint is exactly the
 * synchronous one-tool server it was. That is what keeps a test able to drive the
 * fast tool with no Temporal anywhere, and it is also the endpoint's degradation
 * story stated structurally rather than in a catch block.
 *
 * @param {{
 *   runAudit: (url: string) => Promise<any>,
 *   renderSummary: (audit: any) => string,
 *   normaliseTarget: (input: string) => { origin: string, url: URL },
 *   version: string,
 *   userAgent: string,
 *   deep?: {
 *     startAudit: (origin: string, url: string) => Promise<{ workflowId: string }>,
 *     readView: (workflowId: string, view: 'status' | 'report' | 'summary') => Promise<string>,
 *   },
 * }} engine
 * @returns {McpServer}
 */
export function createAuditServer({
  runAudit,
  renderSummary,
  normaliseTarget,
  version,
  userAgent,
  deep,
}) {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    { instructions: instructionsFor(userAgent, Boolean(deep)) },
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

  if (deep) registerDeepTools(server, deep, normaliseTarget);

  return server;
}

/**
 * The deep tier's two tools.
 *
 * Split into its own function rather than inlined, so the fast half above reads
 * as it did before this existed and the whole deep surface is one block a reader
 * can skip or scrutinise.
 *
 * @param {McpServer} server
 * @param {{ startAudit: Function, readView: Function }} deep
 * @param {(input: string) => { origin: string, url: URL }} normaliseTarget
 */
function registerDeepTools(server, deep, normaliseTarget) {
  server.registerTool(
    DEEP_TOOL_NAME,
    {
      title: 'Start a deep, browser-rendered audit of a site',
      description:
        'Starts a deep agent-readiness audit and returns its workflow ID straight away — it does ' +
        'NOT wait for the result and there is no report in this response. The deep tier opens up ' +
        "to three of the site's own pages in a real browser and reports Lighthouse's per-axis " +
        'scores and axe-core violation counts across them, on top of everything audit_site ' +
        `checks. It takes minutes. Poll ${GET_AUDIT_TOOL_NAME}(workflowId, view: "status") until ` +
        '"done" is true, then read view "report" or "summary". Deep audits are strictly capped ' +
        'per caller and per day; if you only need the HTTP-level checks, call audit_site instead ' +
        'and get the whole report in one call.',
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe(
            'The site to audit: https://example.com, or just example.com. Any path is ignored — ' +
              'the unit audited is a site.',
          ),
      },
      outputSchema: {
        workflowId: z.string().describe('Pass this to get_audit. Valid while Temporal keeps the run.'),
        origin: z.string(),
        tier: z.literal('deep'),
        expectedDuration: z.string(),
        nextStep: z.string(),
      },
      annotations: {
        // It starts a durable run against a third party's origin and spends real
        // browser time doing it. Not a read of this server's own state, and two
        // calls are two audits.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      const origin = originFor(url, normaliseTarget);
      const { workflowId } = await deep.startAudit(origin, url);
      const structuredContent = {
        workflowId,
        origin,
        tier: 'deep',
        expectedDuration: 'a few minutes',
        nextStep: `${GET_AUDIT_TOOL_NAME}("${workflowId}", "status")`,
      };
      return {
        structuredContent,
        content: [
          {
            // Said in words as well as in the structured half, because the
            // failure this guards against is a model reading a successful tool
            // result as a finished audit and summarising an empty report as a
            // clean site.
            type: 'text',
            text:
              `Started a deep audit of ${origin}. **This is running now and is not finished, and ` +
              'there are no findings in this response.**\n' +
              `Workflow ID: ${workflowId}\n` +
              `Call ${GET_AUDIT_TOOL_NAME}("${workflowId}", "status") until "done" is true — ` +
              'expect a few minutes — then call it with view "report" if "succeeded" is true. If ' +
              '"queued" is true the audit is durable and waiting for the worker, and ' +
              '"queuePosition" says where it stands.',
          },
        ],
      };
    },
  );

  server.registerTool(
    GET_AUDIT_TOOL_NAME,
    {
      title: 'Read one deep audit',
      description:
        'Reads one audit started by deep_audit: view "status" for whether it has finished, ' +
        '"report" for the canonical JSON of a finished one, "summary" for the same report as ' +
        'markdown. Poll status until "done" is true — done means the run ended, either way — then ' +
        '"succeeded" says whether there is a report to read and "error" says why if there is not. ' +
        'While it runs, "progress" lists each unit of work and "pending" carries the attempt ' +
        'number of anything being retried. If the finished report is incomplete, "integrity" says ' +
        'so and says which half can still be read. Reading report or summary before the run ends ' +
        'is an error rather than a partial document. For status and report, structuredContent ' +
        'carries the same document as data, so there is no JSON to parse out of the text; summary ' +
        'is markdown and comes back as text alone.',
      inputSchema: {
        workflowId: z
          .string()
          .min(1)
          .describe('The ID deep_audit returned, e.g. steward-audit-example.com-deep-1a2b3c4d.'),
        view: z
          .enum(['status', 'report', 'summary'])
          .optional()
          .describe('Which document to read. Defaults to status, the one that is always readable.'),
      },
      annotations: {
        // A read of a run's own state. The same read twice is the same answer
        // once the run has ended.
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workflowId, view }) => {
      const resolved = view ?? 'status';
      const text = await deep.readView(workflowId, resolved);
      // Status and report are JSON documents that were being handed over as prose, so a client
      // wanting them as data had to parse a text block — the Hermes canary's daily script did
      // exactly that on its first run. The structured half is the parse of this same string and
      // nothing else: one document, two renderings, no reshaping that could let them disagree.
      // Summary is markdown, so it has no structured half to carry.
      if (resolved === 'summary') return { content: [{ type: 'text', text }] };
      return { structuredContent: JSON.parse(text), content: [{ type: 'text', text }] };
    },
  );
}
