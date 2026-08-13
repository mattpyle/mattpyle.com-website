import type { APIRoute } from 'astro';
import {
  normaliseTarget,
  renderMarkdownSummary,
  runFastAudit,
} from '@mattpyle/steward/agent-audit/fast';
import { createAuditServer, TOOL_NAME } from '../lib/mcp-audit-server.mjs';
import { checkRateLimit, clientIpFrom } from '../lib/mcp-rate-limit.mjs';
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
 * **Delete src/pages/mcp.ts and the exports entry in agents/steward/package.json, and the built
 * site is unchanged.** Not one byte of any prerendered page depends on this route, no page links to
 * it, and nothing in the build reads it. That is the progressive-enhancement rule this whole
 * experiment runs under, made checkable, exactly as the /a2a docblock states it.
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
 * A batch gets `null`: the spec's answer to a batch is an array of responses, and this refusal is
 * about the whole request rather than about one member of it. `null` is the id the spec reserves
 * for exactly that — an error the server could not attribute to a single call.
 */
function idOf(body: unknown): string | number | null {
  if (Array.isArray(body)) return null;
  if (body && typeof body === 'object') {
    const id = (body as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return null;
}

/**
 * Does this body ask for an audit?
 *
 * The limiter counts audits, not handshakes: `initialize` and `tools/list` are a static answer out
 * of this function's own memory with no outbound request in them, and counting them against a
 * caller's ten would mean a client that connects, lists, and calls once had spent three. A batch
 * counts if any member is a `tools/call`, which is the conservative reading.
 */
function wantsAudit(body: unknown): boolean {
  const isCall = (message: unknown) =>
    !!message &&
    typeof message === 'object' &&
    (message as { method?: unknown }).method === 'tools/call';
  return Array.isArray(body) ? body.some(isCall) : isCall(body);
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

  // Before the audit, never after: a refused caller must cost this site nothing at the target's
  // origin, and a caller cannot hold ten slow audits open by never letting one finish.
  if (wantsAudit(body)) {
    const verdict = await checkRateLimit({ ip: clientIpFrom(request.headers) });
    if (!verdict.allowed) {
      log({
        path: '/mcp',
        http: 'POST',
        outcome: `rate-limited/${verdict.scope}`,
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
  const server = createAuditServer({
    runAudit: (url: string) => runFastAudit(url, { policy: { totalBudgetMs: AUDIT_BUDGET_MS } }),
    renderSummary: renderMarkdownSummary,
    normaliseTarget,
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
        tools: [TOOL_NAME],
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
        note: 'Audits are rate limited per caller and in total. A refusal is a 429 with a Retry-After header.',
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
