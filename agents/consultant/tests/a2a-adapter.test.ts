/**
 * The site's A2A adapter (`src/lib/a2a-consultant-skill.mjs` and `a2a-consultant-temporal.mjs`)
 * against the real agent: a local dev server, this package's worker, the scripted model and the
 * stub site. The adapter is driven through the site's own `respond()`, the function `/a2a` calls,
 * so these tests cover the JSON-RPC a caller sends and reads.
 *
 * A message here names no skill: with a model configured, plain text reaches it. The limiter is a
 * stub handed to `respond()`, so no test spends a session slot, and nothing here reaches the
 * site, its store or a model provider.
 *
 * The site's modules are loaded by URL, not imported by name: the adapter imports nothing from this
 * package, and this package's type check need not read the site's JavaScript.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { TASK_QUEUE, startHarness, type Harness } from './helpers/env.js';

const SITE = new URL('../../../src/lib/', import.meta.url);
const load = (name: string): Promise<any> => import(new URL(name, SITE).href);

let h: Harness;
let respond: (raw: string, context: object) => Promise<{ payload: any; outcome: string }>;
let createConsultantEngine: (clientFor: () => Promise<unknown>, options?: object) => any;
let engine: any;
let limitCalls = 0;
let allow = true;

before(async () => {
  h = await startHarness();
  ({ respond } = await load('a2a-responder.mjs'));
  ({ createConsultantEngine } = await load('a2a-consultant-temporal.mjs'));
  engine = createConsultantEngine(async () => h.env.client, { taskQueue: TASK_QUEUE });
});
after(async () => {
  await h?.stop();
});
beforeEach(() => {
  h.reset();
  limitCalls = 0;
  allow = true;
});

let counter = 0;
const context = () => ({
  digest: {},
  newId: () => `id-${++counter}`,
  now: () => '2026-11-13T00:00:00.000Z',
  consultant: {
    checkLimit: async () => {
      limitCalls += 1;
      return allow
        ? { allowed: true }
        : { allowed: false, scope: 'caller', reason: 'this caller has used 3 consultant sessions today', retryAfterSeconds: 60, limit: 3 };
    },
    engine,
  },
});

async function call(method: string, params: object) {
  const { payload, outcome } = await respond(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), context());
  return { payload, outcome };
}

type Extra = { taskId?: string; contextId?: string; metadata?: object; immediate?: boolean };

const send = (text: string, extra: Extra = {}) =>
  call('SendMessage', {
    message: {
      role: 'ROLE_USER',
      messageId: `m-${++counter}`,
      parts: [{ text }],
      ...(extra.taskId ? { taskId: extra.taskId } : {}),
      ...(extra.contextId ? { contextId: extra.contextId } : {}),
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    },
    ...(extra.immediate ? { configuration: { returnImmediately: true } } : {}),
  });

/** One send, read as the task it returns. Fails on a JSON-RPC error. */
async function turn(text: string, extra: Extra = {}) {
  const { payload } = await send(text, extra);
  assert.ok(payload.result?.task, JSON.stringify(payload));
  return payload.result.task;
}

async function getTask(id: string) {
  const { payload } = await call('GetTask', { id });
  return payload.result ?? payload;
}

