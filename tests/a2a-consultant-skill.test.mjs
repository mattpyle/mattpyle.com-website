import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONSULTANT_SKILL_ID,
  approvalFrom,
  consultantStateFor,
  isConsultantTaskId,
  UNAVAILABLE_TASK_TEXT,
  UNAVAILABLE_TEXT,
} from '../src/lib/a2a-consultant-skill.mjs';
import { ASK_SKILL_ID, AUDIT_SKILL_ID, routeMessage } from '../src/lib/a2a-audit-skill.mjs';
import { A2A_METHOD, respond } from '../src/lib/a2a-responder.mjs';
import {
  CONSULTANT_SESSION_QUERY,
  CONSULTANT_TASK_QUEUE,
  CONSULTANT_WORKFLOW_TYPE,
  consultantTaskIdFor,
} from '../src/lib/consultant-task-id.mjs';

// The audit consultant's A2A skill, pure: the state mapping, the routing, the approval words and
// the refusals, against a fake engine. tests in agents/consultant/tests/a2a-adapter.test.ts run the
// same code against the real agent on a dev server.

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const ID = consultantTaskIdFor('0f8fad5b-d9cb-469f-a165-70867728950e');

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

test('a session id is the prefix and a whole UUID, and nothing else passes', () => {
  assert.ok(isConsultantTaskId(ID));
  for (const id of ['a2a-consultant-', 'a2a-consultant-x', `${ID}x`, `${ID}/`, 'steward-audit-example.com-deep-1a2b3c4d', 42, null]) {
    assert.equal(isConsultantTaskId(id), false, String(id));
  }
});

