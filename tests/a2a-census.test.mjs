import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  A2A_ENDPOINT_PATH,
  A2A_METHODS_COUNTED,
  A2A_METHOD_VALUES,
  A2A_SKILL_VALUES,
  A2A_SKILLS_COUNTED,
  A2A_TIER_VALUES,
  OTHER_A2A_METHOD,
  UNPARSED_A2A_METHOD,
  a2aCensusKeys,
  a2aFactsFrom,
  a2aKeyFor,
  counterPath,
  parseA2aField,
  recordA2aRequest,
} from '../src/lib/agent-hits.mjs';
import { bucketHour, flattenA2aHashes, summarizeA2a } from '../src/lib/agent-traffic.mjs';
import { A2A_METHODS_LEGEND, A2A_SKILLS_LEGEND, buildActivity } from '../src/lib/activity-summary.mjs';
import { A2A_METHOD, CANCEL_TASK_METHOD, GET_TASK_METHOD, LEGACY_CANCEL_TASK_METHODS, LEGACY_METHODS } from '../src/lib/a2a-responder.mjs';
import {
  ASK_SKILL_ID,
  AUDIT_SKILL_ID,
  CONSULTANT_SKILL_ID,
  LEGACY_GET_TASK_METHODS,
  SKILL_IDS,
  routeMessage,
} from '../src/lib/a2a-audit-skill.mjs';
import { readText } from '../src/lib/a2a-rpc.mjs';

// The A2A census: every POST to /a2a counted by JSON-RPC method, by the skill it routed to and by
// the audit tier it asked for. The store is a fake that records what it was asked.

const AT = new Date('2026-11-12T20:00:00Z');
const NOW = new Date('2026-11-12T20:30:00Z');
const KEY = 'hits:v2:a2a:2026-11-12';

const STORE_ENV = {
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

// The router the route passes, rebuilt here from the same two functions.
const routeFor = (params) => {
  const text = readText(params.message);
  return text === null ? null : routeMessage(params, text);
};

const send = (text, extra = {}, method = A2A_METHOD) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params: { message: { role: 'ROLE_USER', messageId: 'm1', parts: [{ text }] }, ...extra },
});

const routeSource = readFileSync(fileURLToPath(new URL('../src/pages/a2a.ts', import.meta.url)), 'utf8');
const middlewareSource = readFileSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)), 'utf8');
const bodySource = readFileSync(
  fileURLToPath(new URL('../src/components/activity/ActivityBody.astro', import.meta.url)),
  'utf8'
);
const jsonSource = readFileSync(fileURLToPath(new URL('../src/pages/activity.json.ts', import.meta.url)), 'utf8');
const markdownSource = readFileSync(fileURLToPath(new URL('../src/pages/activity.md.ts', import.meta.url)), 'utf8');

// --- the fixed lists --------------------------------------------------------------------------

test('the census lists are the responder and the audit skill lists, held equal', () => {
  assert.deepEqual([...A2A_METHODS_COUNTED], [A2A_METHOD, GET_TASK_METHOD, CANCEL_TASK_METHOD]);
  assert.deepEqual([...A2A_SKILLS_COUNTED], [...SKILL_IDS]);
  assert.deepEqual([...A2A_SKILLS_COUNTED], [ASK_SKILL_ID, AUDIT_SKILL_ID, CONSULTANT_SKILL_ID]);
  // The legacy spellings fold into their 1.0 name.
  assert.equal(a2aFactsFrom({ jsonrpc: '2.0', id: 1, method: LEGACY_METHODS[0] }, routeFor).method, A2A_METHOD);
  assert.equal(a2aFactsFrom({ jsonrpc: '2.0', id: 1, method: LEGACY_GET_TASK_METHODS[0] }, routeFor).method, GET_TASK_METHOD);
  assert.equal(a2aFactsFrom({ jsonrpc: '2.0', id: 1, method: LEGACY_CANCEL_TASK_METHODS[0] }, routeFor).method, CANCEL_TASK_METHOD);
});

// --- the facts a body gives -------------------------------------------------------------------