/** Polls GetTask until the state leaves WORKING and SUBMITTED. */
async function settle(id: string, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const task = await getTask(id);
    const state = task.status?.state;
    if (state && state !== 'TASK_STATE_WORKING' && state !== 'TASK_STATE_SUBMITTED') return task;
    if (Date.now() > until) assert.fail(`task ${id} still ${state}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const textOf = (task: any) => task.status.message.parts[0].text as string;
const answerOf = (task: any) => task.artifacts?.[0]?.parts?.[0]?.text as string | undefined;
const SESSION = /^a2a-consultant-[0-9a-f-]{36}$/;

test('one send of plain text returns a completed task with the answer as its artifact', async () => {
  h.script.set([{ tool: 'audit_site', input: { url: 'example.com' } }, { text: '1. Publish llms.txt first.' }]);
  const task = await turn('Check example.com and tell me what to fix first');
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.status.message, undefined);
  assert.equal(task.artifacts[0].name, 'answer');
  assert.equal(answerOf(task), '1. Publish llms.txt first.');
  assert.match(task.contextId, SESSION);
  assert.equal(task.id, `${task.contextId}-t1`);
  assert.equal(limitCalls, 1, 'a new session is charged once');
  assert.deepEqual(h.site.calls, ['fast https://example.com']);
});

test('a question: the agent asks, the caller answers on that task, and later turns are new tasks', async () => {
  h.script.set([
    { tool: 'ask_user', input: { question: 'Which site should I audit?' } },
    { tool: 'audit_site', input: { url: 'example.com' } },
    { text: 'Publish llms.txt first.' },
  ]);
  const asked = await turn('Can you check my site?');
  const context = asked.contextId as string;
  assert.equal(asked.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(asked.metadata.awaiting, 'answer');
  assert.equal(textOf(asked), 'Which site should I audit?');
  assert.equal(asked.id, `${context}-t1`);

  const answered = await turn('example.com', { taskId: asked.id });
  assert.equal(answered.id, asked.id, 'the answer finishes the task that asked');
  assert.equal(answered.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(answerOf(answered), 'Publish llms.txt first.');
  assert.equal(limitCalls, 1, 'a reply on an open session is not charged');
  assert.deepEqual(h.site.calls, ['fast https://example.com']);

  h.script.set([{ text: 'Then add agents.md.' }]);
  const second = await turn('What next?', { contextId: context });
  assert.equal(second.id, `${context}-t2`, 'the second turn is a new task');
  assert.equal(second.contextId, context);
  assert.equal(answerOf(second), 'Then add agents.md.');
  assert.equal(second.metadata.turn, 2);

  const first = await getTask(asked.id);
  assert.equal(first.status.state, 'TASK_STATE_COMPLETED', 'turn 1 still answers after turn 2');
  assert.equal(answerOf(first), 'Publish llms.txt first.');
  assert.equal(first.contextId, context);

  const bare = await getTask(context);
  assert.equal(bare.id, context);
  assert.equal(answerOf(bare), 'Then add agents.md.', 'a bare session id stands for the latest turn');
  assert.equal((await call('GetTask', { id: `${context}-t3` })).payload.error.code, -32001);
});

test('a question about mattpyle.com is answered through the site-facts tool', async () => {
  h.script.set([{ tool: 'site_facts', input: { topic: 'writing' } }, { text: 'The newest post is about WebMCP.' }]);
  const task = await turn('What has Matt written lately?');
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(answerOf(task), 'The newest post is about WebMCP.');
  assert.deepEqual(h.site.calls, ['facts']);
  assert.ok(h.script.seen[1]!.includes('how-to-implement-webmcp-on-a-website'));
});

test('an approval: a deep audit waits for yes, and an unclear reply sends nothing', async () => {
  h.script.set([{ tool: 'deep_audit', input: { url: 'example.com' } }, { text: 'Deep result read.' }]);
  const waiting = await turn('Run a deep audit of example.com');
  assert.equal(waiting.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(waiting.metadata.awaiting, 'approval');
  assert.match(textOf(waiting), /deep audit of example\.com/);

  const unclear = await send('yes, but audit example.org instead', { taskId: waiting.id });
  assert.equal(unclear.payload.error.code, -32602);
  assert.deepEqual(h.site.calls, [], 'nothing started on an unclear reply');

  const done = await turn('yes', { taskId: waiting.id });
  assert.equal(done.id, waiting.id);
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(answerOf(done), 'Deep result read.');
  assert.deepEqual(h.site.calls, ['start https://example.com', 'read status', 'read report']);
});

test('a refusal: "no" declines the deep audit and starts nothing', async () => {
  h.script.set([{ tool: 'deep_audit', input: { url: 'example.com' } }, { text: 'Understood.' }]);
  const waiting = await turn('Run a deep audit of example.com');
  const done = await turn('no', { contextId: waiting.contextId });
  assert.equal(answerOf(done), 'Understood.');
  assert.deepEqual(h.site.calls, []);
});

test('an immediate return: the send answers working, and GetTask reads the turn', async () => {
  h.script.set([{ text: 'Hello.' }]);
  const task = await turn('hi', { immediate: true });
  assert.equal(task.status.state, 'TASK_STATE_WORKING');
  const done = await settle(task.id);
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(answerOf(done), 'Hello.');
});

test('a cancel on a finished turn closes the session and leaves that task completed', async () => {
  h.script.set([{ text: 'Hello.' }]);
  const task = await turn('hi');
  const { payload } = await call('CancelTask', { id: task.id });
  assert.equal(payload.result.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(payload.result.metadata.session, 'closed');
  assert.equal(answerOf(payload.result), 'Hello.');

  const until = Date.now() + 10_000;
  let read = await getTask(task.id);
  while (read.metadata.session !== 'closed' && Date.now() < until) read = await getTask(task.id);
  assert.equal(read.metadata.session, 'closed');
  assert.equal(read.status.state, 'TASK_STATE_COMPLETED', 'a finished task does not change state');
  assert.equal(answerOf(read), 'Hello.');

  const again = await call('CancelTask', { id: task.id });
  assert.equal(again.payload.error.code, -32002);
  const late = await send('still there?', { contextId: task.contextId });
  assert.equal(late.payload.error.code, -32004);
  assert.match(late.payload.error.message, /no context id and no task id/);
});

test('a cancel on an open turn reads canceled, then and afterwards', async () => {
  h.script.set([{ tool: 'ask_user', input: { question: 'Which site?' } }, { text: 'unused' }]);
  const asked = await turn('Check my site');
  assert.equal(asked.status.state, 'TASK_STATE_INPUT_REQUIRED');
  const { payload } = await call('CancelTask', { id: asked.id });
  assert.equal(payload.result.status.state, 'TASK_STATE_CANCELED');

  const until = Date.now() + 10_000;
  let read = await getTask(asked.id);
  while (read.status.state !== 'TASK_STATE_CANCELED' && Date.now() < until) read = await getTask(asked.id);
  assert.equal(read.status.state, 'TASK_STATE_CANCELED');
  assert.equal(read.metadata.session, 'closed');
});

test('a cap: the turn completes, the task names the cap, and the session takes no more messages', async () => {
  h.reset({ turns: 1, closeGraceSeconds: 30 });
  h.script.set([{ text: 'Only answer.' }]);
  const done = await turn('one question');
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(done.metadata.ended, 'cap:turns');
  assert.equal(done.metadata.session, 'closed');
  assert.equal(answerOf(done), 'Only answer.');

  const callsBefore = h.script.calls;
  const refused = await send('another', { contextId: done.contextId });
  assert.equal(refused.payload.error.code, -32004);
  assert.equal(h.script.calls, callsBefore, 'no model call after the cap');
});

test('a refused start costs no workflow and no model call', async () => {
  allow = false;
  const before = h.script.calls;
  const { payload, outcome } = await send('Can you check my site?');
  assert.equal(payload.error.code, -32000);
  assert.equal(outcome, 'rate-limited/session/caller');
  assert.match(payload.error.message, /https:\/\/www\.mattpyle\.com\/mcp/);
  assert.equal(h.script.calls, before);
});

test('a foreign id is refused as not found, whatever kind of id it is', async () => {
  await h.env.client.workflow.start('SomethingElse', {
    workflowId: 'a2a-consultant-00000000-0000-4000-8000-0000000000aa',
    taskQueue: 'nobody-polls-this',
  });
  for (const id of [
    'a2a-consultant-00000000-0000-4000-8000-0000000000aa', // exists, wrong type
    'a2a-consultant-00000000-0000-4000-8000-0000000000aa-t1',
    'a2a-consultant-00000000-0000-4000-8000-0000000000bb', // well formed, absent
    'a2a-consultant-not-a-uuid',
    'consultant-test-x',
  ]) {
    const read = await call('GetTask', { id });
    assert.equal(read.payload.error?.code, -32001, id);
    const reply = await send('hello', { taskId: id });
    assert.equal(reply.payload.error?.code, -32001, `SendMessage to ${id}`);
  }
  const audit = await call('CancelTask', { id: 'steward-audit-example.com-deep-1a2b3c4d' });
  assert.equal(audit.payload.error.code, -32002);
  assert.equal(limitCalls, 0, 'a refused id starts no session');
});

test('a caller looping GetTask on a finished turn leaves the history unchanged', async () => {
  h.script.set([{ text: 'Idle now.' }]);
  const task = await turn('hi');
  const handle = h.env.client.workflow.getHandle(task.contextId);
  const before = (await handle.describe()).historyLength;
  for (let i = 0; i < 25; i++) assert.equal((await getTask(task.id)).status.state, 'TASK_STATE_COMPLETED');
  const afterLength = (await handle.describe()).historyLength;
  assert.equal(afterLength, before, 'GetTask wrote nothing into history');
});

test('the session is started with an execution timeout and no agent config', async () => {
  h.script.set([{ text: 'Hi.' }]);
  const task = await turn('hi');
  const history = await h.env.client.workflow.getHandle(task.contextId).fetchHistory();
  const started = history.events?.[0]?.workflowExecutionStartedEventAttributes;
  assert.equal(Number(started?.workflowExecutionTimeout?.seconds), 3 * 60 * 60);
  const input = JSON.parse(Buffer.from(started!.input!.payloads![0]!.data!).toString('utf8'));
  assert.deepEqual(input, {});
});
