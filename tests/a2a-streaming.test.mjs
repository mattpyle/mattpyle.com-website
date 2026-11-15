import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASK_SKILL_ID, AUDIT_SKILL_ID } from '../src/lib/a2a-audit-skill.mjs';
import { A2A_METHOD, ERROR_CODES, STREAM_METHOD, respond, respondOrStream } from '../src/lib/a2a-responder.mjs';
import { KEEP_ALIVE_MS, SSE_HEADERS, sseBody, sseEvent } from '../src/lib/a2a-sse.mjs';

// `SendStreamingMessage` at the responder and on the wire: which sends become a stream, what the
// two skills with no model send, and the bytes of the stream itself. The model's turn as events is
// in tests/a2a-consultant-skill.test.mjs.

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const digest = JSON.parse(read('src/data/a2a-digest.json'));

const REPORT = {
  schemaVersion: 3,
  tool: { name: 'steward-audit', version: '0.2.0' },
  target: { input: 'example.com', origin: 'https://example.com' },
  checks: [{ id: 'llms-txt', status: 'fail' }],
};
const WORKFLOW_ID = 'steward-audit-example.com-deep-1a2b3c4d';
const audit = (overrides = {}) => ({
  originFor: (url) => new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).origin,
  checkLimit: async (tier) => ({ allowed: true, tier }),
  runFast: async () => REPORT,
  startDeep: async () => ({ workflowId: WORKFLOW_ID }),
  readTask: async () => assert.fail('a send does not read a task'),
  renderSummary: (report) => `# Audit of ${report.target.origin}\n\n1 check failed.\n`,
  ...overrides,
});

function context(extra = {}) {
  let n = 0;
  return { digest, newId: () => `id-${++n}`, now: () => '2026-11-15T00:00:00.000Z', ...extra };
}
const body = (method, text, metadata, id = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: { message: { role: 'ROLE_USER', messageId: 'm', parts: [{ text }], ...(metadata ? { metadata } : {}) } } });

async function drain(events) {
  const sent = [];
  for (;;) {
    const next = await events.next();
    if (next.done) return { sent, result: next.value };
    sent.push(next.value);
  }
}

/** Read a body to its end, as text. */
async function text(stream) {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
  return out;
}
async function* from(events, result) {
  for (const event of events) yield event;
  return result;
}

// --- which sends stream, and what the skills with no model send ---------------------------------

test('a streaming send that names ask-about-site gets one event: the message the plain send returns', async () => {
  const opened = await respondOrStream(body(STREAM_METHOD, 'What is this site about?', { skill: ASK_SKILL_ID }), context());
  const { sent, result } = await drain(opened.events);
  const plain = await respond(body(A2A_METHOD, 'What is this site about?', { skill: ASK_SKILL_ID }), context());
  assert.equal(sent.length, 1, 'a message-only stream is exactly one event');
  assert.deepEqual(sent[0], plain.payload);
  assert.equal(Object.keys(sent[0].result).join(), 'message');
  assert.equal(result.outcome, `stream/${plain.outcome}`);
});

test('a streaming send that names audit-a-site gets one event: the message for a fast audit, the task for a deep one', async () => {
  const fast = await drain((await respondOrStream(body(STREAM_METHOD, 'audit example.com', { skill: AUDIT_SKILL_ID }), context({ audit: audit() }))).events);
  const plainFast = await respond(body(A2A_METHOD, 'audit example.com', { skill: AUDIT_SKILL_ID }), context({ audit: audit() }));
  assert.deepEqual(fast.sent, [plainFast.payload]);
  assert.ok(fast.sent[0].result.message, 'the fast tier is a message');

  const deep = await drain((await respondOrStream(body(STREAM_METHOD, 'run a deep audit of example.com', { skill: AUDIT_SKILL_ID }), context({ audit: audit() }))).events);
  assert.equal(deep.sent.length, 1);
  const task = deep.sent[0].result.task;
  assert.equal(task.id, WORKFLOW_ID);
  assert.notEqual(task.status.state, 'TASK_STATE_COMPLETED', 'the stream closes with the audit still running: GetTask reads it');
  assert.equal(deep.result.outcome, 'stream/ok/audit-deep');
});

test('a refused audit on a streaming send is one error event', async () => {
  const limited = audit({ checkLimit: async () => ({ allowed: false, scope: 'caller', reason: 'this caller has run 5 audits this hour', retryAfterSeconds: 30 }) });
  const { sent } = await drain((await respondOrStream(body(STREAM_METHOD, 'audit example.com', { skill: AUDIT_SKILL_ID }), context({ audit: limited }))).events);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, ERROR_CODES.serverError);
});

test('without a model, a streaming send that names no skill is sorted by wording, and still answers in one event', async () => {
  const { sent } = await drain((await respondOrStream(body(STREAM_METHOD, 'What is this site about?'), context())).events);
  assert.equal(sent.length, 1);
  assert.match(sent[0].result.message.parts[0].text, /Steward speaking/);
});

test('every other method, and a streaming send that is wrong at once, comes back as respond() returns it', async () => {
  for (const raw of [
    body(A2A_METHOD, 'What is this site about?', { skill: ASK_SKILL_ID }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'nope' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: STREAM_METHOD }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: STREAM_METHOD, params: { message: { parts: [] } } }),
    '{not json',
  ]) {
    const opened = await respondOrStream(raw, context());
    assert.equal(opened.events, undefined, raw);
    assert.deepEqual(opened, await respond(raw, context()), raw);
  }
  const noAudit = await respondOrStream(body(STREAM_METHOD, 'audit example.com', { skill: AUDIT_SKILL_ID }), context());
  assert.equal(noAudit.payload.error.data[0].reason, 'SKILL_NOT_CONFIGURED');
});

