import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONSULTANT_SKILL_ID,
  approvalFrom,
  consultantStateFor,
  consultantTurnFor,
  isConsultantTaskId,
  UNAVAILABLE_TASK_TEXT,
  UNAVAILABLE_TEXT,
  WAIT_BUDGET_MS,
  WAIT_INTERVAL_MS,
  wantsImmediateReturn,
} from '../src/lib/a2a-consultant-skill.mjs';
import { ASK_SKILL_ID, AUDIT_SKILL_ID, routeMessage } from '../src/lib/a2a-audit-skill.mjs';
import { A2A_METHOD, STREAM_METHOD, respond, respondOrStream } from '../src/lib/a2a-responder.mjs';
import {
  CONSULTANT_SESSION_QUERY,
  CONSULTANT_TASK_QUEUE,
  CONSULTANT_WORKFLOW_TYPE,
  consultantTaskIdFor,
  consultantTurnTaskId,
  isConsultantSessionId,
  parseConsultantTaskId,
} from '../src/lib/consultant-task-id.mjs';

// Steward's model on A2A, pure: the routing, the ids, the state of each turn's task, the wait, the
// approval words and the refusals, against a fake engine. tests in agents/consultant/tests/a2a-adapter.test.ts run the
// same code against the real agent on a dev server.

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const ID = consultantTaskIdFor('0f8fad5b-d9cb-469f-a165-70867728950e');
const T1 = consultantTurnTaskId(ID, 1);
const T2 = consultantTurnTaskId(ID, 2);

test('the names the site calls the consultant by match the package', () => {
  const names = read('agents/consultant/src/names.ts');
  const config = read('agents/consultant/src/config.ts');
  assert.match(names, new RegExp(`AGENT_NAME = '${CONSULTANT_WORKFLOW_TYPE}'`));
  assert.match(names, new RegExp(`SESSION_QUERY = '${CONSULTANT_SESSION_QUERY}'`));
  assert.match(config, new RegExp(`DEFAULT_TASK_QUEUE = '${CONSULTANT_TASK_QUEUE}'`));
});

test('the adapter imports nothing from the consultant package or the harness', () => {
  for (const file of ['src/lib/a2a-consultant-skill.mjs', 'src/lib/a2a-consultant-temporal.mjs', 'src/lib/consultant-task-id.mjs', 'src/pages/a2a.ts']) {
    const imports = [...read(file).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.ok(!/agent-harness|agents\/consultant|@mattpyle\/consultant|strands/.test(specifier), `${file} imports ${specifier}`);
    }
  }
});

test('a session id is the prefix and a whole UUID; a task id adds the turn; nothing else passes', () => {
  assert.ok(isConsultantTaskId(ID));
  assert.ok(isConsultantSessionId(ID));
  assert.deepEqual(parseConsultantTaskId(ID), { sessionId: ID, turn: null });
  assert.equal(T2, `${ID}-t2`);
  assert.ok(isConsultantTaskId(T2));
  assert.equal(isConsultantSessionId(T2), false, 'a turn id is not a context id');
  assert.deepEqual(parseConsultantTaskId(T2), { sessionId: ID, turn: 2 });
  for (const id of ['a2a-consultant-', 'a2a-consultant-x', `${ID}x`, `${ID}/`, `${ID}-t0`, `${ID}-t`, `${ID}-t1x`, `${ID}-2`, 'steward-audit-example.com-deep-1a2b3c4d', 42, null]) {
    assert.equal(isConsultantTaskId(id), false, String(id));
    assert.equal(parseConsultantTaskId(id), null, String(id));
  }
});

const PLAIN = ['Can you check my site?', 'What is this site about?', 'audit example.com', 'Run a deep audit of example.com'];

test('with a model, a message that names no skill goes to the model, whatever its wording', () => {
  for (const text of PLAIN) {
    assert.deepEqual(routeMessage({}, text, { model: true }), { skill: CONSULTANT_SKILL_ID, explicit: false }, text);
  }
});

test('with a model, a named audit or ask skill is still answered by that skill', () => {
  const audit = routeMessage({ message: { metadata: { skill: AUDIT_SKILL_ID } } }, 'audit example.com', { model: true });
  assert.equal(audit.skill, AUDIT_SKILL_ID);
  assert.equal(audit.tier, 'fast');
  assert.equal(audit.target, 'example.com');
  assert.equal(routeMessage({ metadata: { skill: ASK_SKILL_ID } }, 'audit example.com', { model: true }).skill, ASK_SKILL_ID);
});

test('without a model, a message that names no skill is sorted by wording, as before', () => {
  for (const options of [undefined, {}, { model: false }]) {
    for (const text of ['Can you check my site?', 'What is this site about?', 'consult on example.com']) {
      assert.equal(routeMessage({}, text, options).skill, ASK_SKILL_ID, text);
    }
    assert.equal(routeMessage({}, 'audit example.com', options).skill, AUDIT_SKILL_ID);
    assert.equal(routeMessage({}, 'Run a deep audit of example.com', options).tier, 'deep');
  }
});

test('a name or a task id reaches the model with or without one configured', () => {
  for (const options of [{ model: false }, { model: true }]) {
    assert.equal(routeMessage({ message: { metadata: { skill: CONSULTANT_SKILL_ID } } }, 'hi', options).skill, CONSULTANT_SKILL_ID);
    assert.equal(routeMessage({ metadata: { skill: CONSULTANT_SKILL_ID } }, 'audit example.com', options).skill, CONSULTANT_SKILL_ID);
    assert.equal(routeMessage({ message: { taskId: ID } }, 'example.com', options).skill, CONSULTANT_SKILL_ID);
    assert.equal(routeMessage({ message: { taskId: T2 } }, 'example.com', options).skill, CONSULTANT_SKILL_ID);
  }
});

