import type { APIRoute } from 'astro';
import {
  AUDIT_USER_AGENT,
  AUDIT_VERSION,
  normaliseTarget,
  renderMarkdownSummary,
  runFastAudit,
} from '@mattpyle/steward/agent-audit/fast';
import {
  createAuditServer,
  DEEP_TOOL_NAME,
  GET_AUDIT_TOOL_NAME,
  refusalForBody,
  SERVER_NAME,
  TOOL_NAME,
} from '../lib/mcp-audit-server.mjs';
import { createFastAuditRunner, withPath } from '../lib/mcp-fast-standalone.mjs';
import { checkRateLimit, clientIpFrom } from '../lib/mcp-rate-limit.mjs';
import {
  getClient,
  readAuditView,
  readTemporalConfig,
  startDeepAudit,
} from '../lib/mcp-temporal.mjs';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/**
 * The public MCP endpoint. Stateless streamable HTTP over POST; one tool; the report comes back in
 * the call.
 *
 * All the protocol logic lives in src/lib/mcp-audit-server.mjs and all the limiter logic in
 * src/lib/mcp-rate-limit.mjs, both pure and tested; this file is the transport — read the body,
 * decide whether the audit may run, hand the request to the SDK, log the outcome. Same split as
 * src/pages/a2a.ts, and for the same reason: the interesting half never needs a deploy to exercise.
 *
 * **Delete src/pages/mcp.ts and the two exports entries in agents/steward/package.json, and the
 * built site is unchanged.** Not one byte of any prerendered page depends on this route, no page
 * links to it, and nothing in the build reads it. That is the progressive-enhancement rule this
 * whole experiment runs under, made checkable, exactly as the /a2a docblock states it.
 *
 * **Two tiers on one endpoint, per the stage-3 card's transport decision.** `audit_site` answers in
 * the call, with the finished report. `deep_audit` starts a durable `auditSiteWorkflow` on Temporal
 * Cloud and `get_audit` reads it back; the hosted worker does the rendering. A second endpoint
 * would be a second identity to explain to every site owner who found the User-Agent in a log.
 *
 * **The fast tier answers whether or not Cloud does.** It runs `auditSiteFast` as a standalone
 * activity on the hosted worker where it can, and inside this function where it cannot — no
 * configuration, a failed connect, nobody on the queue, or no result inside the budget. All four
 * end with a finished report in the same call, and the answer names the path it took in
 * `tool.path`. src/lib/mcp-fast-standalone.mjs owns that choice and the arithmetic of the shared
 * budget; a caller never sees a Temporal error from the fast tool.
 *
 * The two tiers still fail independently, one step further out than they used to: the deep tools
 * return a JSON-RPC error when Cloud is unreachable, and are not registered at all when the
 * deployment carries no Temporal configuration, while the fast tool keeps answering.
 *
 * **Stateless, per the stage-2 card's transport decision.** `sessionIdGenerator: undefined`, so
 * every POST is self-contained: no session ID, no server-side session state, nothing for a second
 * request to resume. That is the only shape that fits a serverless function, where consecutive
 * requests may land on different instances, and it is all a one-shot synchronous audit needs. The
 * server and transport are built per request rather than at module scope for the same reason — an
 * instance kept warm by Fluid Compute must not carry one caller's transport into another's request.
 *
 * `enableJsonResponse: true`: the answer is one JSON object, so an SSE stream would be a framing
 * for progress this endpoint does not report.
 */
export const prerender = false;

/**
 * The audit's whole wall-clock budget, deliberately well under the function's timeout.
 *
 * A slow target must produce a JSON-RPC answer that says the audit ran out of time, not a platform
 * 504 with no body — an agent can act on the first and can only guess at the second. Steward's own
 * default is 120s, which is right for a CLI run and wrong here; the fast tier against a healthy
 * site finishes in a few seconds, and the checks report a spent budget as evidence rather than as a
 * crash (see `BudgetExhaustedError` handling in checks.ts).
 *
 * 45s sits under the 60s floor every Vercel plan has offered, so the margin does not depend on
 * which plan this project is on or on the platform's current default.
 */