test('a SendMessage is counted under the skill it routes to', () => {
  assert.deepEqual(a2aFactsFrom(send('What is this site about?'), routeFor), {
    method: 'SendMessage',
    skill: ASK_SKILL_ID,
    tier: 'none',
  });
  assert.deepEqual(a2aFactsFrom(send('Run a quick audit of example.com'), routeFor), {
    method: 'SendMessage',
    skill: AUDIT_SKILL_ID,
    tier: 'fast',
  });
  assert.deepEqual(a2aFactsFrom(send('Run a deep audit of example.com'), routeFor), {
    method: 'SendMessage',
    skill: AUDIT_SKILL_ID,
    tier: 'deep',
  });
});

test('metadata can name the skill and the tier, and the legacy spelling counts as SendMessage', () => {
  const named = send('hello', { metadata: { skill: AUDIT_SKILL_ID, tier: 'deep', target: 'example.com' } }, 'message/send');
  assert.deepEqual(a2aFactsFrom(named, routeFor), { method: 'SendMessage', skill: AUDIT_SKILL_ID, tier: 'deep' });
});

test('a message to the consultant counts under its skill, by name or by its task id', () => {
  const named = send('Can you check my site?', { metadata: { skill: CONSULTANT_SKILL_ID } });
  assert.deepEqual(a2aFactsFrom(named, routeFor), { method: 'SendMessage', skill: CONSULTANT_SKILL_ID, tier: 'none' });
  const reply = send('example.com');
  reply.params.message.taskId = 'a2a-consultant-00000000-0000-4000-8000-000000000000';
  assert.deepEqual(a2aFactsFrom(reply, routeFor), { method: 'SendMessage', skill: CONSULTANT_SKILL_ID, tier: 'none' });
  const cancel = { jsonrpc: '2.0', id: 3, method: 'CancelTask', params: { id: 'a2a-consultant-x' } };
  assert.deepEqual(a2aFactsFrom(cancel, routeFor), { method: 'CancelTask', skill: 'none', tier: 'none' });
});

test('a GetTask has no skill and no tier', () => {
  const body = { jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: 'task-123' } };
  assert.deepEqual(a2aFactsFrom(body, routeFor), { method: 'GetTask', skill: 'none', tier: 'none' });
});