test('an approval is a whole yes or no, or metadata.approve', () => {
  for (const yes of ['yes', 'Yes.', 'approve', ' OK ']) assert.equal(approvalFrom({}, yes), true, yes);
  for (const no of ['no', 'No!', 'decline', 'refuse']) assert.equal(approvalFrom({}, no), false, no);
  for (const unclear of ['yes, but audit example.org', 'maybe', 'sure thing']) assert.equal(approvalFrom({}, unclear), null, unclear);
  assert.equal(approvalFrom({ message: { metadata: { approve: false } } }, 'yes'), false);
});

const status = (over = {}) => ({
  current_turn: 1,
  turn_active: false,
  pending_turns: [],
  pending_callbacks: [],
  pending_approvals: [],
  close_reason: null,
  ...over,
});
const session = (over = {}) => ({
  turns: 1,
  ended: null,
  lastReply: { turn: 1, text: 'The answer.' },
  replies: [{ turn: 1, text: 'The answer.' }],
  ...over,
});
/** A session two turns in, both answered. */
const twoTurns = (over = {}) =>
  session({
    turns: 2,
    lastReply: { turn: 2, text: 'Second answer.' },
    replies: [{ turn: 1, text: 'The answer.' }, { turn: 2, text: 'Second answer.' }],
    ...over,
  });
const open = (over = {}) => ({ execution: 'RUNNING', status: status(), session: session(), ...over });

test('the state mapping, row by row', () => {
  const cases = [
    [{ execution: 'RUNNING', status: status({ turn_active: true }), session: session({ lastReply: null }) }, 'working'],
    [{ execution: 'RUNNING', status: status({ pending_turns: [{}] }), session: session() }, 'working'],
    [{ execution: 'RUNNING', status: status(), session: session({ lastReply: null }) }, 'working'],
    [{ execution: 'RUNNING', status: null, session: null }, 'submitted'],
    [{ execution: 'RUNNING', status: status({ turn_active: true, pending_callbacks: [{ tool_id: 't1', tool_input: { question: 'Which site?' } }] }), session: session() }, 'input_required', 'answer', 'Which site?'],
    [{ execution: 'RUNNING', status: status({ turn_active: true, pending_approvals: [{ tool_id: 't2', tool_input: { url: 'example.com' } }] }), session: session() }, 'input_required', 'approval'],
    [{ execution: 'RUNNING', status: status(), session: session() }, 'input_required', 'message', 'The answer.'],
    [{ execution: 'RUNNING', status: status(), session: session({ ended: { reason: 'cap:turns', turn: 1 } }) }, 'completed', undefined, 'The answer.', 'cap:turns'],
    [{ execution: 'COMPLETED', status: status({ close_reason: 'requested' }), session: session({ ended: { reason: 'cap:tokens', turn: 1 } }) }, 'completed', undefined, 'The answer.', 'cap:tokens'],
    [{ execution: 'COMPLETED', status: status({ close_reason: 'idle_timeout_expired' }), session: session() }, 'completed', undefined, 'The answer.', 'idle'],
    [{ execution: 'COMPLETED', status: status({ close_reason: 'requested' }), session: session() }, 'canceled', undefined, 'The answer.'],
    [{ execution: 'RUNNING', status: status({ close_reason: 'requested' }), session: session() }, 'canceled'],
    [{ execution: 'TIMED_OUT', status: null, session: null }, 'failed', undefined, undefined, 'timed_out'],
    [{ execution: 'TERMINATED', status: null, session: null }, 'failed'],
    [{ execution: 'FAILED', status: null, session: session() }, 'failed', undefined, 'The answer.'],
  ];
  for (const [reading, state, awaiting, text, ended] of cases) {
    const view = consultantStateFor(reading);
    const label = JSON.stringify(reading);
    assert.equal(view.state, state, label);
    assert.equal(view.awaiting, awaiting, label);
    if (text !== undefined) assert.equal(view.text, text, label);
    if (ended !== undefined) assert.equal(view.ended, ended, label);
  }
});

/** A fake engine that records calls. `reading` is one reading, or a function that returns the next. */
function fakeEngine(reading) {
  const calls = [];
  return {
    calls,
    engine: {
      start: async (text) => (calls.push(['start', text]), { workflowId: ID, accepted: true }),
      read: async (sessionId, options) => {
        calls.push(['read', sessionId, ...(options?.within === undefined ? [] : [options.within])]);
        if (sessionId !== ID) throw Object.assign(new Error('missing'), { name: 'ConsultantNotFound' });
        return typeof reading === 'function' ? reading(calls) : reading;
      },
      answer: async (...args) => calls.push(['answer', ...args]),
      decide: async (...args) => calls.push(['decide', ...args]),
      send: async (...args) => calls.push(['send', ...args]),
      close: async (...args) => calls.push(['close', ...args]),
    },
  };
}

