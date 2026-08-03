import type { APIRoute } from 'astro';
import digest from '../data/a2a-digest.json';
import { A2A_METHOD, respond } from '../lib/a2a-responder.mjs';

/**
 * The A2A endpoint. JSON-RPC 2.0 over POST; one method; a direct Message in reply.
 *
 * All the protocol logic lives in src/lib/a2a-responder.mjs, which is pure and tested; this file
 * is the transport: read the body, call it, log the outcome, serialize. Keeping the split means
 * the interesting half never needs a deploy to exercise.
 *
 * On-demand rather than prerendered, obviously, but note what that does and does not change: the
 * site's output stays `static` (astro.config.mjs), every page still prerenders, and this joins
 * writing/[slug].md.ts as the second route that opts out. Delete this file and
 * public/.well-known/agent-card.json and the built site is unchanged, which is the whole
 * progressive-enhancement rule for this experiment made checkable.
 *
 * The digest is a static import, so it is bundled into the function at build time. No fetch, no
 * content-collection read, no cold-start I/O: see scripts/generate-a2a-digest.mjs.
 */
export const prerender = false;

const CARD_URL = 'https://www.mattpyle.com/.well-known/agent-card.json';

/**
 * Every call, one line, with the outcome. There is no storage behind this yet (that is the
 * agent-hit-counter work), so the function log is the entire dataset for now — which is exactly
 * why the outcome is recorded as a token like `ok/surfaces` or `method-not-found/tasks/get`
 * rather than as prose: whatever eventually reads these should not have to parse a sentence.
 */
function log(fields: Record<string, string | number>) {
  console.log(
    `[a2a] ${Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`
  );
}

export const POST: APIRoute = async ({ request }) => {
  const raw = await request.text();
  const { status, outcome, payload } = respond(raw, { digest, newId: () => crypto.randomUUID() });

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
        supportedMethods: [A2A_METHOD],
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
