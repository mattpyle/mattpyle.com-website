import type { APIRoute } from 'astro';
import {
  AUDIT_USER_AGENT,
  normaliseTarget,
  renderMarkdownSummary,
  runFastAudit,
} from '@mattpyle/steward/agent-audit/fast';
import digest from '../data/a2a-digest.json';
import { A2A_METHOD, A2A_METHODS, CANCEL_TASK_METHOD, GET_TASK_METHOD, STREAM_METHOD, respondOrStream } from '../lib/a2a-responder.mjs';
import { SSE_HEADERS, sseBody } from '../lib/a2a-sse.mjs';
import { AUDIT_SKILL_ID, ASK_SKILL_ID, CONSULTANT_SKILL_ID, routeMessage } from '../lib/a2a-audit-skill.mjs';
import { consultantEngine } from '../lib/a2a-consultant-temporal.mjs';
import { readText } from '../lib/a2a-rpc.mjs';
import { A2A_ENDPOINT_PATH, a2aFactsFrom, recordA2aRequest, recordHit } from '../lib/agent-hits.mjs';
import { identifyRequest } from '../lib/web-bot-auth.mjs';
import { ipAddress, waitUntil } from '@vercel/functions';
import { originFor } from '../lib/mcp-audit-server.mjs';
import { checkRateLimit, clientIpFrom } from '../lib/mcp-rate-limit.mjs';
import { readAuditSnapshot, readTemporalConfig, startDeepAudit } from '../lib/mcp-temporal.mjs';

/**
 * The A2A endpoint: Steward. JSON-RPC 2.0 over POST; four methods; three skills.
 *
 * All the protocol logic lives in src/lib/a2a-responder.mjs and src/lib/a2a-audit-skill.mjs, both
 * pure and tested; this file is the transport plus the wiring: read the body, hand the responder
 * the engine the audit skill needs, log the outcome, serialize. Keeping the split means the
 * interesting half never needs a deploy to exercise.
 *
 * **The second skill made this route a consumer of the Steward workspace, on 2026-08-18.** It
 * imports the same two exports entries `/mcp` does and adds no third one: `agent-audit/fast` for
 * the auditor itself, and `agent-audit/deep-contract` (through src/lib/mcp-temporal.mjs) for the
 * six names a deep audit is started and polled by. Both entries are held by the packaging tests in
 * `tests/`, which walk the graph rather than the route, so they cover this consumer unchanged.
 *
 * **One budget, not two, and it is literally the same code.** The audit skill calls
 * `checkRateLimit` from src/lib/mcp-rate-limit.mjs with the same caller key and the same counters
 * `/mcp` uses. A deep slot spent over A2A is spent over MCP; `GetTask` spends no audit allowance,
 * for the same reason `get_audit` spends none, and is counted on the same read tier. A parallel
 * limiter would have doubled this site's worst day.
 *
 * **On-demand rather than prerendered**, and note what that does and does not change: the site's
 * output stays `static` (astro.config.mjs) and every page still prerenders. Delete this file,
 * public/.well-known/agent-card.json and src/pages/mcp.ts and the built site is unchanged, which
 * is the progressive-enhancement rule this whole experiment runs under, made checkable.
 *
 * **Counted here, because the middleware cannot.** `middleware.ts` leaves `/a2a` out of its matcher
 * on purpose: a slash rule that reached it would 308 a JSON-RPC call. So the route counts itself,
 * once per POST and before the responder runs, exactly as src/pages/mcp.ts does. `countRequest`
 * writes the same `surface` hit the middleware writes for every other agent surface, so `/a2a`
 * joins By client and By surface, and a census of three facts from fixed lists: the JSON-RPC
 * method, the skill the message routed to and the audit tier it asked for
 * (src/lib/agent-hits.mjs, a2aFactsFrom). Neither write delays the response and neither can fail
 * it. A GET is not a call and is not counted.
 *
 * **The third skill, on 2026-11-13: the audit consultant** (src/lib/a2a-consultant-skill.mjs). It
 * starts and reads a Claude-driven agent's workflow on the same Temporal client the deep tier uses,
 * by raw call names, and imports nothing from `agents/consultant/`. A new session is charged on the
 * limiter's session tier, before the start. Without a Temporal connection the skill answers that
 * it is not configured, and nothing is charged.
 *
 * **Since 2026-11-15 the model answers every message that names no skill**, where the deployment
 * has a Temporal connection, and a send waits for its turn (`WAIT_BUDGET_MS` in the skill, counted
 * from this route's first line). A deployment with none keeps the older routing by wording, so a
 * preview or a local build still answers.
 *
 * **It streams, since 2026-11-15.** `SendStreamingMessage` is answered as Server-Sent Events: the
 * headers and a comment line leave at once, a comment follows every two seconds, and the turn's
 * events follow as the session produces them (src/lib/a2a-sse.mjs has the reason for the comments).
 * The response is a web `ReadableStream`, which the Vercel adapter's function passes through
 * (`supportsResponseStreaming` in its function config). The log line is written when the stream
 * ends, with its outcome and how many events it sent. When the client goes away the stream's
 * source stops at its next step where the platform reports the disconnect, and at the wait's
 * budget where it does not. The message is delivered either way, and `GetTask` reads the turn.
 *
 * The digest is a static import, so it is bundled into the function at build time. No fetch, no
 * content-collection read, no cold-start I/O: see scripts/generate-a2a-digest.mjs.
 */