/** A clock a test moves: `sleep` advances it and returns at once. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps = [];
  return { sleeps, clock: { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } }, advance: (ms) => { t += ms; } };
}

let n = 0;
async function rpc(method, params, consultant) {
  return respond(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), {
    digest: {},
    newId: () => `id-${++n}`,
    now: () => '2026-11-13T00:00:00.000Z',
    consultant,
  });
}
const message = (text, extra = {}) => ({ message: { role: 'ROLE_USER', messageId: 'm', parts: [{ text }], ...extra } });
const allow = async () => ({ allowed: true });
const answerOf = (task) => task.artifacts?.[0]?.parts?.[0]?.text;

test('each turn is its own task: earlier turns stay completed, the latest follows the session', () => {
  const asking = status({ turn_active: true, pending_callbacks: [{ tool_id: 't1', tool_input: { question: 'Which site?' } }] });
  const cases = [
    // [reading, turn asked, state, answer, extra]
    [open(), 1, 'completed', 'The answer.'],
    [open(), null, 'completed', 'The answer.'],
    [open({ session: twoTurns() }), 1, 'completed', 'The answer.'],
    [open({ session: twoTurns() }), 2, 'completed', 'Second answer.'],
    [open({ session: twoTurns() }), null, 'completed', 'Second answer.'],
    [open({ session: twoTurns() }), 3, null],
    // Turn 2 is running: turn 1 is still completed.
    [open({ status: status({ turn_active: true }), session: session({ turns: 2 }) }), 1, 'completed', 'The answer.'],
    [open({ status: status({ turn_active: true }), session: session({ turns: 2 }) }), 2, 'working'],
    [open({ status: status({ turn_active: true }), session: session({ turns: 2 }) }), null, 'working'],
    // A question in turn 2.
    [open({ status: asking, session: session({ turns: 2 }) }), 2, 'input_required', undefined, { awaiting: 'answer', text: 'Which site?' }],
    [open({ status: asking, session: session({ turns: 2 }) }), 1, 'completed', 'The answer.'],
    // A message is admitted and its turn not yet counted.
    [open({ status: status({ pending_turns: [{}] }) }), 2, 'working'],
    [open({ status: status({ pending_turns: [{}] }) }), 1, 'completed', 'The answer.'],
    [open({ status: status({ pending_turns: [{}] }) }), null, 'working'],
    // The first message, before its turn starts.
    [open({ status: status({ pending_turns: [{}] }), session: session({ turns: 0, lastReply: null, replies: [] }) }), 1, 'working'],
    [{ execution: 'RUNNING', status: null, session: null }, 1, 'submitted'],
    // A cap or an idle close: the turn is completed and the session is closed.
    [open({ session: session({ ended: { reason: 'cap:turns', turn: 1 } }) }), 1, 'completed', 'The answer.', { ended: 'cap:turns', closed: true }],
    [{ execution: 'COMPLETED', status: status({ close_reason: 'idle_timeout_expired' }), session: twoTurns() }, 1, 'completed', 'The answer.', { ended: 'idle', closed: true }],
    // A cancel: an answered turn stays completed, an open one is canceled.
    [{ execution: 'COMPLETED', status: status({ close_reason: 'requested' }), session: twoTurns() }, 2, 'completed', 'Second answer.', { closed: true }],
    [{ execution: 'COMPLETED', status: status({ close_reason: 'requested' }), session: session({ turns: 2 }) }, 2, 'canceled', undefined, { closed: true, text: 'The session was canceled.' }],
    [{ execution: 'COMPLETED', status: status({ close_reason: 'requested' }), session: session({ turns: 2 }) }, 1, 'completed', 'The answer.', { closed: true }],
    // A failure: the same.
    [{ execution: 'FAILED', status: null, session: session({ turns: 2 }) }, 2, 'failed', undefined, { closed: true, text: 'The session failed before this turn was answered.' }],
    [{ execution: 'COMPLETED', status: status({ close_reason: 'idle_timeout_expired' }), session: session({ turns: 2 }) }, 2, 'completed', undefined, { closed: true, text: 'The session ended before this turn was answered.' }],
    [{ execution: 'FAILED', status: null, session: session({ turns: 2 }) }, 1, 'completed', 'The answer.'],
    [{ execution: 'TIMED_OUT', status: null, session: null }, 1, 'failed'],
  ];
  for (const [reading, turn, state, answer, extra] of cases) {
    const view = consultantTurnFor(reading, turn);
    const label = `${JSON.stringify(reading)} turn ${turn}`;
    if (state === null) {
      assert.equal(view, null, label);
      continue;
    }
    assert.equal(view.state, state, label);
    assert.equal(view.answer, answer, label);
    for (const [key, value] of Object.entries(extra ?? {})) assert.equal(view[key], value, `${label} ${key}`);
  }
});

test('a session read from a worker older than replies: the latest turn answers, an earlier one says its text is not kept', () => {
  const old = { turns: 2, ended: null, lastReply: { turn: 2, text: 'Second answer.' } };
  const latest = consultantTurnFor(open({ session: old }), 2);
  assert.equal(latest.state, 'completed');
  assert.equal(latest.answer, 'Second answer.');
  const earlier = consultantTurnFor(open({ session: old }), 1);
  assert.equal(earlier.state, 'completed');
  assert.equal(earlier.answer, undefined, 'no artifact is invented');
  assert.match(earlier.text, /not kept/);
  assert.equal(consultantTurnFor(open({ session: old }), null).answer, 'Second answer.');
});

test('a new session is charged before it starts, and a refusal starts nothing and names the other doors', async () => {
  const fake = fakeEngine(open());
  let charged = 0;
  const refused = await rpc(A2A_METHOD, message('hi'), {
    checkLimit: async () => (charged++, { allowed: false, scope: 'global', reason: 'this endpoint has run 20 consultant sessions today', retryAfterSeconds: 10 }),
    engine: fake.engine,
  });
  assert.equal(charged, 1);
  assert.equal(refused.payload.error.code, -32000);
  assert.equal(refused.payload.error.data[0].metadata.tier, 'session');
  for (const door of ['https://www.mattpyle.com/mcp', `{"skill":"${AUDIT_SKILL_ID}"}`, `{"skill":"${ASK_SKILL_ID}"}`]) {
    assert.ok(refused.payload.error.message.includes(door), door);
  }
  assert.deepEqual(fake.calls, [], 'no silent fall back to another skill, and no start');
});

test('one send, no metadata: the task comes back completed, with the answer as its artifact', async () => {
  const fake = fakeEngine(open());
  const ok = await rpc(A2A_METHOD, message('Check example.com'), { checkLimit: allow, engine: fake.engine, ...fakeClock() });
  const task = ok.payload.result.task;
  assert.equal(ok.outcome, 'ok/consultant-start/completed');
  assert.equal(task.id, T1);
  assert.equal(task.contextId, ID, 'the context is the session');
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.status.message, undefined, 'a completed task carries its answer once, in the artifact');
  assert.equal(task.artifacts.length, 1);
  assert.equal(task.artifacts[0].name, 'answer');
  assert.equal(task.artifacts[0].artifactId, `${T1}-answer`);
  assert.deepEqual(task.artifacts[0].parts, [{ text: 'The answer.', mediaType: 'text/markdown' }]);
  assert.deepEqual(task.metadata, { skill: CONSULTANT_SKILL_ID, workflowId: ID, turn: 1 });
  assert.deepEqual(fake.calls.map(([kind]) => kind), ['start', 'read']);
});

test('a send waits for its turn by reading, up to the budget, and then returns working', async () => {
  const fake = fakeEngine(open({ status: status({ turn_active: true }), session: session({ turns: 1, lastReply: null, replies: [] }) }));
  const time = fakeClock();
  const slow = await rpc(A2A_METHOD, message('Check example.com'), { checkLimit: allow, engine: fake.engine, clock: time.clock, startedAt: time.clock.now() });
  const task = slow.payload.result.task;
  assert.equal(task.status.state, 'TASK_STATE_WORKING');
  assert.equal(task.id, T1);
  assert.match(task.status.message.parts[0].text, new RegExp(`Poll GetTask with id "${T1}"`));
  assert.equal(task.artifacts, undefined);
  const reads = fake.calls.filter(([kind]) => kind === 'read');
  assert.ok(reads.length > 10, 'it kept reading');
  assert.ok(time.sleeps.every((ms) => ms === WAIT_INTERVAL_MS));
  assert.ok(time.sleeps.length * WAIT_INTERVAL_MS < WAIT_BUDGET_MS, 'the waiting stays inside the budget');
  assert.ok(reads.every(([, , within]) => within > 0 && within <= WAIT_BUDGET_MS), 'each read is told the time left');
  assert.ok(reads.at(-1)[2] < reads[0][2]);

  // The budget counts from the request's arrival, not from the start of the wait.
  const late = fakeEngine(open({ status: status({ turn_active: true }), session: session({ turns: 1, lastReply: null, replies: [] }) }));
  const clock2 = fakeClock();
  const startedAt = clock2.clock.now();
  clock2.advance(WAIT_BUDGET_MS);
  const spent = await rpc(A2A_METHOD, message('hi'), { checkLimit: allow, engine: late.engine, clock: clock2.clock, startedAt });
  assert.equal(spent.payload.result.task.status.state, 'TASK_STATE_WORKING');
  assert.deepEqual(late.calls.map(([kind]) => kind), ['start'], 'no time left, so no read');
});

test('the wait ends as soon as the turn does: an answer, a question or an approval request', async () => {
  const readings = [
    open({ status: status({ turn_active: true }), session: session({ turns: 1, lastReply: null, replies: [] }) }),
    open({ status: status({ turn_active: true }), session: session({ turns: 1, lastReply: null, replies: [] }) }),
    open({ status: status({ turn_active: true, pending_approvals: [{ tool_id: 't2', tool_input: { url: 'example.com' } }] }), session: session({ turns: 1, lastReply: null, replies: [] }) }),
  ];
  const fake = fakeEngine(() => readings.shift());
  const time = fakeClock();
  const result = await rpc(A2A_METHOD, message('Deep audit example.com'), { checkLimit: allow, engine: fake.engine, clock: time.clock });
  const task = result.payload.result.task;
  assert.equal(task.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(task.metadata.awaiting, 'approval');
  assert.match(task.status.message.parts[0].text, /deep audit of example\.com/);
  assert.equal(time.sleeps.length, 2);
});

test('a caller that asks for an immediate return gets working at once, in either dialect', async () => {
  assert.equal(wantsImmediateReturn({ configuration: { returnImmediately: true } }), true);
  assert.equal(wantsImmediateReturn({ configuration: { blocking: false } }), true);
  for (const params of [{}, { configuration: {} }, { configuration: { blocking: true } }, { configuration: { returnImmediately: false } }, { configuration: 'x' }]) {
    assert.equal(wantsImmediateReturn(params), false, JSON.stringify(params));
  }
  const fake = fakeEngine(open());
  const result = await rpc(A2A_METHOD, { ...message('hi'), configuration: { returnImmediately: true } }, { checkLimit: allow, engine: fake.engine });
  assert.equal(result.payload.result.task.status.state, 'TASK_STATE_WORKING');
  assert.equal(result.payload.result.task.id, T1);
  assert.deepEqual(fake.calls, [['start', 'hi']], 'no read');
});

test('a read that fails during the wait returns working, because the message is delivered', async () => {
  const fake = fakeEngine(() => { throw new Error('Temporal Cloud did not answer within 6s'); });
  const result = await rpc(A2A_METHOD, message('hi'), { checkLimit: allow, engine: fake.engine, ...fakeClock() });
  assert.equal(result.payload.result.task.status.state, 'TASK_STATE_WORKING');
  assert.equal(result.payload.error, undefined);
});

test('a reply goes where the session is waiting, on the right task, and is never charged', async () => {
  const reading = open({ status: status({ turn_active: true, pending_callbacks: [{ tool_id: 't1', tool_input: { question: 'Which?' } }] }) });
  const fake = fakeEngine(reading);
  const consultant = { checkLimit: async () => assert.fail('a reply is not a new session'), engine: fake.engine, ...fakeClock() };
  const immediate = (text, extra) => ({ ...message(text, extra), configuration: { returnImmediately: true } });

  // An answer and a decision belong to the open turn's task.
  const answered = await rpc(A2A_METHOD, immediate('example.com', { taskId: T1 }), consultant);
  assert.deepEqual(fake.calls.at(-1), ['answer', ID, 't1', 'example.com']);
  assert.equal(answered.payload.result.task.id, T1);

  reading.status = status({ turn_active: true, pending_approvals: [{ tool_id: 't2', tool_input: { url: 'example.com' } }] });
  const unclear = await rpc(A2A_METHOD, immediate('yes, but another site', { taskId: T1 }), consultant);
  assert.equal(unclear.payload.error.code, -32602);
  await rpc(A2A_METHOD, immediate('no', { taskId: T1 }), consultant);
  assert.deepEqual(fake.calls.at(-1), ['decide', ID, 't2', false]);

  // The next message is a new task, named by the context id alone, by a finished task's id, or by
  // the bare session id an older client holds.
  reading.status = status();
  for (const extra of [{ contextId: ID }, { taskId: T1 }, { taskId: ID }, { taskId: T1, contextId: 'the-callers-own' }]) {
    const next = await rpc(A2A_METHOD, immediate('What next?', extra), consultant);
    assert.deepEqual(fake.calls.at(-1), ['send', ID, 'What next?'], JSON.stringify(extra));
    assert.equal(next.payload.result.task.id, T2, 'the second turn is a new task');
    assert.equal(next.payload.result.task.contextId, ID);
    assert.equal(next.outcome, 'ok/consultant-reply/message');
  }

  reading.status = status({ turn_active: true });
  const busy = await rpc(A2A_METHOD, message('hello?', { contextId: ID }), consultant);
  assert.equal(busy.payload.error.code, -32004);
  assert.equal(fake.calls.at(-1)[0], 'read');
});

test('a second turn waits and completes as its own task, and turn 1 still reads back', async () => {
  let sent = false;
  const fake = fakeEngine((calls) => {
    sent ||= calls.some(([kind]) => kind === 'send');
    return open({ session: sent ? twoTurns() : session() });
  });
  const consultant = { checkLimit: async () => assert.fail('not a new session'), engine: fake.engine, ...fakeClock() };
  const second = await rpc(A2A_METHOD, message('What next?', { contextId: ID }), consultant);
  const task = second.payload.result.task;
  assert.equal(task.id, T2);
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(answerOf(task), 'Second answer.');
  assert.equal(task.metadata.turn, 2);

  const first = await rpc('GetTask', { id: T1 }, consultant);
  assert.equal(first.payload.result.id, T1);
  assert.equal(first.payload.result.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(answerOf(first.payload.result), 'The answer.');
  assert.equal(first.payload.result.contextId, ID);
  const bare = await rpc('GetTask', { id: ID }, consultant);
  assert.equal(bare.payload.result.id, ID, 'a bare session id is answered under the id asked for');
  assert.equal(answerOf(bare.payload.result), 'Second answer.', 'and stands for the latest turn');
  const beyond = await rpc('GetTask', { id: consultantTurnTaskId(ID, 3) }, consultant);
  assert.equal(beyond.payload.error.code, -32001);
});

test("a caller's own context id is not a session: the message starts one, and the session's id comes back", async () => {
  const fake = fakeEngine(open());
  const result = await rpc(A2A_METHOD, message('hi', { contextId: 'ctx-from-client' }), { checkLimit: allow, engine: fake.engine, ...fakeClock() });
  assert.equal(fake.calls[0][0], 'start');
  assert.equal(result.payload.result.task.contextId, ID);
});

test('a message to an ended session is refused, and told to send again without the context id', async () => {
  for (const reading of [
    open({ session: session({ ended: { reason: 'cap:turns', turn: 1 } }) }),
    { execution: 'COMPLETED', status: status({ close_reason: 'requested' }), session: session() },
    { execution: 'COMPLETED', status: status({ close_reason: 'idle_timeout_expired' }), session: session() },
  ]) {
    const fake = fakeEngine(reading);
    const result = await rpc(A2A_METHOD, message('more', { contextId: ID }), { checkLimit: async () => assert.fail('not charged'), engine: fake.engine });
    assert.equal(result.payload.error.code, -32004);
    assert.match(result.payload.error.message, /no context id and no task id/);
    assert.deepEqual(fake.calls.map(([kind]) => kind), ['read']);
  }
});

test('GetTask and CancelTask refuse a foreign id before the engine is asked', async () => {
  const fake = fakeEngine(null);
  const consultant = { checkLimit: allow, engine: fake.engine };
  const missing = await rpc('GetTask', { id: consultantTaskIdFor('00000000-0000-4000-8000-000000000000') }, consultant);
  assert.equal(missing.payload.error.code, -32001);
  const malformed = await rpc('CancelTask', { id: 'a2a-consultant-nope' }, consultant);
  assert.equal(malformed.payload.error.code, -32001);
  const audit = await rpc('CancelTask', { id: 'steward-audit-example.com-deep-1a2b3c4d' }, consultant);
  assert.equal(audit.payload.error.code, -32002);
  const foreign = await rpc(A2A_METHOD, message('hi', { taskId: 'steward-audit-example.com-deep-1a2b3c4d' }), consultant);
  assert.equal(foreign.payload.error.code, -32001);
  assert.ok(fake.calls.every(([kind]) => kind === 'read'), 'only reads, and only of a well-formed id');
});

test('CancelTask on any task closes the session: an answered turn stays completed, an open one is canceled', async () => {
  const done = fakeEngine(open({ session: twoTurns() }));
  for (const id of [T1, T2, ID]) {
    const result = await rpc('CancelTask', { id }, { checkLimit: allow, engine: done.engine });
    assert.deepEqual(done.calls.at(-1), ['close', ID], id);
    assert.equal(result.payload.result.id, id);
    assert.equal(result.payload.result.status.state, 'TASK_STATE_COMPLETED', id);
    assert.equal(result.payload.result.metadata.session, 'closed', id);
    assert.equal(answerOf(result.payload.result), id === T1 ? 'The answer.' : 'Second answer.');
  }

  const asking = fakeEngine(open({ status: status({ turn_active: true, pending_callbacks: [{ tool_id: 't1', tool_input: { question: 'Which?' } }] }), session: session({ turns: 2 }) }));
  const result = await rpc('tasks/cancel', { id: T2 }, { checkLimit: allow, engine: asking.engine });
  assert.equal(result.payload.result.status.state, 'canceled');
  assert.equal(result.payload.result.kind, 'task', 'the legacy dialect when asked');
  assert.equal(result.payload.result.metadata.session, 'closed');
  assert.deepEqual(asking.calls.at(-1), ['close', ID]);

  const closed = fakeEngine({ execution: 'COMPLETED', status: status({ close_reason: 'requested' }), session: twoTurns() });
  const again = await rpc('CancelTask', { id: T1 }, { checkLimit: allow, engine: closed.engine });
  assert.equal(again.payload.error.code, -32002);
  assert.deepEqual(closed.calls.map(([kind]) => kind), ['read']);
});

test('the 0.x dialect: a completed turn carries kind and a text part with its kind', async () => {
  const fake = fakeEngine(open());
  const result = await rpc('message/send', message('hi'), { checkLimit: allow, engine: fake.engine, ...fakeClock() });
  const task = result.payload.result;
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'completed');
  assert.deepEqual(task.artifacts[0].parts, [{ kind: 'text', text: 'The answer.' }]);
});

test('unreachable: a fixed reply, and the error text stays in the log detail', async () => {
  const leak = new Error('Failed to connect to example-ns.zz99q.tmprl.example:7233 in namespace example-ns.zz99q');
  const failing = {
    start: async () => { throw leak; },
    read: async () => { throw leak; },
    close: async () => { throw leak; },
  };
  const consultant = { checkLimit: allow, engine: failing };
  const calls = [
    [A2A_METHOD, message('hi'), 'consultant-unavailable/start'],
    ['GetTask', { id: T1 }, 'consultant-unavailable/read'],
    [A2A_METHOD, message('more', { taskId: T1 }), 'consultant-unavailable/read'],
    [A2A_METHOD, message('more', { contextId: ID }), 'consultant-unavailable/read'],
    ['CancelTask', { id: T1 }, 'consultant-unavailable/read'],
  ];
  for (const [method, params, outcome] of calls) {
    const result = await rpc(method, params, consultant);
    const body = JSON.stringify(result.payload);
    const fresh = method === A2A_METHOD && !params.message.taskId && !params.message.contextId;
    assert.equal(result.outcome, outcome);
    assert.equal(result.payload.error.message, fresh ? UNAVAILABLE_TEXT : UNAVAILABLE_TASK_TEXT);
    assert.doesNotMatch(result.payload.error.message, /nothing was changed/i);
    assert.ok(!/zz99q|tmprl|7233|namespace/i.test(body), `${method}: ${body}`);
    assert.match(result.detail, /example-ns\.zz99q/, 'the detail keeps the cause for the log');
  }
  assert.match(UNAVAILABLE_TEXT, /^Steward could not be reached/);

  // A failed write after a good read: the same.
  const fake = fakeEngine(open());
  fake.engine.send = async () => { throw leak; };
  const send = await rpc(A2A_METHOD, message('more', { taskId: T1 }), { checkLimit: allow, engine: fake.engine });
  assert.equal(send.outcome, 'consultant-unavailable/send');
  assert.equal(send.payload.error.message, UNAVAILABLE_TASK_TEXT, 'a send that may have landed says to poll first');
  assert.ok(!/zz99q|tmprl/.test(JSON.stringify(send.payload)));
});

test('no handler in the two adapter files puts an error\'s own text into a reply', () => {
  for (const file of ['src/lib/a2a-consultant-skill.mjs', 'src/lib/a2a-consultant-temporal.mjs']) {
    const source = read(file);
    const echoes = [...source.matchAll(/error\.message|err\.message/g)].length;
    // a2a-consultant-skill.mjs: once, into `detail`. a2a-consultant-temporal.mjs: once, into a
    // reading's `queryError`, which no reply reads.
    assert.equal(echoes, 1, file);
  }
  assert.doesNotMatch(read('src/lib/a2a-consultant-skill.mjs'), /queryError/);
});

test('without a Temporal connection a named model skill says it is not configured, and plain text keeps the older routing', async () => {
  const named = await rpc(A2A_METHOD, message('hi', { metadata: { skill: CONSULTANT_SKILL_ID } }), undefined);
  assert.equal(named.outcome, 'consultant-unavailable/not-configured');
  const byId = await rpc('GetTask', { id: T1 }, undefined);
  assert.equal(byId.outcome, 'consultant-unavailable/not-configured');

  const digest = JSON.parse(read('src/data/a2a-digest.json'));
  const plain = await respond(JSON.stringify({ jsonrpc: '2.0', id: 1, method: A2A_METHOD, params: message('What is this site about?') }), {
    digest,
    newId: () => 'id',
  });
  assert.equal(plain.outcome, 'ok/site');
  assert.ok(plain.payload.result.message, 'a direct Message from ask-about-site');
});

// --- the streaming send -----------------------------------------------------------------------

/** Run one streaming send to its end: the events it sent, and the log token it returned. */
async function stream(params, consultant, id = 1) {
  const opened = await respondOrStream(JSON.stringify({ jsonrpc: '2.0', id, method: STREAM_METHOD, params }), {
    digest: {},
    newId: () => `id-${++n}`,
    now: () => '2026-11-13T00:00:00.000Z',
    consultant,
  });
  if (!opened.events) return { reply: opened, events: [] };
  const events = [];
  for (;;) {
    const next = await opened.events.next();
    if (next.done) return { events, outcome: next.value.outcome, detail: next.value.detail };
    events.push(next.value);
  }
}
const kinds = (events) => events.map((event) => (event.error ? 'error' : Object.keys(event.result)[0]));
const running = () => open({ status: status({ turn_active: true }), session: session({ turns: 1, lastReply: null, replies: [] }) });