test('a body that did not parse is unparsed, apart from a method the endpoint lacks', () => {
  assert.equal(a2aFactsFrom(undefined, routeFor).method, UNPARSED_A2A_METHOD);
  for (const body of [
    { jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage' },
    { jsonrpc: '2.0', id: 1, method: 'SubscribeToTask' },
    { jsonrpc: '2.0', id: 1, method: 7 },
    { jsonrpc: '2.0', id: 1 },
    [send('hi')],
    'nonsense',
    42,
    null,
  ]) {
    assert.equal(a2aFactsFrom(body, routeFor).method, OTHER_A2A_METHOD, JSON.stringify(body));
  }
  assert.notEqual(UNPARSED_A2A_METHOD, OTHER_A2A_METHOD);
});

test('a SendMessage with no text, no params or the wrong params routes to none', () => {
  for (const params of [undefined, null, [], 'x', {}, { message: { parts: [] } }, { message: { parts: [{ text: '  ' }] } }]) {
    const facts = a2aFactsFrom({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params }, routeFor);
    assert.deepEqual(facts, { method: 'SendMessage', skill: 'none', tier: 'none' }, JSON.stringify(params));
  }
});

test('a router that throws leaves skill and tier at none, and the method still counts', () => {
  const throwing = () => {
    throw new Error('boom');
  };
  assert.deepEqual(a2aFactsFrom(send('hi'), throwing), { method: 'SendMessage', skill: 'none', tier: 'none' });
});

test('a router that answers outside the fixed lists is not believed', () => {
  const hostile = () => ({ skill: 'x|y\nz', tier: 'deep' });
  assert.deepEqual(a2aFactsFrom(send('hi'), hostile), { method: 'SendMessage', skill: 'none', tier: 'none' });
  const badTier = () => ({ skill: AUDIT_SKILL_ID, tier: 'ultra' });
  assert.deepEqual(a2aFactsFrom(send('hi'), badTier), { method: 'SendMessage', skill: AUDIT_SKILL_ID, tier: 'none' });
});

test('nothing a caller sends reaches a stored field: no text, host, id or metadata', () => {
  const secret = 'SECRET-TEXT-example-target.test-task-9f3';
  const body = send(`Run a deep audit of ${secret}.test`, {
    contextId: secret,
    taskId: secret,
    metadata: { skill: AUDIT_SKILL_ID, tier: 'deep', target: `${secret}.test`, note: secret },
  });
  const facts = a2aFactsFrom(body, routeFor);
  assert.ok(!JSON.stringify(facts).includes('SECRET'));
  const keys = a2aCensusKeys(facts, AT);
  assert.ok(!JSON.stringify(keys).includes('SECRET'));
  assert.deepEqual(Object.keys(facts).sort(), ['method', 'skill', 'tier']);
});

// --- the key and the fields -------------------------------------------------------------------

test('the key is one hash per UTC day, beside the v2 family', () => {
  assert.equal(a2aKeyFor('2026-11-12'), KEY);
  assert.equal(a2aKeyFor('2026-11-12', 'v1'), 'hits:v1:a2a:2026-11-12');
});

test('one POST writes three fields and the day set entry, and nothing else', () => {
  const { fields, commands } = a2aCensusKeys({ method: 'SendMessage', skill: AUDIT_SKILL_ID, tier: 'deep' }, AT);
  assert.deepEqual(fields, ['20|method|SendMessage', `20|skill|${AUDIT_SKILL_ID}`, '20|tier|deep']);
  assert.deepEqual(commands, [
    ['HINCRBY', KEY, '20|method|SendMessage', '1'],
    ['HINCRBY', KEY, `20|skill|${AUDIT_SKILL_ID}`, '1'],
    ['HINCRBY', KEY, '20|tier|deep', '1'],
    ['SADD', 'hits:v2:days', '2026-11-12'],
  ]);
});

test('every field the writer can make parses back, and a field off the lists does not', () => {
  for (const method of A2A_METHOD_VALUES) assert.deepEqual(parseA2aField(`07|method|${method}`), { hour: '07', kind: 'method', value: method });
  for (const skill of A2A_SKILL_VALUES) assert.equal(parseA2aField(`07|skill|${skill}`)?.value, skill);
  for (const tier of A2A_TIER_VALUES) assert.equal(parseA2aField(`07|tier|${tier}`)?.value, tier);
  for (const field of ['07|method|Tools/Call', '07|tier|ultra', '07|skill|', '7|method|SendMessage', '07|client|x', '07|method|SendMessage|x', 'junk', '']) {
    assert.equal(parseA2aField(field), null, field);
  }
});

// --- the write --------------------------------------------------------------------------------

test('recordA2aRequest sends one pipeline and reports the fields', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };
  const result = await recordA2aRequest({ facts: { method: 'GetTask', skill: 'none', tier: 'none' }, now: AT, env: STORE_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 4);
});

test('no store means no network call', async () => {
  let called = false;
  const result = await recordA2aRequest({
    facts: { method: 'GetTask', skill: 'none', tier: 'none' },
    env: {},
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'no-store' });
  assert.equal(called, false);
});