const AUDIT_BUDGET_MS = 45_000;

/** JSON-RPC's own code for an implementation-defined server error. */
const RATE_LIMITED_CODE = -32000;

/**
 * Whether this deployment can run a deep audit at all.
 *
 * Read once at module scope, because the answer is a property of the deployment rather than of a
 * request — the variables are set in Vercel's environment variable store and do not change under a
 * running instance. A deployment without them (a local `npm run dev`, a preview) serves the fast
 * tool alone rather than advertising two tools of which one always errors.
 */
const DEEP_ENABLED = readTemporalConfig() !== null;

/**
 * The fast audit, run inside this function. The fallback, and the whole tool on a
 * deployment with no Temporal configuration.
 *
 * `budgetMs` is a parameter rather than the constant because the standalone path
 * hands it what is left of the one budget after a failed attempt — see
 * mcp-fast-standalone.mjs on why a fresh budget there would be a platform 504.
 */
const auditInFunction = (url: string, budgetMs: number = AUDIT_BUDGET_MS) =>
  runFastAudit(url, { policy: { totalBudgetMs: budgetMs } });

/**
 * How `audit_site` runs an audit on this deployment, decided once at module scope
 * for the reason `DEEP_ENABLED` is: it is a property of the deployment.
 *
 * With a Temporal connection the audit is a standalone `auditSiteFast` on the
 * hosted worker, shared with any other caller asking about the same site in the
 * same UTC hour, and falling back into this function on any of the four triggers.
 * Without one there is nothing to fall back from, so the in-function path is the
 * only path and the document says so rather than leaving `tool.path` absent —
 * "no field" and "ran here" are different facts and only one of them is true.
 */
const runAudit = DEEP_ENABLED
  ? createFastAuditRunner({
      getClient,
      runInFunction: auditInFunction,
      budgetMs: AUDIT_BUDGET_MS,
      log: (fields) => log(fields),
    })
  : async (url: string) => withPath(await auditInFunction(url), 'function');

/**
 * Every call, one line, with the outcome as a token rather than as prose — the same shape the
 * `[a2a]` and `[agent-surface]` lines take, so whatever eventually reads these never has to parse a
 * sentence. No IP: the limiter above holds a keyed hash of it for an hour and nothing else on this
 * site records one at all.
 */
function log(fields: Record<string, string | number>) {
  console.log(
    `[mcp] ${Object.entries(fields)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ')}`
  );
}

/**
 * The JSON-RPC id of a parsed request body, for an error answered before the SDK ever sees it.
 *
 * Anything without a usable id gets `null`, which is the id the spec reserves for an error the
 * server could not attribute to a single call.
 */
function idOf(body: unknown): string | number | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return null;
}

/**
 * Which tier's budget this body spends, or `null` for a request that spends none.
 *
 * The limiter counts audits, not handshakes: `initialize` and `tools/list` are a static answer out
 * of this function's own memory with no outbound request in them, and counting them against a
 * caller's ten would mean a client that connects, lists, and calls once had spent three.
 *
 * `get_audit` is deliberately free. It is a read of a run the caller already paid for, it makes no
 * request at anybody's origin, and charging it would mean a caller who polls politely every five
 * seconds is refused before their own audit finishes — turning the limiter into a reason not to use
 * the tool correctly. Its cost ceiling is the deep cap it sits behind: nobody has a workflow ID to
 * poll without having spent a deep slot to get one.
 *
 * One message, because `refusalForBody` has already turned every array body away. That ordering is
 * what makes this function's answer a *count* rather than a guess: while batches were admitted,
 * "any member is a tools/call" read as one audit and bought as many as the array had members.
 */