test('a streamed turn: the task at once, then the answer as an artifact and the completed status', async () => {
  const readings = [running(), running(), open()];
  const fake = fakeEngine(() => readings.shift());
  const time = fakeClock();
  const { events, outcome } = await stream(message('Check example.com'), { checkLimit: allow, engine: fake.engine, clock: time.clock }, 'req-7');
  assert.deepEqual(kinds(events), ['task', 'artifactUpdate', 'statusUpdate']);
  assert.equal(outcome, 'stream/ok/consultant-start/completed');
  for (const event of events) {
    assert.equal(event.jsonrpc, '2.0');
    assert.equal(event.id, 'req-7', 'every event answers under the request id, in its own type');
  }

  const task = events[0].result.task;
  assert.equal(task.id, T1);
  assert.equal(task.contextId, ID);
  assert.equal(task.status.state, 'TASK_STATE_WORKING');
  assert.equal(task.artifacts, undefined);
  assert.deepEqual(task.metadata, { skill: CONSULTANT_SKILL_ID, workflowId: ID, turn: 1 });

  const artifact = events[1].result.artifactUpdate;
  assert.equal(artifact.taskId, T1);
  assert.equal(artifact.contextId, ID);
  assert.equal(artifact.lastChunk, true);
  assert.equal(artifact.append, undefined, 'the text arrives whole');
  assert.equal(artifact.artifact.name, 'answer');
  assert.equal(artifact.artifact.artifactId, `${T1}-answer`);
  assert.deepEqual(artifact.artifact.parts, [{ text: 'The answer.', mediaType: 'text/markdown' }]);

  const done = events[2].result.statusUpdate;
  assert.equal(done.taskId, T1);
  assert.equal(done.contextId, ID);
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(done.status.message, undefined, 'the answer is carried once, in the artifact');
  assert.deepEqual(done.metadata, { skill: CONSULTANT_SKILL_ID, workflowId: ID, turn: 1 });
  assert.equal(done.final, undefined, '1.0 has no final flag');

  assert.deepEqual(fake.calls.map(([kind]) => kind), ['start', 'read', 'read', 'read'], 'one start, then reads only');
  assert.equal(time.sleeps.length, 2);
});