export const prerender = false;

const CARD_URL = 'https://www.mattpyle.com/.well-known/agent-card.json';

/**
 * The fast audit's whole wall-clock budget, matching /mcp's.
 *
 * A slow target must produce a JSON-RPC answer saying the audit ran out of time, not a platform
 * 504 with no body. 45s sits under the 60s floor every Vercel plan has offered.
 */
const AUDIT_BUDGET_MS = 45_000;

/**
 * Whether this deployment can start a deep audit at all.
 *
 * Read once at module scope: it is a property of the deployment rather than of a request. Unlike
 * `/mcp`, which simply does not register the deep tools without it, the Agent Card here is a
 * static file that always advertises both tiers — so a deployment with no Temporal answers a deep
 * request with an error naming the cause, and the fast tier is unaffected either way.
 */
const DEEP_ENABLED = readTemporalConfig() !== null;

/**
 * Every call, one line, with the outcome. There is no storage behind this yet (that is the
 * agent-hit-counter work), so the function log is the entire dataset for now — which is exactly
 * why the outcome is recorded as a token like `ok/surfaces` or `ok/task/completed` rather than as
 * prose: whatever eventually reads these should not have to parse a sentence.
 *
 * `ok/site` and `ok/site-unrecognised` are the same reply and opposite outcomes: the front desk
 * answering a general question, and a question the responder's vocabulary could not place. Counting
 * the second one is the only way the miss rate is visible at all. The question text is never
 * logged, and neither is the audited origin.
 */
function log(fields: Record<string, string | number>) {
  console.log(
    `[a2a] ${Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`
  );
}

/**
 * The router the census asks, the same `routeMessage` the responder uses and on the same terms: a
 * SendMessage with no text never reaches it there, so it routes to nothing here.
 */
function routeFor(params: { message?: unknown }) {
  const text = readText(params.message);
  return text === null ? null : routeMessage(params, text, { model: DEEP_ENABLED });
}

/**
 * Count one POST: the shared `surface` hit, then the census. Both go through `waitUntil`, so
 * neither is awaited in front of the reply, and the whole body is a try/catch because observation
 * is never worth a failed response.
 *
 * `body` is the parsed JSON, or undefined when it did not parse, which is still a data point. The
 * address goes to identifyRequest() and does not come out, exactly as in the middleware.
 */
function countRequest(request: Request, body: unknown): void {
  try {
    const identity = identifyRequest(request, { address: ipAddress(request) ?? null });
    waitUntil(recordHit({ event: 'surface', path: A2A_ENDPOINT_PATH, ua: request.headers.get('user-agent'), identity }));
    waitUntil(recordA2aRequest({ facts: a2aFactsFrom(body, routeFor) }));
  } catch {
    // Deliberately empty: observation is never worth a failed response.
  }
}

export const POST: APIRoute = async ({ request }) => {
  // When the request arrived. A send that waits for its turn counts its budget from here.
  const startedAt = Date.now();
  const raw = await request.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  countRequest(request, parsed);

  // Set when a streaming client goes away, and read by the stream's source between its steps.
  const signal = { aborted: false };
  const opened = await respondOrStream(raw, {
    digest,
    newId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    // The read tier, asked before a GetTask that reaches Temporal. One key for both endpoints.
    checkRead: async () => {
      const verdict = await checkRateLimit({ ip: clientIpFrom(request.headers), tier: 'read' });
      // A read the limiter could not count goes ahead, and says so here.
      if (verdict.allowed && verdict.counted === false) {
        log({ path: '/a2a', http: 'POST', outcome: `rate-uncounted/read/${verdict.scope ?? 'unknown'}` });
      }
      return verdict;
    },
    audit: {
      // The same refusal `/mcp` makes before any work starts, from the same function: "this is not
      // a URL" is a request that never started rather than a finding.
      originFor: (url: string) => originFor(url, normaliseTarget),
      // The shared budget, in one line. Same function, same keyed hash of the caller, same
      // counters — see the docblock above.
      checkLimit: (tier: 'fast' | 'deep') =>
        checkRateLimit({ ip: clientIpFrom(request.headers), tier }),
      runFast: (url: string) => runFastAudit(url, { policy: { totalBudgetMs: AUDIT_BUDGET_MS } }),
      startDeep: DEEP_ENABLED
        ? startDeepAudit
        : () => {
            throw new Error('no Temporal connection is configured on this deployment');
          },
      readTask: readAuditSnapshot,
      renderSummary: renderMarkdownSummary,
    },
    consultant: DEEP_ENABLED
      ? {
          // The same function, store and caller key as the audits, on the session tier's own keys.
          checkLimit: () => checkRateLimit({ ip: clientIpFrom(request.headers), tier: 'session' }),
          engine: consultantEngine,
          startedAt,
          signal,
        }
      : undefined,
  });

  if ('events' in opened) {
    const ua = request.headers.get('user-agent') ?? '';
    return new Response(
      sseBody(opened.events, {
        signal,
        onEnd: (result, info) =>
          log({
            path: '/a2a',
            http: 'POST',
            outcome: info.error ? 'stream/internal-error' : (result?.outcome ?? 'stream/ended'),
            status: 200,
            bytes: raw.length,
            events: info.events,
            ms: Date.now() - startedAt,
            ...(info.aborted ? { aborted: 1 } : {}),
            ua,
            ...(result?.detail ? { detail: result.detail } : {}),
            ...(info.error ? { detail: String(info.error instanceof Error ? info.error.message : info.error).slice(0, 300) } : {}),
          }),
      }),
      { status: 200, headers: SSE_HEADERS }
    );
  }
  const { status, outcome, payload, detail } = opened;

  log({
    path: '/a2a',
    http: 'POST',
    outcome,
    status,
    bytes: raw.length,
    ua: request.headers.get('user-agent') ?? '',
    // An internal error's own text, which the caller's reply leaves out on purpose.
    ...(detail ? { detail } : {}),
  });

  if (payload === null) return new Response(null, { status });

  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      // application/json, not application/a2a+json: the JSON-RPC binding specifies
      // `application/json` for requests and responses (specification section 9.1). The a2a+json
      // media type belongs to the HTTP+JSON/REST binding and to the Agent Card.
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};