test('plain text never routes to the consultant; a name or a session id does', () => {
  for (const text of ['Can you check my site?', 'What is this site about?', 'consult on example.com']) {
    assert.notEqual(routeMessage({}, text).skill, CONSULTANT_SKILL_ID, text);
  }
  assert.equal(routeMessage({}, 'audit example.com').skill, AUDIT_SKILL_ID);
  assert.equal(routeMessage({}, 'What is this site about?').skill, ASK_SKILL_ID);
  assert.equal(routeMessage({ message: { metadata: { skill: CONSULTANT_SKILL_ID } } }, 'hi').skill, CONSULTANT_SKILL_ID);
  assert.equal(routeMessage({ metadata: { skill: CONSULTANT_SKILL_ID } }, 'audit example.com').skill, CONSULTANT_SKILL_ID);
  assert.equal(routeMessage({ message: { taskId: ID } }, 'example.com').skill, CONSULTANT_SKILL_ID);
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
const session = (over = {}) => ({ turns: 1, ended: null, lastReply: { turn: 1, text: 'The answer.' }, ...over });

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

/** A fake engine that records calls and answers reads from `state`. */
function fakeEngine(reading) {
  const calls = [];
  return {
    calls,
    engine: {
      start: async (text) => (calls.push(['start', text]), { workflowId: ID, accepted: true }),
      read: async (taskId) => {
        calls.push(['read', taskId]);
        if (taskId !== ID) throw Object.assign(new Error('missing'), { name: 'ConsultantNotFound' });
        return reading;
      },
      answer: async (...args) => calls.push(['answer', ...args]),
      decide: async (...args) => calls.push(['decide', ...args]),
      send: async (...args) => calls.push(['send', ...args]),
      close: async (...args) => calls.push(['close', ...args]),
    },
  };
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

test('a new session is charged before it starts, and a refusal starts nothing', async () => {
  const fake = fakeEngine(null);
  let charged = 0;
  const refused = await rpc(A2A_METHOD, message('hi', { metadata: { skill: CONSULTANT_SKILL_ID } }), {
    checkLimit: async () => (charged++, { allowed: false, scope: 'global', reason: 'this endpoint has run 20 consultant sessions today', retryAfterSeconds: 10 }),
    engine: fake.engine,
  });
  assert.equal(charged, 1);
  assert.equal(refused.payload.error.code, -32000);
  assert.equal(refused.payload.error.data[0].metadata.tier, 'session');
  assert.deepEqual(fake.calls, []);

  const ok = await rpc(A2A_METHOD, message('hi', { metadata: { skill: CONSULTANT_SKILL_ID } }), {
    checkLimit: async () => ({ allowed: true }),
    engine: fake.engine,
  });
  assert.equal(ok.payload.result.task.id, ID);
  assert.equal(ok.payload.result.task.status.state, 'TASK_STATE_WORKING');
  assert.deepEqual(fake.calls, [['start', 'hi']]);
});

test('a reply goes where the session is waiting, and is never charged', async () => {
  const reading = { execution: 'RUNNING', status: status({ turn_active: true, pending_callbacks: [{ tool_id: 't1', tool_input: { question: 'Which?' } }] }), session: session() };
  const fake = fakeEngine(reading);
  const consultant = { checkLimit: async () => assert.fail('a reply is not a new session'), engine: fake.engine };
  await rpc(A2A_METHOD, message('example.com', { taskId: ID }), consultant);
  assert.deepEqual(fake.calls.at(-1), ['answer', ID, 't1', 'example.com']);

  reading.status = status({ turn_active: true, pending_approvals: [{ tool_id: 't2', tool_input: { url: 'example.com' } }] });
  await rpc(A2A_METHOD, message('no', { taskId: ID }), consultant);
  assert.deepEqual(fake.calls.at(-1), ['decide', ID, 't2', false]);

  reading.status = status();
  await rpc(A2A_METHOD, message('What next?', { taskId: ID }), consultant);
  assert.deepEqual(fake.calls.at(-1), ['send', ID, 'What next?']);

  reading.status = status({ turn_active: true });
  const busy = await rpc(A2A_METHOD, message('hello?', { taskId: ID }), consultant);
  assert.equal(busy.payload.error.code, -32004);
  assert.deepEqual(fake.calls.at(-1), ['read', ID]);
});

test('GetTask and CancelTask refuse a foreign id before the engine is asked', async () => {
  const fake = fakeEngine(null);
  const consultant = { checkLimit: async () => ({ allowed: true }), engine: fake.engine };
  const missing = await rpc('GetTask', { id: consultantTaskIdFor('00000000-0000-4000-8000-000000000000') }, consultant);
  assert.equal(missing.payload.error.code, -32001);
  const malformed = await rpc('CancelTask', { id: 'a2a-consultant-nope' }, consultant);
  assert.equal(malformed.payload.error.code, -32001);
  const audit = await rpc('CancelTask', { id: 'steward-audit-example.com-deep-1a2b3c4d' }, consultant);
  assert.equal(audit.payload.error.code, -32002);
  const foreign = await rpc(A2A_METHOD, message('hi', { taskId: 'steward-audit-example.com-deep-1a2b3c4d', metadata: { skill: CONSULTANT_SKILL_ID } }), consultant);
  assert.equal(foreign.payload.error.code, -32001);
  assert.ok(fake.calls.every(([kind]) => kind === 'read'), 'only reads, and only of a well-formed id');
});

test('CancelTask sends close on an open session and answers in the legacy dialect when asked', async () => {
  const fake = fakeEngine({ execution: 'RUNNING', status: status(), session: session() });
  const result = await rpc('tasks/cancel', { id: ID }, { checkLimit: async () => ({ allowed: true }), engine: fake.engine });
  assert.equal(result.payload.result.status.state, 'canceled');
  assert.equal(result.payload.result.kind, 'task');
  assert.deepEqual(fake.calls.at(-1), ['close', ID]);
});

test('an unreachable consultant gets a fixed reply, and the error text stays in the log detail', async () => {
  const leak = new Error('Failed to connect to example-ns.zz99q.tmprl.example:7233 in namespace example-ns.zz99q');
  const failing = {
    start: async () => { throw leak; },
    read: async () => { throw leak; },
    close: async () => { throw leak; },
  };
  const consultant = { checkLimit: async () => ({ allowed: true }), engine: failing };
  const calls = [
    [A2A_METHOD, message('hi', { metadata: { skill: CONSULTANT_SKILL_ID } }), 'consultant-unavailable/start'],
    ['GetTask', { id: ID }, 'consultant-unavailable/read'],
    [A2A_METHOD, message('more', { taskId: ID }), 'consultant-unavailable/read'],
    ['CancelTask', { id: ID }, 'consultant-unavailable/read'],
  ];
  for (const [method, params, outcome] of calls) {
    const result = await rpc(method, params, consultant);
    const body = JSON.stringify(result.payload);
    assert.equal(result.outcome, outcome);
    assert.equal(result.payload.error.message, method === A2A_METHOD && !params.message.taskId ? UNAVAILABLE_TEXT : UNAVAILABLE_TASK_TEXT);
    assert.doesNotMatch(result.payload.error.message, /nothing was changed/i);
    assert.ok(!/zz99q|tmprl|7233|namespace/i.test(body), `${method}: ${body}`);
    assert.match(result.detail, /example-ns\.zz99q/, 'the detail keeps the cause for the log');
  }

  // A failed write after a good read: the same.
  const fake = fakeEngine({ execution: 'RUNNING', status: status(), session: session() });
  fake.engine.send = async () => { throw leak; };
  const send = await rpc(A2A_METHOD, message('more', { taskId: ID }), { checkLimit: async () => ({ allowed: true }), engine: fake.engine });
  assert.equal(send.outcome, 'consultant-unavailable/send');
  assert.equal(send.payload.error.message, UNAVAILABLE_TASK_TEXT, 'a send that may have landed says to poll first');
  assert.ok(!/zz99q|tmprl/.test(JSON.stringify(send.payload)));
});

test('no handler in the two new files puts an error\'s own text into a reply', () => {
  for (const file of ['src/lib/a2a-consultant-skill.mjs', 'src/lib/a2a-consultant-temporal.mjs']) {
    const source = read(file);
    const echoes = [...source.matchAll(/error\.message|err\.message/g)].length;
    // a2a-consultant-skill.mjs: once, into `detail`. a2a-consultant-temporal.mjs: once, into a
    // reading's `queryError`, which no reply reads.
    assert.equal(echoes, 1, file);
  }
  assert.doesNotMatch(read('src/lib/a2a-consultant-skill.mjs'), /queryError/);
});

test('without a Temporal connection the skill says it is not configured', async () => {
  const result = await rpc(A2A_METHOD, message('hi', { metadata: { skill: CONSULTANT_SKILL_ID } }), undefined);
  assert.equal(result.outcome, 'consultant-unavailable/not-configured');
});

test('the route charges the session tier and passes the client address it charges audits by', () => {
  const route = read('src/pages/a2a.ts');
  assert.match(route, /checkRateLimit\(\{ ip: clientIpFrom\(request\.headers\), tier: 'session' \}\)/);
  assert.match(route, /consultant: DEEP_ENABLED/);
});