test('a streaming notification gets no body and starts no work', async () => {
  let ran = false;
  const raw = JSON.stringify({ jsonrpc: '2.0', method: STREAM_METHOD, params: { message: { parts: [{ text: 'audit example.com' }], metadata: { skill: AUDIT_SKILL_ID } } } });
  const opened = await respondOrStream(raw, context({ audit: audit({ runFast: async () => { ran = true; return REPORT; } }) }));
  assert.equal(opened.status, 204);
  assert.equal(opened.payload, null);
  assert.equal(ran, false);
});

test('respond() is the one-reply half: it refuses a streaming send, and runs none of it', async () => {
  let ran = false;
  const result = await respond(body(STREAM_METHOD, 'audit example.com', { skill: AUDIT_SKILL_ID }), context({ audit: audit({ runFast: async () => { ran = true; return REPORT; } }) }));
  assert.equal(result.payload.error.code, ERROR_CODES.unsupportedOperation);
  assert.equal(ran, false);
});

test('a source that throws ends its stream with an internal error event, and the text stays in the log detail', async () => {
  const broken = audit({ originFor: () => 'https://example.com', checkLimit: async () => { throw new Error('redis at 10.0.0.7 refused'); } });
  const { sent, result } = await drain((await respondOrStream(body(STREAM_METHOD, 'audit example.com', { skill: AUDIT_SKILL_ID }, 'r1'), context({ audit: broken }))).events);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'r1');
  assert.equal(sent[0].error.code, ERROR_CODES.internal);
  assert.ok(!JSON.stringify(sent).includes('10.0.0.7'));
  assert.equal(result.outcome, 'stream/internal-error');
  assert.match(result.detail, /10\.0\.0\.7/);
});

// --- the bytes ------------------------------------------------------------------------------

test('the body opens with a comment, then one data line per event, and reports its end', async () => {
  let ended;
  const events = [{ jsonrpc: '2.0', id: 1, result: { task: { id: 't' } } }, { jsonrpc: '2.0', id: 1, result: { statusUpdate: { taskId: 't' } } }];
  const out = await text(sseBody(from(events, { outcome: 'stream/ok' }), { onEnd: (result, info) => { ended = { result, info }; } }));
  assert.equal(out, `: stream open\n\n${events.map(sseEvent).join('')}`);
  assert.equal(sseEvent(events[0]), `data: ${JSON.stringify(events[0])}\n\n`);
  assert.ok(!sseEvent({ text: 'two\nlines' }).slice(0, -2).includes('\n'), 'a newline in a text stays inside the JSON string');
  assert.deepEqual(ended, { result: { outcome: 'stream/ok' }, info: { events: 2, aborted: false } });
});

test('a quiet stream sends a comment on a timer of its own, more often than every three seconds', async () => {
  assert.ok(KEEP_ALIVE_MS < 3000);
  let release;
  async function* slow() {
    await new Promise((resolve) => { release = resolve; });
    yield { jsonrpc: '2.0', id: 1, result: { message: {} } };
  }
  const reader = sseBody(slow(), { keepAliveMs: 15 }).getReader();
  const decoder = new TextDecoder();
  let out = '';
  while ((out.match(/: keep-alive\n\n/g) ?? []).length < 3) out += decoder.decode((await reader.read()).value);
  assert.ok(out.startsWith(': stream open\n\n'), 'the first bytes do not wait for the source');
  assert.ok(!out.includes('data:'), 'the comments arrive while the source is still waiting');
  release();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  assert.match(out, /data: \{"jsonrpc":"2\.0","id":1,"result":\{"message":\{\}\}\}\n\n$/);
  const after = out.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(out.length, after, 'the timer stops with the stream');
});

test('a client that goes away sets the signal and stops the comments', async () => {
  const signal = { aborted: false };
  let ended;
  let release;
  async function* waiting() {
    await new Promise((resolve) => { release = resolve; });
    return { outcome: 'stream/ok/client-gone' };
  }
  const reader = sseBody(waiting(), { signal, keepAliveMs: 10, onEnd: (result, info) => { ended = { result, info }; } }).getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(signal.aborted, true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(ended, { result: { outcome: 'stream/ok/client-gone' }, info: { events: 0, aborted: true } });
});

test('the stream headers name the media type and ask proxies not to hold it', () => {
  assert.match(SSE_HEADERS['Content-Type'], /^text\/event-stream/);
  assert.match(SSE_HEADERS['Cache-Control'], /no-store/);
  assert.match(SSE_HEADERS['Cache-Control'], /no-transform/);
  assert.equal(SSE_HEADERS['X-Accel-Buffering'], 'no');
});

// --- the route ------------------------------------------------------------------------------

test('the route streams through the shared body, hands the source its signal, and logs when the stream ends', () => {
  const route = read('src/pages/a2a.ts');
  assert.match(route, /const signal = \{ aborted: false \};/);
  assert.match(route, /await respondOrStream\(raw, \{/);
  assert.match(route, /startedAt,\n\s+signal,/);
  assert.match(route, /sseBody\(opened\.events, \{\n\s+signal,\n\s+onEnd:/);
  assert.match(route, /\{ status: 200, headers: SSE_HEADERS \}/);
});

test('the test server streams with the same body as the route', () => {
  const server = read('agents/consultant/scripts/a2a-test-server.ts');
  assert.match(server, /respondOrStream/);
  assert.match(server, /sseBody/);
});