function tierFor(body: unknown): 'fast' | 'deep' | null {
  if (!body || typeof body !== 'object') return null;
  const message = body as { method?: unknown; params?: { name?: unknown } };
  if (message.method !== 'tools/call') return null;
  const name = message.params?.name;
  if (name === DEEP_TOOL_NAME) return 'deep';
  if (name === GET_AUDIT_TOOL_NAME) return null;
  // Everything else, including an unknown tool name, is counted as a fast audit. Counting an
  // unknown name costs a caller one slot for a call that was going to fail anyway, and the
  // alternative — trusting the name to decide whether to count — is a free-audit oracle for
  // anything the SDK later dispatches that this function has not been taught about.
  return 'fast';
}

/** What one request's audit did, for the success log line. Absent on a request that ran none. */
type AuditFacts = { auditPath: string; ms: number };

/** The two audit fields of the success log line, or nothing at all. */
function auditFields(facts: AuditFacts | null): Record<string, string | number> {
  return facts ? { auditPath: facts.auditPath, ms: facts.ms } : {};
}

function jsonResponse(payload: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const raw = await request.text();
  const ua = request.headers.get('user-agent') ?? '';

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    log({ path: '/mcp', http: 'POST', outcome: 'parse-error', status: 400, bytes: raw.length, ua });
    return jsonResponse(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the request body is not JSON.' } },
      400
    );
  }

  // Batches are refused before anything is counted or run. The endpoint's cost model is one audit
  // per POST, and the SDK dispatches every member of an array body, so admitting one would buy N
  // audits for a single rate-limit increment. See refusalForBody for why refusing beats counting.
  const refusal = refusalForBody(body);
  if (refusal) {
    log({ path: '/mcp', http: 'POST', outcome: 'batch-refused', status: refusal.status, bytes: raw.length, ua });
    return jsonResponse(refusal.payload, refusal.status);
  }

  // Before the audit, never after: a refused caller must cost this site nothing at the target's
  // origin, and a caller cannot hold ten slow audits open by never letting one finish. For the deep
  // tier the same rule matters more — the count happens before the workflow is started, so a
  // refused deep call costs no worker time, no Cloud action and no queue slot.
  const tier = tierFor(body);
  if (tier) {
    const verdict = await checkRateLimit({ ip: clientIpFrom(request.headers), tier });
    if (!verdict.allowed) {
      log({
        path: '/mcp',
        http: 'POST',
        outcome: `rate-limited/${tier}/${verdict.scope}`,
        status: 429,
        retryAfter: verdict.retryAfterSeconds,
        ua,
      });
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: idOf(body),
          error: {
            code: RATE_LIMITED_CODE,
            message: `Rate limited: ${verdict.reason}. Try again in ${verdict.retryAfterSeconds} seconds.`,
            data: {
              tier,
              scope: verdict.scope,
              retryAfterSeconds: verdict.retryAfterSeconds,
              ...(verdict.limit === undefined ? {} : { limit: verdict.limit }),
            },
          },
        },
        429,
        { 'Retry-After': String(verdict.retryAfterSeconds) }
      );
    }
  }

  // Per request, both of them. A stateless transport holds no session, but it does hold the
  // in-flight request's streams, and a warm function instance serves more than one caller.
  // Per request, so the success log line below can name the path this caller's audit took and how
  // long it took. Module scope would be one instance's running total rather than one call's fact.
  let audited: AuditFacts | null = null;

  const server = createAuditServer({
    runAudit: async (url: string, options: { fresh: boolean; origin: string }) => {
      const started = Date.now();
      try {
        const audit = await runAudit(url, options);
        audited = { auditPath: String(audit.tool?.path ?? 'unknown'), ms: Date.now() - started };
        return audit;
      } catch (err) {
        // A failed audit is still a measurement, and the one whose duration an operator most wants
        // next to the outcome token. The error is re-thrown untouched for the SDK to render.
        audited = { auditPath: 'error', ms: Date.now() - started };
        throw err;
      }
    },
    renderSummary: renderMarkdownSummary,
    normaliseTarget,
    // The auditor's own version and User-Agent, carried through rather than restated: this endpoint
    // is a way to run that auditor, so it announces the same number a report header does.
    version: AUDIT_VERSION,
    userAgent: AUDIT_USER_AGENT,
    // Registered only where the deployment has a Temporal connection to use. A preview deploy
    // without the variables serves the fast tool alone, which is a better answer than advertising
    // two tools of which one always errors.
    ...(DEEP_ENABLED
      ? {
          deep: {
            startAudit: startDeepAudit,
            readView: (workflowId: string, view: 'status' | 'report' | 'summary') =>
              readAuditView(workflowId, view, renderMarkdownSummary),
          },
        }
      : {}),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    // `parsedBody` because the body has already been read off the Request above, to decide the rate
    // limit. Reading it twice is not possible and re-wrapping it in a new Request would be a second
    // place for the two copies to disagree.
    const response = await transport.handleRequest(request, { parsedBody: body });

    // Buffered before the transport closes rather than relayed. In JSON-response mode the body is
    // already complete, so this costs nothing and removes the question of whether closing the
    // transport can truncate a response still being read.
    const text = await response.text();
    log({
      path: '/mcp',
      http: 'POST',
      outcome: `ok/${(body as { method?: string })?.method ?? 'batch'}`,
      status: response.status,
      bytes: raw.length,
      // `auditPath` rather than `path`, which this line already spends on the route. Present only
      // on a request that actually ran an audit, so a handshake or a tools/list stays the three
      // fields it has always been.
      // Read through a local rather than off `audited` directly: every assignment to it happens
      // inside the `runAudit` closure, so TypeScript's flow analysis still believes it is null
      // here and narrows the property reads to `never`.
      ...auditFields(audited as AuditFacts | null),
      ua,
    });
    return new Response(text, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), 'Cache-Control': 'no-store' },
    });
  } finally {
    await server.close();
  }
};

