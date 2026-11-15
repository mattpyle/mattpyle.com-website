/**
 * The site's `/a2a` over HTTP, for trying an off-the-shelf A2A client against the adapter with no
 * deploy: a local Temporal dev server, this package's worker, a scripted model and a stub site,
 * behind the site's own `respondOrStream()`.
 *
 *   node --import tsx --import ./src/sdk-compat.ts scripts/a2a-test-server.ts [port] [--slow-ms=12000] [--no-streaming]
 *
 * `--slow-ms` makes the scripted model's last call of each turn take that long, so a turn outlasts
 * a client's read timeout. `--no-streaming` serves the card with `streaming: false`, which is the
 * endpoint a client saw before the streaming send: an official client then sends `SendMessage`
 * and waits in silence.
 *
 * A streaming send is answered with the same SSE body the site's route sends
 * (src/lib/a2a-sse.mjs), comments included.
 *
 * It serves the Agent Card at `/.well-known/agent-card.json`, with its interface address pointed
 * at this server, and JSON-RPC at `/a2a`. It makes no model call and no call to the site, its
 * store or the rate limiter: the limiter is a stub that always allows, so nothing here spends a
 * session slot. The audit skill has no engine here, so a message that names it is refused.
 *
 * The "model" is a script chosen from each new message's words (see `stepsFor`). It stands in for
 * the model's choices so a client sees every task shape: a completed answer, a question, an
 * approval request and a site-facts answer.
 */
import fs from 'node:fs';
import http from 'node:http';
import { TASK_QUEUE, startHarness } from '../tests/helpers/env.js';
import type { Step } from '../tests/helpers/scripted-model.js';

const ROOT = new URL('../../../', import.meta.url);
const load = (name: string): Promise<any> => import(new URL(`src/lib/${name}`, ROOT).href);
const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'));
const port = Number(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? process.env.PORT ?? 4317);
const slowMs = Number(flags.find((flag) => flag.startsWith('--slow-ms='))?.slice('--slow-ms='.length) ?? 0);
const declareStreaming = !flags.includes('--no-streaming');
const origin = `http://127.0.0.1:${port}`;

/** The steps for one new message, with the last call slowed when `--slow-ms` asks for it. */
function stepsFor(text: string): Step[] {
  const steps = scriptFor(text);
  if (slowMs > 0) steps[steps.length - 1] = { ...steps[steps.length - 1], delayMs: slowMs };
  return steps;
}

/** The scripted model's steps for one new message. An answer or an approval continues a script. */
function scriptFor(text: string): Step[] {
  const lower = text.toLowerCase();
  if (/\bdeep\b/.test(lower)) {
    return [
      { tool: 'deep_audit', input: { url: 'example.com' } },
      { text: 'The deep audit is read.\n\n1. Publish llms.txt.\n2. Serve markdown on request.' },
    ];
  }
  if (/mattpyle|matt\b|written/.test(lower)) {
    return [
      { tool: 'site_facts', input: { topic: 'writing' } },
      { text: 'The newest post on mattpyle.com is "How to implement WebMCP on a website".' },
    ];
  }
  const host = /\b([a-z0-9-]+\.)+[a-z]{2,}\b/.exec(lower)?.[0];
  if (host) {
    return [
      { tool: 'audit_site', input: { url: host } },
      { text: `I audited ${host}. Two checks failed.\n\n1. Publish llms.txt: agents look for it first.\n2. Serve markdown on request: agents read it more cheaply than HTML.` },
    ];
  }
  if (/\bnext\b|\bthen\b/.test(lower)) return [{ text: 'Next, add agents.md.' }];
  return [
    { tool: 'ask_user', input: { question: 'Which site should I audit?' } },
    { tool: 'audit_site', input: { url: 'example.com' } },
    { text: 'I audited the site you named.\n\n1. Publish llms.txt.\n2. Serve markdown on request.' },
  ];
}

const h = await startHarness();
const { respondOrStream } = await load('a2a-responder.mjs');
const { SSE_HEADERS, sseBody } = await load('a2a-sse.mjs');
const { createConsultantEngine } = await load('a2a-consultant-temporal.mjs');
const engine = createConsultantEngine(async () => h.env.client, { taskQueue: TASK_QUEUE });
const digestPath = new URL('src/data/a2a-digest.json', ROOT);
const digest = fs.existsSync(digestPath) ? JSON.parse(fs.readFileSync(digestPath, 'utf8')) : {};
const card = JSON.parse(fs.readFileSync(new URL('public/.well-known/agent-card.json', ROOT), 'utf8'));
card.supportedInterfaces = card.supportedInterfaces.map((entry: object) => ({ ...entry, url: `${origin}/a2a` }));
card.capabilities = { ...card.capabilities, streaming: declareStreaming };

let counter = 0;
const server = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body === null ? undefined : JSON.stringify(body));
  };
  const path = new URL(req.url ?? '/', origin).pathname;
  if (req.method === 'GET' && path === '/.well-known/agent-card.json') return send(200, card);
  if (req.method !== 'POST' || path !== '/a2a') return send(404, { error: 'not found' });

  const startedAt = Date.now();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const message = JSON.parse(raw)?.params?.message;
    const text = message?.parts?.find((part: { text?: unknown }) => typeof part?.text === 'string')?.text;
    // A message with a task id answers a question or an approval, and continues the script.
    if (typeof text === 'string' && !message.taskId) h.script.set(stepsFor(text));
  } catch {
    // Not JSON: respond() says so.
  }
  const siteCallsBefore = h.site.calls.length;
  const signal = { aborted: false };
  const opened = await respondOrStream(raw, {
    digest,
    newId: () => `test-${++counter}`,
    now: () => new Date().toISOString(),
    consultant: { checkLimit: async () => ({ allowed: true }), engine, startedAt, signal },
  });
  const line = (outcome: string, extra = '') => {
    const siteCalls = h.site.calls.slice(siteCallsBefore);
    console.log(`[a2a-test-server] ${outcome} ${Date.now() - startedAt}ms${extra} site=[${siteCalls.join(', ')}]`);
  };
  if (opened.events) {
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    const body = sseBody(opened.events, {
      signal,
      onEnd: (result: { outcome?: string } | undefined, info: { events: number; aborted: boolean }) =>
        line(result?.outcome ?? 'stream/ended', ` events=${info.events}${info.aborted ? ' aborted' : ''}`),
    });
    const reader = body.getReader();
    // The client went away: stop the comments and tell the source, as the route's platform does.
    res.on('close', () => {
      if (!res.writableEnded) void reader.cancel();
    });
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      res.write(value);
    }
    res.end();
    return;
  }
  line(opened.outcome);
  send(opened.status, opened.payload);
});

server.listen(port, '127.0.0.1', () =>
  console.log(`[a2a-test-server] listening on ${origin} streaming=${declareStreaming} slow-ms=${slowMs}`)
);
const stop = async () => {
  server.close();
  await h.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
