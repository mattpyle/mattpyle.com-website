/**
 * `draftFixLogEntry` and the checks of `checkEntry`, with an injected model: the rules
 * each failing alone, the bounded correction loop, the slug Steward derives and its
 * clash, and how the model client's errors reach Temporal. No network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { ApplicationFailure } from '@temporalio/activity';
import { FIX_LOG_MAX_ATTEMPTS, draftFixLogEntry, type DraftFixLogEntryInput } from '../../src/lib/fix-log-draft.js';
import { checkEntry, entryData, entryFileText, findingFacts } from '../../src/lib/fix-log-rules.js';
import { classifyModelError, fixLogSend } from '../../src/lib/llm.js';
import { GOOD, findingText, reply, scriptedModel } from './fix-log-fixtures.js';

function input(overrides: Partial<DraftFixLogEntryInput> = {}): DraftFixLogEntryInput {
  return {
    finding: { key: 'MP-950', text: findingText('MP-950') },
    pr: { number: 900, title: 'fix: about sections', body: 'Removes the stale section name.', diff: '--- src/pages/about.astro\n-old\n+new', opened: '2026-11-19T04:00:00Z', merged: '2026-11-19T05:00:00Z' },
    brief: '# Writing a fix log entry\n\nThe brief.',
    taken: { titles: [], slugs: [] },
    ...overrides,
  };
}

const lastUserTurn = (messages: Anthropic.MessageParam[]): string => String(messages[messages.length - 1].content);

test('a draft that passes first time returns the entry, its derived slug and the facts', async () => {
  const model = scriptedModel([reply(GOOD)]);
  const controller = new AbortController();
  const attempts: number[] = [];
  const out = await draftFixLogEntry(input(), { send: model.send, signal: controller.signal, onAttempt: (n) => attempts.push(n) });
  assert.equal(out.attempts, 1);
  assert.deepEqual(attempts, [1]);
  assert.equal(out.path, 'src/content/fixes/mp-950.md');
  assert.equal(out.slug, 'the-about-page-still-named-a-section-it-had-removed');
  assert.match(out.text, /^slug: the-about-page-still-named-a-section-it-had-removed$/m);
  assert.match(out.text, /^verified: '2026-11-20T10:00:00.000Z'$/m);
  assert.match(out.text, /merged: '2026-11-19T05:00:00Z'/);
  assert.match(out.text, /One of them had been removed\.\n$/);
  assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(model.calls[0].signal, controller.signal, 'the cancellation signal reaches the model call');
  assert.match(model.calls[0].system, /^# Writing a fix log entry/, 'the brief is the system prompt');
  assert.match(model.calls[0].system, /Do not return a slug/);
  assert.match(lastUserTurn(model.calls[0].messages), /Removes the stale section name/);
});

test('a finding not yet confirmed on production drafts an entry without verified or checks', async () => {
  const model = scriptedModel([reply(GOOD)]);
  const out = await draftFixLogEntry(
    input({ finding: { key: 'MP-950', text: findingText('MP-950', { status: 'fixing', verified: false }) }, pr: { ...input().pr, merged: null } }),
    { send: model.send },
  );
  assert.doesNotMatch(out.text, /verified:|merged:/);
  assert.match(out.text, /^checks: \[\]$/m);
});

test('a failing draft goes back with its reasons, and the corrected one passes', async () => {
  const model = scriptedModel([reply({ ...GOOD, lead: 'A reader looked for it. They found nothing.' }), reply(GOOD)]);
  const out = await draftFixLogEntry(input(), { send: model.send });
  assert.equal(out.attempts, 2);
  assert.deepEqual(out.usage, { inputTokens: 200, outputTokens: 40 });
  const second = model.calls[1].messages;
  assert.equal(second.length, 3, 'the first turn, the failed draft, the correction');
  assert.equal(second[1].role, 'assistant');
  assert.match(lastUserTurn(second), /lead-sentences: the lead is one sentence/);
});

test('a reply that is not JSON, or returns a slug, is corrected like any failure', async () => {
  const model = scriptedModel([{ text: 'Here is the entry.', usage: { inputTokens: 1, outputTokens: 1 } }, reply({ ...GOOD, slug: 'my-slug' }), reply(GOOD)]);
  const out = await draftFixLogEntry(input(), { send: model.send });
  assert.equal(out.attempts, 3);
  assert.match(lastUserTurn(model.calls[1].messages), /json: the reply is not one JSON object/);
  assert.match(lastUserTurn(model.calls[2].messages), /shape: .*slug|shape: \(reply\)/);
});

test('the last failure is a named, non-retryable error after the bounded attempts', async () => {
  const bad = reply({ ...GOOD, title: `The about page ${'x'.repeat(90)}` });
  const model = scriptedModel(Array.from({ length: FIX_LOG_MAX_ATTEMPTS }, () => bad));
  await assert.rejects(draftFixLogEntry(input(), { send: model.send }), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure);
    assert.equal(err.type, 'FixLogEntryInvalid');
    assert.equal(err.nonRetryable, true);
    assert.match(err.message, /title-length/);
    assert.deepEqual((err.details?.[0] as { usage: unknown }).usage, { inputTokens: 300, outputTokens: 60 });
    return true;
  });
  assert.equal(model.calls.length, FIX_LOG_MAX_ATTEMPTS);
});

test('a title whose slug another entry holds is sent back for a new title', async () => {
  const taken = { titles: ['Something else entirely about the page'], slugs: ['the-about-page-still-named-a-section-it-had-removed'] };
  const model = scriptedModel([reply(GOOD), reply({ ...GOOD, title: 'The about page named a section it no longer had' })]);
  const out = await draftFixLogEntry(input({ taken }), { send: model.send });
  assert.equal(out.attempts, 2);
  assert.equal(out.slug, 'the-about-page-named-a-section-it-no-longer-had');
  assert.match(lastUserTurn(model.calls[1].messages), /slug-taken: .*write a different title/);
  assert.match(lastUserTurn(model.calls[0].messages), /- Something else entirely about the page/, 'the model reads the titles taken');
});

test('a finding without a fix pull request, or with another one, is refused before any model call', async () => {
  const model = scriptedModel([]);
  await assert.rejects(draftFixLogEntry(input({ pr: { ...input().pr, number: 901 } }), { send: model.send }), /FindingNotInLog|#900, not #901/);
  const noPr = findingText('MP-950').replace(/^links:\n.*\n/m, 'links: {}\n');
  await assert.rejects(draftFixLogEntry(input({ finding: { key: 'MP-950', text: noPr } }), { send: model.send }), /no fix pull request/);
  assert.equal(model.calls.length, 0);
});

// ── Each check, failing alone ────────────────────────────────────────────────

function goodEntry(writing: Record<string, any> = {}): string {
  const facts = findingFacts(findingText('MP-950'));
  assert.ok(facts);
  const w: Record<string, any> = { ...GOOD, ...writing };
  const data = entryData(facts, input().pr, {
    title: w.title,
    lead: w.lead,
    visual: w.visual,
    ...(w.measures !== undefined ? { measures: w.measures } : w.measure ? { measures: [{ ...w.measure, quoted: false }] } : {}),
    ...(w.text ? { text: w.text } : {}),
    story: w.story,
  });
  return entryFileText(data, w.story);
}

const rules = (text: string, taken = { titles: [] as string[], slugs: [] as string[] }) =>
  checkEntry(text, taken, { newEntry: true }).map((f) => f.rule);

test('the good entry passes every check', () => {
  assert.deepEqual(rules(goodEntry()), []);
});

test('each rule fails alone', () => {
  const lines = { kind: 'lines', label: 'about', lines: [{ text: 'old' }] };
  const cases: Array<[string, string]> = [
    ['forbidden', goodEntry({ story: 'See the preview at x.vercel.app for it.' })],
    ['title-length', goodEntry({ title: `The about page ${'a'.repeat(80)}` })],
    ['title-form', goodEntry({ title: 'Did the about page name a removed section?' })],
    ['title-taken', ''],
    ['slug-length', goodEntry({ title: 'The about page named a section it had removed from its own layout last week' })],
    ['slug-taken', ''],
    ['lead-length', goodEntry({ lead: Array.from({ length: 26 }, () => 'word').join(' ') })],
    ['lead-sentences', goodEntry({ lead: 'It failed. It is fixed.' })],
    ['em-dash', goodEntry({ story: 'The page named three sections — one was gone.' })],
    ['story', goodEntry({ story: ' ' })],
    ['story-tag', goodEntry({ story: 'The page had a <main> without a heading.' })],
    ['one-measure', goodEntry({ measures: [GOOD.measure, GOOD.measure].map((m) => ({ ...m, quoted: false })) })],
    ['one-form', goodEntry({ measure: undefined, text: { before: lines, after: lines } , measures: [{ ...GOOD.measure, quoted: false }] })],
    ['measure-label', goodEntry({ measure: { ...GOOD.measure, label: 'Copies of the old line' } })],
  ];
  for (const [rule, text] of cases) {
    if (rule === 'title-taken') {
      assert.ok(rules(goodEntry(), { titles: [GOOD.title.toUpperCase()], slugs: [] }).includes('title-taken'), rule);
      continue;
    }
    if (rule === 'slug-taken') {
      assert.deepEqual(rules(goodEntry(), { titles: [], slugs: ['the-about-page-still-named-a-section-it-had-removed'] }), ['slug-taken'], rule);
      continue;
    }
    const got = rules(text);
    assert.ok(got.includes(rule), `${rule}: got ${got.join(', ') || 'no failure'}`);
    // A title over its bound always makes a slug over its bound too.
    const alongside = rule === 'title-length' ? ['schema', 'slug-length'] : ['schema'];
    assert.ok(got.every((r) => r === rule || alongside.includes(r)), `${rule} fails alone, with the schema at most: ${got.join(', ')}`);
  }
  assert.ok(rules(goodEntry({ measure: undefined })).includes('one-form'), 'neither measures nor text');
  assert.ok(rules(goodEntry().replace('type: content', 'type: nonsense')).includes('schema'), 'the schema');
  assert.ok(rules(goodEntry().replace(/^slug: .*$/m, 'slug: a-hand-set-slug')).includes('slug-derived'), 'a new entry takes the derived slug');
});

// ── The model client ────────────────────────────────────────────────────────

test('the model client refuses at once without a key', async () => {
  // The test process blanks ANTHROPIC_API_KEY (tests/helpers/no-real-credentials.ts).
  await assert.rejects(fixLogSend('claude-opus-5-5')('system', [{ role: 'user', content: 'x' }]), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure);
    assert.equal(err.type, 'ModelKeyMissing');
    assert.equal(err.nonRetryable, true);
    return true;
  });
});

test('a refused request is non-retryable; a rate limit, an overload and a 5xx are retryable; an abort passes through', () => {
  const apiError = (status: number) => new Anthropic.APIError(status, undefined, `status ${status}`, new Headers());
  for (const status of [400, 401, 403, 404]) {
    const failure = classifyModelError(apiError(status));
    assert.ok(failure instanceof ApplicationFailure && failure.nonRetryable === true && failure.type === 'ModelRequestRefused', String(status));
  }
  for (const status of [429, 500, 529]) {
    const failure = classifyModelError(apiError(status));
    assert.ok(failure instanceof ApplicationFailure && failure.nonRetryable === false && failure.type === 'ModelUnavailable', String(status));
  }
  const abort = new Anthropic.APIUserAbortError();
  assert.equal(classifyModelError(abort), abort);
  const other = new Error('socket hang up');
  assert.equal(classifyModelError(other), other);
});
