/**
 * The site's A2A adapter (`src/lib/a2a-consultant-skill.mjs` and `a2a-consultant-temporal.mjs`)
 * against the real agent: a local dev server, this package's worker, the scripted model and the
 * stub site. The adapter is driven through the site's own `respond()`, the function `/a2a` calls,
 * so these tests cover the JSON-RPC a caller sends and reads.
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

const send = (text: string, extra: { taskId?: string; metadata?: object } = {}) =>
  call('SendMessage', {
    message: {
      role: 'ROLE_USER',
      messageId: `m-${++counter}`,
      parts: [{ text }],
      ...(extra.taskId ? { taskId: extra.taskId } : { metadata: { skill: 'consult-on-a-site' } }),
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    },
  });

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

async function start(text: string) {
  const { payload } = await send(text);
  assert.ok(payload.result?.task, JSON.stringify(payload));
  return payload.result.task.id as string;
}

test('a question: the agent asks, the caller answers, the reply comes back as input-required', async () => {
  h.script.set([
    { tool: 'ask_user', input: { question: 'Which site should I audit?' } },
    { tool: 'audit_site', input: { url: 'example.com' } },
    { text: 'Publish llms.txt first.' },
  ]);
  const id = await start('Can you check my site?');
  assert.match(id, /^a2a-consultant-[0-9a-f-]{36}$/);
  assert.equal(limitCalls, 1, 'a new session is charged once');

  const asked = await settle(id);
  assert.equal(asked.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(asked.metadata.awaiting, 'answer');
  assert.equal(textOf(asked), 'Which site should I audit?');

  const answered = await send('example.com', { taskId: id });
  assert.equal(answered.payload.result.task.status.state, 'TASK_STATE_WORKING');
  assert.equal(limitCalls, 1, 'a reply on an open session is not charged');

  const replied = await settle(id);
  assert.equal(replied.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(replied.metadata.awaiting, 'message');
  assert.equal(textOf(replied), 'Publish llms.txt first.');
  assert.deepEqual(h.site.calls, ['fast https://example.com']);

  h.script.set([{ text: 'Then add agents.md.' }]);
  const next = await send('What next?', { taskId: id });
  assert.equal(next.payload.result?.task?.status.state, 'TASK_STATE_WORKING', JSON.stringify(next.payload));
  const second = await settle(id);
  assert.equal(textOf(second), 'Then add agents.md.');
  assert.equal(second.metadata.turn, 2);
});

test('an approval: a deep audit waits for yes, and an unclear reply sends nothing', async () => {
  h.script.set([{ tool: 'deep_audit', input: { url: 'example.com' } }, { text: 'Deep result read.' }]);
  const id = await start('Run a deep audit of example.com');
  const waiting = await settle(id);
  assert.equal(waiting.metadata.awaiting, 'approval');
  assert.match(textOf(waiting), /deep audit of example\.com/);

  const unclear = await send('yes, but audit example.org instead', { taskId: id });
  assert.equal(unclear.payload.error.code, -32602);
  assert.deepEqual(h.site.calls, [], 'nothing started on an unclear reply');

  await send('yes', { taskId: id });
  const done = await settle(id);
  assert.equal(textOf(done), 'Deep result read.');
  assert.deepEqual(h.site.calls, ['start https://example.com', 'read status', 'read report']);
});

test('a refusal: "no" declines the deep audit and starts nothing', async () => {
  h.script.set([{ tool: 'deep_audit', input: { url: 'example.com' } }, { text: 'Understood.' }]);
  const id = await start('Run a deep audit of example.com');
  await settle(id);
  await send('no', { taskId: id });
  const done = await settle(id);
  assert.equal(textOf(done), 'Understood.');
  assert.deepEqual(h.site.calls, []);
});

test('a cancel closes the session, a later GetTask says so, and a second cancel is refused', async () => {
  h.script.set([{ text: 'Hello.' }]);
  const id = await start('hi');
  await settle(id);
  const { payload } = await call('CancelTask', { id });
  assert.equal(payload.result.status.state, 'TASK_STATE_CANCELED');

  const until = Date.now() + 10_000;
  let task = await getTask(id);
  while (task.status.state !== 'TASK_STATE_CANCELED' && Date.now() < until) task = await getTask(id);
  assert.equal(task.status.state, 'TASK_STATE_CANCELED');
  assert.equal(textOf(task), 'Hello.', 'a terminal state carries the last reply');

  const again = await call('CancelTask', { id });
  assert.equal(again.payload.error.code, -32002);
  const late = await send('still there?', { taskId: id });
  assert.equal(late.payload.error.code, -32004);
});

test('a cap: the session reads completed at once, names the cap, and takes no more messages', async () => {
  h.reset({ turns: 1, closeGraceSeconds: 30 });
  h.script.set([{ text: 'Only answer.' }]);
  const id = await start('one question');
  const done = await settle(id);
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED', 'completed during the grace period, not input-required');
  assert.equal(done.metadata.ended, 'cap:turns');
  assert.equal(textOf(done), 'Only answer.');

  const callsBefore = h.script.calls;
  const refused = await send('another', { taskId: id });
  assert.equal(refused.payload.error.code, -32004);
  assert.equal(h.script.calls, callsBefore, 'no model call after the cap');
});

test('a refused start costs no workflow and no model call', async () => {
  allow = false;
  const before = h.script.calls;
  const { payload, outcome } = await send('Can you check my site?');
  assert.equal(payload.error.code, -32000);
  assert.equal(outcome, 'rate-limited/session/caller');
  assert.equal(h.script.calls, before);
});

test('a foreign id is refused as not found, whatever kind of id it is', async () => {
  await h.env.client.workflow.start('SomethingElse', {
    workflowId: 'a2a-consultant-00000000-0000-4000-8000-0000000000aa',
    taskQueue: 'nobody-polls-this',
  });
  for (const id of [
    'a2a-consultant-00000000-0000-4000-8000-0000000000aa', // exists, wrong type
    'a2a-consultant-00000000-0000-4000-8000-0000000000bb', // well formed, absent
    'a2a-consultant-not-a-uuid',
    'consultant-test-x',
  ]) {
    const read = await call('GetTask', { id });
    assert.equal(read.payload.error?.code, -32001, id);
    const reply = await send('hello', { taskId: id, metadata: { skill: 'consult-on-a-site' } });
    assert.equal(reply.payload.error?.code, -32001, `SendMessage to ${id}`);
  }
  const audit = await call('CancelTask', { id: 'steward-audit-example.com-deep-1a2b3c4d' });
  assert.equal(audit.payload.error.code, -32002);
});

test('a caller looping GetTask on an idle task leaves the history unchanged', async () => {
  h.script.set([{ text: 'Idle now.' }]);
  const id = await start('hi');
  await settle(id);
  const handle = h.env.client.workflow.getHandle(id);
  const before = (await handle.describe()).historyLength;
  for (let i = 0; i < 25; i++) assert.equal((await getTask(id)).status.state, 'TASK_STATE_INPUT_REQUIRED');
  const afterLength = (await handle.describe()).historyLength;
  assert.equal(afterLength, before, 'GetTask wrote nothing into history');
});

test('the session is started with an execution timeout and no agent config', async () => {
  h.script.set([{ text: 'Hi.' }]);
  const id = await start('hi');
  await settle(id);
  const history = await h.env.client.workflow.getHandle(id).fetchHistory();
  const started = history.events?.[0]?.workflowExecutionStartedEventAttributes;
  assert.equal(Number(started?.workflowExecutionTimeout?.seconds), 3 * 60 * 60);
  const input = JSON.parse(Buffer.from(started!.input!.payloads![0]!.data!).toString('utf8'));
  assert.deepEqual(input, {});
});