/**
 * A GET here is a person or an agent probing the URL out of the Agent Card. Answering with a bare
 * 405 would be correct and useless; this one says what the endpoint is and hands over a call that
 * works, which is the same courtesy the WebMCP tools pay to an empty result.
 */
export const GET: APIRoute = ({ request }) => {
  log({ path: '/a2a', http: 'GET', outcome: 'method-not-allowed', status: 405, ua: request.headers.get('user-agent') ?? '' });

  return new Response(
    JSON.stringify(
      {
        error: 'This is an A2A endpoint. It speaks JSON-RPC 2.0 over POST, not GET.',
        agentCard: CARD_URL,
        supportedMethods: A2A_METHODS,
        skills: [CONSULTANT_SKILL_ID, AUDIT_SKILL_ID, ASK_SKILL_ID],
        example: {
          method: 'POST',
          url: 'https://www.mattpyle.com/a2a',
          headers: { 'Content-Type': 'application/json' },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: A2A_METHOD,
            params: {
              message: {
                role: 'ROLE_USER',
                messageId: '1',
                parts: [{ text: 'What is this site about?' }],
                metadata: { skill: ASK_SKILL_ID },
              },
            },
          },
        },
        auditExample: {
          method: 'POST',
          url: 'https://www.mattpyle.com/a2a',
          headers: { 'Content-Type': 'application/json' },
          body: {
            jsonrpc: '2.0',
            id: 2,
            method: A2A_METHOD,
            params: {
              message: {
                role: 'ROLE_USER',
                messageId: '2',
                parts: [{ text: 'Run a deep audit of example.com' }],
                metadata: { skill: AUDIT_SKILL_ID },
              },
            },
          },
          then: `Poll ${GET_TASK_METHOD} with the returned task id until the state is TASK_STATE_COMPLETED.`,
        },
        consultantExample: {
          method: 'POST',
          url: 'https://www.mattpyle.com/a2a',
          headers: { 'Content-Type': 'application/json' },
          body: {
            jsonrpc: '2.0',
            id: 3,
            method: A2A_METHOD,
            params: {
              message: {
                role: 'ROLE_USER',
                messageId: '3',
                parts: [{ text: 'Check example.com and tell me what to fix first' }],
              },
            },
          },
          then:
            'A message that names no skill goes to Steward\'s model. The reply is a Task, completed with ' +
            'the answer as its artifact. Send the next message with the returned contextId. At ' +
            `TASK_STATE_INPUT_REQUIRED, reply with ${A2A_METHOD} and message.taskId set to that task's id; ` +
            `${CANCEL_TASK_METHOD} on any task closes the session. If the turn is still running the ` +
            `Task reads TASK_STATE_WORKING: poll ${GET_TASK_METHOD}.`,
        },
        streaming:
          `${STREAM_METHOD} takes the same params as ${A2A_METHOD} and answers as Server-Sent Events ` +
          '(text/event-stream). Each event is a JSON-RPC response whose result is a StreamResponse: the ' +
          'task first, then an artifactUpdate with the answer and a statusUpdate with the final state. ' +
          'A comment line arrives at least every three seconds while a turn runs.',
        note:
          `The audit skill arrives at the site it audits as \`${AUDIT_USER_AGENT}\` and obeys its ` +
          'robots.txt. Audits are rate limited per caller and in total, and that budget is shared ' +
          'with the MCP endpoint at https://www.mattpyle.com/mcp. https://www.mattpyle.com/steward ' +
          'explains what one audit costs a site and how to refuse it.',
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