/**
 * A GET here is a person or an agent probing the URL — out of /.well-known/mcp-server, out of a
 * registry listing, or out of curiosity. Answering with a bare 405 would be correct and useless;
 * this says what the endpoint is and hands over a call that works, the same courtesy /a2a pays.
 *
 * It is also the correct answer under this transport. A GET to a streamable HTTP endpoint opens the
 * server-to-client SSE stream, and a stateless server has nothing to send down one.
 */
export const GET: APIRoute = ({ request }) => {
  log({ path: '/mcp', http: 'GET', outcome: 'method-not-allowed', status: 405, ua: request.headers.get('user-agent') ?? '' });

  return new Response(
    JSON.stringify(
      {
        error: 'This is an MCP endpoint. It speaks the Streamable HTTP transport over POST, not GET.',
        transport: 'streamable-http',
        stateless: true,
        server: SERVER_NAME,
        // Whoever is reading this is either an agent that found the URL in a discovery document or
        // a person who followed it out of their access log. Both are one hop from the page that
        // explains the auditor, what one audit costs a site, and how to refuse it.
        docs: 'https://www.mattpyle.com/steward',
        tools: DEEP_ENABLED ? [TOOL_NAME, DEEP_TOOL_NAME, GET_AUDIT_TOOL_NAME] : [TOOL_NAME],
        example: {
          method: 'POST',
          url: 'https://www.mattpyle.com/mcp',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: TOOL_NAME, arguments: { url: 'https://example.com' } },
          },
        },
        note:
          'Audits are rate limited per caller and in total, with a separate and much smaller ' +
          'budget for the deep tier, which renders pages in a browser and takes minutes. A refusal ' +
          'is a 429 with a Retry-After header naming which limit was hit.',
      },
      null,
      2
    ),
    {
      status: 405,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Allow: 'POST',
        'Cache-Control': 'no-store',
      },
    }
  );
};
