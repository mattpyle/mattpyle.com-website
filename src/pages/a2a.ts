import type { APIRoute } from 'astro';
import {
  AUDIT_USER_AGENT,
  normaliseTarget,
  renderMarkdownSummary,
  runFastAudit,
} from '@mattpyle/steward/agent-audit/fast';
import digest from '../data/a2a-digest.json';
import { A2A_METHOD, A2A_METHODS, CANCEL_TASK_METHOD, GET_TASK_METHOD, respond } from '../lib/a2a-responder.mjs';
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
 * The A2A endpoint. JSON-RPC 2.0 over POST; three methods; three skills.
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
 * `/mcp` uses. A deep slot spent over A2A is spent over MCP; `GetTask` is free for the same reason
 * `get_audit` is. A parallel limiter would have doubled this site's worst day.
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
  return text === null ? null : routeMessage(params, text);
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
  const raw = await request.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  countRequest(request, parsed);

  const { status, outcome, payload } = await respond(raw, {
    digest,
    newId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
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
        }
      : undefined,
  });

  log({
    path: '/a2a',
    http: 'POST',
    outcome,
    status,
    bytes: raw.length,
    ua: request.headers.get('user-agent') ?? '',
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
        skills: [ASK_SKILL_ID, AUDIT_SKILL_ID, CONSULTANT_SKILL_ID],
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
                parts: [{ text: 'Can you check my site and tell me what matters?' }],
                metadata: { skill: CONSULTANT_SKILL_ID },
              },
            },
          },
          then:
            `Poll ${GET_TASK_METHOD} with the returned task id. At TASK_STATE_INPUT_REQUIRED, reply with ` +
            `${A2A_METHOD} and message.taskId set to that id; ${CANCEL_TASK_METHOD} closes the session.`,
        },
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