test('a streamed turn that ends in a question or an approval request ends input-required, with no artifact', async () => {
  const cases = [
    [{ pending_callbacks: [{ tool_id: 't1', tool_input: { question: 'Which site?' } }] }, 'answer', /Which site\?/],
    [{ pending_approvals: [{ tool_id: 't2', tool_input: { url: 'example.com' } }] }, 'approval', /deep audit of example\.com/],
  ];
  for (const [pending, awaiting, text] of cases) {
    const readings = [running(), open({ status: status({ turn_active: true, ...pending }), session: session({ turns: 1, lastReply: null, replies: [] }) })];
    const fake = fakeEngine(() => readings.shift());
    const { events, outcome } = await stream(message('Can you check my site?'), { checkLimit: allow, engine: fake.engine, ...fakeClock() });
    assert.deepEqual(kinds(events), ['task', 'statusUpdate'], awaiting);
    const update = events[1].result.statusUpdate;
    assert.equal(update.status.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.equal(update.metadata.awaiting, awaiting);
    assert.match(update.status.message.parts[0].text, text);
    assert.equal(update.status.message.taskId, T1);
    assert.equal(outcome, 'stream/ok/consultant-start/input_required');
  }
});

test('a stream ends at the budget with the task still working, and says how to read the rest', async () => {
  const fake = fakeEngine(running());
  const time = fakeClock();
  const { events, outcome } = await stream(message('Check example.com'), { checkLimit: allow, engine: fake.engine, clock: time.clock, startedAt: time.clock.now() });
  assert.deepEqual(kinds(events), ['task', 'statusUpdate']);
  const last = events[1].result.statusUpdate;
  assert.equal(last.status.state, 'TASK_STATE_WORKING');
  assert.match(last.status.message.parts[0].text, new RegExp(`Poll GetTask with id "${T1}"`));
  assert.equal(outcome, 'stream/ok/consultant-start/working/budget');
  assert.ok(time.sleeps.length * WAIT_INTERVAL_MS < WAIT_BUDGET_MS, 'the same budget as the waiting send');
  assert.ok(fake.calls.filter(([kind]) => kind === 'read').every(([, , within]) => within > 0 && within <= WAIT_BUDGET_MS));
});

test('a stream sends nothing but reads after the delivery: no Update while it runs', async () => {
  const fake = fakeEngine(running());
  await stream(message('Check example.com'), { checkLimit: allow, engine: fake.engine, ...fakeClock() });
  const after = fake.calls.slice(1).map(([kind]) => kind);
  assert.equal(fake.calls[0][0], 'start');
  assert.ok(after.length > 10);
  assert.ok(after.every((kind) => kind === 'read'), 'start is the one Update; the rest are describes and Queries');
});

test('a streamed reply goes where the session is waiting, and a second turn is its own task', async () => {
  const asking = open({ status: status({ turn_active: true, pending_callbacks: [{ tool_id: 't1', tool_input: { question: 'Which site?' } }] }), session: session({ turns: 1, lastReply: null, replies: [] }) });
  const readings = [asking, running(), open()];
  const fake = fakeEngine(() => readings.shift());
  const answered = await stream(message('example.com', { taskId: T1 }), { checkLimit: async () => assert.fail('a reply is not charged'), engine: fake.engine, ...fakeClock() });
  assert.deepEqual(kinds(answered.events), ['task', 'artifactUpdate', 'statusUpdate']);
  assert.equal(answered.events[0].result.task.id, T1);
  assert.equal(answered.outcome, 'stream/ok/consultant-reply/answer/completed');
  assert.deepEqual(fake.calls.find(([kind]) => kind === 'answer'), ['answer', ID, 't1', 'example.com']);

  const next = [open(), open({ status: status({ turn_active: true }), session: session({ turns: 2 }) }), open({ session: twoTurns() })];
  const second = fakeEngine(() => next.shift());
  const turn2 = await stream(message('And then?', { contextId: ID }), { checkLimit: allow, engine: second.engine, ...fakeClock() });
  assert.equal(turn2.events[0].result.task.id, T2);
  assert.equal(turn2.events[1].result.artifactUpdate.artifact.parts[0].text, 'Second answer.');
  assert.equal(turn2.events[2].result.statusUpdate.taskId, T2);
});

test('an immediate return on a streaming send is the task and nothing else', async () => {
  const fake = fakeEngine(open());
  const { events, outcome } = await stream({ ...message('hi'), configuration: { returnImmediately: true } }, { checkLimit: allow, engine: fake.engine });
  assert.deepEqual(kinds(events), ['task']);
  assert.equal(events[0].result.task.status.state, 'TASK_STATE_WORKING');
  assert.equal(outcome, 'stream/ok/consultant-start/working/immediate');
  assert.deepEqual(fake.calls, [['start', 'hi']], 'no read');
});

test('a refusal on a streaming send is one error event, the same error the waiting send returns', async () => {
  const refuse = async () => ({ allowed: false, scope: 'caller', reason: 'this caller has used 3 consultant sessions today', retryAfterSeconds: 60, limit: 3 });
  const limited = await stream(message('hi'), { checkLimit: refuse, engine: fakeEngine(open()).engine });
  const plain = await rpc(A2A_METHOD, message('hi'), { checkLimit: refuse, engine: fakeEngine(open()).engine });
  assert.deepEqual(kinds(limited.events), ['error']);
  assert.deepEqual(limited.events[0], plain.payload);
  assert.equal(limited.outcome, 'stream/rate-limited/session/caller');

  const ended = { execution: 'COMPLETED', status: status({ close_reason: 'requested' }), session: twoTurns() };
  const closed = await stream(message('hi', { contextId: ID }), { checkLimit: allow, engine: fakeEngine(ended).engine });
  assert.deepEqual(kinds(closed.events), ['error']);
  assert.equal(closed.events[0].error.code, -32004);

  const down = fakeEngine(open());
  down.engine.start = async () => { throw new Error('connect ECONNREFUSED my-namespace.tmprl.cloud:7233'); };
  const unreachable = await stream(message('hi'), { checkLimit: allow, engine: down.engine });
  assert.deepEqual(kinds(unreachable.events), ['error']);
  assert.equal(unreachable.events[0].error.message, UNAVAILABLE_TEXT);
  assert.ok(!JSON.stringify(unreachable.events).includes('tmprl'), 'the error text stays out of the stream');
  assert.match(unreachable.detail, /ECONNREFUSED/, 'and goes to the log line');
});

test('a read that fails mid-stream ends it working, because the message is delivered', async () => {
  const fake = fakeEngine(() => { throw new Error('Temporal Cloud did not answer within 6s'); });
  const { events } = await stream(message('hi'), { checkLimit: allow, engine: fake.engine, ...fakeClock() });
  assert.deepEqual(kinds(events), ['task', 'statusUpdate']);
  assert.equal(events[1].result.statusUpdate.status.state, 'TASK_STATE_WORKING');
});

test('a client that has gone away stops the reads at the next step, and nothing is withdrawn', async () => {
  const signal = { aborted: false };
  let reads = 0;
  const fake = fakeEngine(() => {
    reads += 1;
    if (reads === 3) signal.aborted = true;
    return running();
  });
  const { events, outcome } = await stream(message('hi'), { checkLimit: allow, engine: fake.engine, signal, ...fakeClock() });
  assert.deepEqual(kinds(events), ['task'], 'no further event is written to a client that is gone');
  assert.equal(outcome, 'stream/ok/consultant-start/client-gone');
  assert.equal(reads, 3);
  assert.ok(!fake.calls.some(([kind]) => kind === 'close'), 'the session is not closed');
});

test('what is wrong at once is answered as plain JSON, not as a stream', async () => {
  const consultant = { checkLimit: allow, engine: fakeEngine(open()).engine };
  const noText = await stream({ message: { role: 'ROLE_USER', messageId: 'm', parts: [] } }, consultant);
  assert.equal(noText.reply.payload.error.code, -32602);
  assert.equal(noText.reply.outcome, 'stream/invalid-params/no-text');
  const noModel = await stream(message('hi', { metadata: { skill: CONSULTANT_SKILL_ID } }), undefined);
  assert.equal(noModel.reply.payload.error.data[0].reason, 'SKILL_NOT_CONFIGURED');
});

test('the route charges the session tier, passes the arrival time, and routes the census as it routes the reply', () => {
  const route = read('src/pages/a2a.ts');
  assert.match(route, /checkRateLimit\(\{ ip: clientIpFrom\(request\.headers\), tier: 'session' \}\)/);
  assert.match(route, /consultant: DEEP_ENABLED/);
  assert.match(route, /routeMessage\(params, text, \{ model: DEEP_ENABLED \}\)/);
  assert.match(route, /const startedAt = Date\.now\(\);\n  const raw = await request\.text\(\);/);
  assert.match(read('src/lib/a2a-responder.mjs'), /routeMessage\(params, text, \{ model: Boolean\(consultant\) \}\)/);
});

test('one session shows one context id on every call: the session id', async () => {
  const fake = fakeEngine(open());
  const deps = { checkLimit: allow, engine: fake.engine, ...fakeClock() };
  const started = await rpc(A2A_METHOD, message('hi'), deps);
  const read1 = await rpc('GetTask', { id: T1 }, deps);
  const next = await rpc(A2A_METHOD, { ...message('more', { contextId: ID }), configuration: { returnImmediately: true } }, deps);
  const canceled = await rpc('CancelTask', { id: T1 }, deps);
  const contexts = [started.payload.result.task, read1.payload.result, next.payload.result.task, canceled.payload.result].map((task) => task.contextId);
  assert.deepEqual(contexts, [ID, ID, ID, ID]);
  assert.equal(next.payload.result.task.status.message.contextId, ID);
});
