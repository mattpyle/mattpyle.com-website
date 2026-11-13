/**
 * The agent end to end on a local dev server, with a scripted model and a stub site: the model's
 * path, the approval gate, the deep audit's retry, the injection boundary, and every cap.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ConsultantSession } from '../scripts/session.js';
import { TASK_QUEUE, caller, startHarness, workflowId, type Harness } from './helpers/env.js';
import { MARKER, hostileReport } from './helpers/reports.js';
import { DEFAULT_CAPS } from '../src/caps.js';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.stop();
});
beforeEach(() => h.reset());

const open = (name: string) => ConsultantSession.start(h.env.client, TASK_QUEUE, workflowId(name));

/** Waits until `check` passes or `ms` runs out. */
async function eventually(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('condition not met in time');
}

test('the model asks which site, audits it, and answers', async () => {
  h.script.set([
    { tool: 'ask_user', input: { question: 'Which site should I audit?' } },
    { tool: 'audit_site', input: { url: 'example.com' } },
    { text: 'Publish llms.txt first.' },
  ]);
  const s = await open('ask');
  const turn = await s.ask('Can you check my site?', caller('example.com'));
  assert.deepEqual(turn.questions, ['Which site should I audit?']);
  assert.equal(turn.reply, 'Publish llms.txt first.');
  assert.deepEqual(h.site.calls, ['fast https://example.com']);
  const counts = await s.session();
  assert.equal(counts.turns, 1);
  assert.equal(counts.ended, null);
});

test('a model that answers without a tool makes no site call', async () => {
  h.script.set([{ text: 'llms.txt lists your pages for agents.' }]);
  const s = await open('notool');
  const turn = await s.ask('What does llms.txt do?', caller());
  assert.equal(turn.reply, 'llms.txt lists your pages for agents.');
  assert.deepEqual(h.site.calls, []);
});

test('no string from the audited site reaches the model', async () => {
  h.site.fast = { ok: true, data: hostileReport() };
  h.script.set([{ tool: 'audit_site', input: { url: 'example.com' } }, { text: 'Done.' }]);
  const s = await open('inject');
  await s.ask('Audit example.com', caller());
  assert.equal(h.script.calls, 2);
  const secondCall = h.script.seen[1]!;
  assert.ok(secondCall.includes('llms-txt'), 'the projected checks reached the model');
  assert.ok(!secondCall.includes(MARKER), 'no injected text reached the model');
});

test('a deep audit waits for the caller, and runs once approved', async () => {
  h.script.set([{ tool: 'deep_audit', input: { url: 'example.com' } }, { text: 'Deep result read.' }]);
  const s = await open('deep');
  const turn = await s.ask('Run a deep audit of example.com', caller('example.com', true));
  assert.deepEqual(turn.approvals, ['deep_audit']);
  assert.deepEqual(h.site.calls, ['start https://example.com', 'read status', 'read report']);
  assert.ok(h.script.seen[1]!.includes('"tier":"deep"') || h.script.seen[1]!.includes('\\"tier\\":\\"deep\\"'));
});

test('a declined deep audit starts nothing', async () => {
  h.script.set([{ tool: 'deep_audit', input: { url: 'example.com' } }, { text: 'Understood.' }]);
  const s = await open('decline');
  const turn = await s.ask('Run a deep audit of example.com', caller('example.com', false));
  assert.deepEqual(turn.approvals, ['deep_audit']);
  assert.deepEqual(h.site.calls, []);
});

test('a deep-audit start that fails after starting is retried without a second start', async () => {
  const real = h.activities.consultantStartDeepAudit;
  let attempts = 0;
  h.activities.consultantStartDeepAudit = async (input) => {
    attempts += 1;
    const result = await real(input);
    if (attempts === 1) throw new Error('the worker died after the start');
    return result;
  };
  h.script.set([{ tool: 'deep_audit', input: { url: 'example.com' } }, { text: 'Read it.' }]);
  const s = await open('deepretry');
  await s.ask('Run a deep audit of example.com', caller('example.com', true));
  assert.equal(attempts, 2, 'the start activity ran twice');
  assert.equal(h.site.calls.filter((c) => c.startsWith('start')).length, 1, 'one deep audit started');
  assert.ok(h.site.calls.includes('read report'));
});