test('a store that throws, answers 500 or hangs up never rejects', async () => {
  const facts = { method: 'SendMessage', skill: ASK_SKILL_ID, tier: 'none' };
  const thrown = await recordA2aRequest({ facts, env: STORE_ENV, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(thrown.ok, false);
  const failed = await recordA2aRequest({ facts, env: STORE_ENV, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual(failed.reason, 'status-500');
});

test('facts off the fixed lists are refused before any write', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200 };
  };
  for (const facts of [
    { method: 'Tools/Call', skill: 'none', tier: 'none' },
    { method: 'SendMessage', skill: 'evil|field', tier: 'none' },
    { method: 'SendMessage', skill: 'none', tier: 'ultra' },
    undefined,
  ]) {
    assert.deepEqual(await recordA2aRequest({ facts, env: STORE_ENV, fetchImpl }), { ok: false, reason: 'unlisted-fact' });
  }
  assert.equal(called, false);
});

// --- the read ---------------------------------------------------------------------------------

function census(hoursAgo, fields) {
  const at = new Date(NOW.getTime() - hoursAgo * 3_600_000);
  return { day: at.toISOString().slice(0, 10), fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${at.toISOString().slice(11, 13)}|${k}`, String(v)])) };
}

test('the summary has a row for every fixed value, zeros included, in list order', () => {
  const empty = summarizeA2a([], NOW);
  assert.deepEqual(empty.methods.rows.map((row) => row.value), [...A2A_METHOD_VALUES]);
  assert.deepEqual(empty.skills.rows.map((row) => row.value), [...A2A_SKILL_VALUES]);
  assert.deepEqual(empty.tiers.rows.map((row) => row.value), [...A2A_TIER_VALUES]);
  assert.ok(empty.methods.rows.every((row) => row.week === 0 && row.month === 0));
});

test('counts land in the windows they belong to', () => {
  const rows = flattenA2aHashes([
    census(1, { 'method|SendMessage': 3, 'tier|deep': 1 }),
    census(30, { 'method|SendMessage': 2 }),
    census(400, { 'method|SendMessage': 5 }),
    census(1, { 'method|Bogus': 9, 'skill|': 9 }),
  ]);
  const summary = summarizeA2a(rows, NOW);
  const send_ = summary.methods.rows.find((row) => row.value === 'SendMessage');
  assert.equal(send_.day, 3);
  assert.equal(send_.week, 5);
  assert.equal(send_.month, 10);
  assert.equal(summary.tiers.rows.find((row) => row.value === 'deep').week, 1);
  assert.equal(summary.methods.rows.some((row) => row.value === 'Bogus'), false);
});

test('the census counts nothing twice: it leaves the headline totals where they were', () => {
  const traffic = [{ hour: bucketHour('2026-11-12', '20'), event: 'surface', family: 'curl', path: '/a2a', verification: '', count: 5 }];
  const a2a = flattenA2aHashes([{ day: '2026-11-12', fields: { '20|method|SendMessage': '5' } }]);
  assert.deepEqual(buildActivity(traffic, NOW, { a2a }).totals, buildActivity(traffic, NOW).totals);
  assert.equal(buildActivity(traffic, NOW).a2a.methods.rows.length, A2A_METHOD_VALUES.length);
});

test('/a2a is a named surface, not a bucket', () => {
  assert.equal(A2A_ENDPOINT_PATH, '/a2a');
  assert.equal(counterPath('surface', '/a2a'), '/a2a');
  assert.equal(counterPath('surface', '/a2a/'), '/a2a');
  assert.equal(counterPath('surface', '/a2a/other'), '/*');
});

// --- the wiring -------------------------------------------------------------------------------

test('the route counts every POST before the responder runs, and through waitUntil', () => {
  const counted = routeSource.indexOf('countRequest(request, parsed)');
  const responded = routeSource.indexOf('await respond(');
  assert.ok(counted > 0);
  assert.ok(counted < responded, 'the count runs before the responder, so a throwing responder is still counted');
  assert.match(routeSource, /waitUntil\(recordA2aRequest\(\{ facts: a2aFactsFrom\(body, routeFor\) \}\)\)/);
  assert.match(routeSource, /waitUntil\(recordHit\(\{ event: 'surface', path: A2A_ENDPOINT_PATH/);
  assert.equal(routeSource.match(/countRequest\(request,/g).length, 1, 'one call site, in POST');
});

test('the count is its own failure domain and never awaited in front of the response', () => {
  const fn = routeSource.slice(routeSource.indexOf('function countRequest'), routeSource.indexOf('export const POST'));
  assert.match(fn, /try \{/);
  assert.match(fn, /catch \{/);
  assert.ok(!/await /.test(fn), 'no await inside the counting function');
});

test('a GET is not counted', () => {
  const get = routeSource.slice(routeSource.indexOf('export const GET'));
  assert.ok(!/countRequest|recordHit|recordA2aRequest/.test(get));
});

test('the middleware matcher still leaves /a2a out', () => {
  const matcher = middlewareSource.slice(middlewareSource.indexOf('export const config'));
  assert.ok(!matcher.includes('a2a'), 'a slash rule reaching /a2a would 308 a JSON-RPC POST');
});

test('the three renders carry the A2A legends and read the same rows', () => {
  for (const source of [bodySource, jsonSource, markdownSource]) {
    assert.match(source, /A2A_METHODS_LEGEND/);
    assert.match(source, /A2A_SKILLS_LEGEND/);
    assert.match(source, /activity\.a2a/);
  }
  assert.match(jsonSource, /A2A_COUNTS_NOTE/);
  assert.match(A2A_METHODS_LEGEND, /unparsed/);
  assert.match(A2A_SKILLS_LEGEND, /costly path/);
});