test('a second deep audit in one session is refused by the cap', async () => {
  h.script.set([
    { tool: 'deep_audit', input: { url: 'example.com' } },
    { tool: 'deep_audit', input: { url: 'example.org' } },
    { text: 'One was enough.' },
  ]);
  const s = await open('deepcap');
  await s.ask('Deep audit both sites', caller('x', true));
  assert.equal(h.site.calls.filter((c) => c.startsWith('start')).length, 1);
  assert.ok(h.script.seen[2]!.includes('cap:deep_audits'));
});

test('the turn cap ends the session with a reason the caller can read', async () => {
  h.reset({ turns: 2, closeGraceSeconds: 1 });
  h.script.set([{ text: 'One.' }, { text: 'Two.' }]);
  const s = await open('turns');
  await s.ask('first', caller());
  assert.equal((await s.session()).ended, null);
  const second = await s.ask('second', caller());
  assert.equal(second.reply, 'Two.');
  assert.deepEqual((await s.session()).ended, { reason: 'cap:turns', turn: 2 });
  await eventually(async () => (await s.status()).close_reason === 'requested');
});

test('the tool-call cap stops a turn and ends the session', async () => {
  h.reset({ toolCallsPerTurn: 2, closeGraceSeconds: 1 });
  h.script.set(Array.from({ length: 10 }, () => ({ tool: 'audit_site', input: { url: 'example.com' } })));
  const s = await open('toolcalls');
  await s.ask('Audit forever', caller());
  assert.equal(h.script.calls, 3, 'the model got toolCallsPerTurn + 1 calls');
  assert.equal(h.site.calls.length, 2, 'the third tool call was refused');
  assert.equal((await s.session()).ended?.reason, 'cap:tool_calls');
});

test('the token cap ends the session', async () => {
  h.reset({ tokens: 200, closeGraceSeconds: 1 });
  h.script.set([{ text: 'Long answer.', usage: { inputTokens: 150, outputTokens: 60 } }]);
  const s = await open('tokens');
  await s.ask('Tell me everything', caller());
  const counts = await s.session();
  assert.equal(counts.totalTokens, 210);
  assert.equal(counts.ended?.reason, 'cap:tokens');
});

test('the lifetime cap closes an idle session', async () => {
  h.reset({ lifetimeSeconds: 2, closeGraceSeconds: 1 });
  h.script.set([{ text: 'Hello.' }]);
  const s = await open('lifetime');
  await s.ask('hi', caller());
  await eventually(async () => (await s.session()).ended?.reason === 'cap:lifetime');
  await eventually(async () => (await s.status()).close_reason === 'requested');
});

test('usage is counted once per model call across turns', async () => {
  h.script.set([{ text: 'One.' }, { text: 'Two.' }]);
  const s = await open('usage');
  await s.ask('first', caller());
  await s.ask('second', caller());
  const counts = await s.session();
  assert.equal(counts.totalTokens, 240, 'two calls of 120 tokens, not a running total added twice');
  assert.equal(counts.outputTokens, 40);
});

test('an answer that hits the output limit is rolled back, and the next turn works', async () => {
  h.script.set([
    { text: 'A very long answer that never ends', stopReason: 'maxTokens' },
    { text: 'Short answer.' },
  ]);
  const s = await open('maxtokens');
  const first = await s.ask('Write me a novel', caller());
  assert.match(first.reply, /ran past its length limit/);
  const second = await s.ask('Just one line, then', caller());
  assert.equal(second.reply, 'Short answer.');
  assert.ok(!h.script.seen[1]!.includes('never ends'), 'the half-written answer was rolled back');
  const counts = await s.session();
  assert.equal(counts.unmeteredTokens, DEFAULT_CAPS.maxOutputTokens);
  assert.equal(counts.ended, null);
});

test('consultant_session carries the latest answer, and a cap does not overwrite it', async () => {
  h.reset({ turns: 2, closeGraceSeconds: 5 });
  h.script.set([{ text: 'One.' }, { text: 'Two.' }]);
  const s = await open('lastreply');
  assert.equal((await s.session()).lastReply, null);
  await s.ask('first', caller());
  assert.deepEqual((await s.session()).lastReply, { turn: 1, text: 'One.' });
  await s.ask('second', caller());
  assert.deepEqual((await s.session()).lastReply, { turn: 2, text: 'Two.' });
  const ended = await s.ask('third', caller());
  assert.match(ended.reply, /This session has ended \(cap:turns\)/);
  assert.deepEqual((await s.session()).lastReply, { turn: 2, text: 'Two.' });
});
