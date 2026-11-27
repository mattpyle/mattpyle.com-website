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
import { bareStoryPaths, checkEntry, entryData, entryFileText, findingFacts } from '../../src/lib/fix-log-rules.js';
import { classifyModelError, fixLogSend } from '../../src/lib/llm.js';
import { GOOD, acceptingReviewer, findingText, problems, reply, scriptedModel } from './fix-log-fixtures.js';

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
  const reviewer = acceptingReviewer();
  const out = await draftFixLogEntry(input(), { send: model.send, review: reviewer.send, signal: controller.signal, onAttempt: (n) => attempts.push(n) });
  assert.equal(out.attempts, 1);
  assert.deepEqual(attempts, [1]);
  assert.equal(out.path, 'src/content/fixes/mp-950.md');
  assert.equal(out.slug, 'the-about-page-still-named-a-section-it-had-removed');
  assert.match(out.text, /^slug: the-about-page-still-named-a-section-it-had-removed$/m);
  assert.match(out.text, /^verified: '2026-11-20T10:00:00.000Z'$/m);
  assert.match(out.text, /merged: '2026-11-19T05:00:00Z'/);
  assert.match(out.text, /One of them had been removed\.\n$/);
  assert.deepEqual(out.usage, { writer: { inputTokens: 100, outputTokens: 20 }, reviewer: { inputTokens: 50, outputTokens: 5 } });
  assert.equal(out.reviewRounds, 1);
  assert.deepEqual(out.reviewNotes, []);
  assert.equal(reviewer.calls.length, 1);
  assert.equal(model.calls[0].signal, controller.signal, 'the cancellation signal reaches the model call');
  assert.match(model.calls[0].system, /^# Writing a fix log entry/, 'the brief is the system prompt');
  assert.match(model.calls[0].system, /Do not return a slug/);
  assert.match(lastUserTurn(model.calls[0].messages), /Removes the stale section name/);
});

test('a finding not yet confirmed on production drafts an entry without verified or checks', async () => {
  const model = scriptedModel([reply(GOOD)]);
  const out = await draftFixLogEntry(
    input({ finding: { key: 'MP-950', text: findingText('MP-950', { status: 'fixing', verified: false }) }, pr: { ...input().pr, merged: null } }),
    { send: model.send, review: acceptingReviewer().send },
  );
  assert.doesNotMatch(out.text, /verified:|merged:/);
  assert.match(out.text, /^checks: \[\]$/m);
});

test('a failing draft goes back with its reasons, and the corrected one passes', async () => {
  const model = scriptedModel([reply({ ...GOOD, lead: 'A reader looked for it. They found nothing.' }), reply(GOOD)]);
  const out = await draftFixLogEntry(input(), { send: model.send, review: acceptingReviewer().send });
  assert.equal(out.attempts, 2);
  assert.deepEqual(out.usage.writer, { inputTokens: 200, outputTokens: 40 });
  const second = model.calls[1].messages;
  assert.equal(second.length, 3, 'the first turn, the failed draft, the correction');
  assert.equal(second[1].role, 'assistant');
  assert.match(lastUserTurn(second), /lead-sentences: the lead is one sentence/);
});

test('a reply that is not JSON, or returns a slug, is corrected like any failure', async () => {
  const model = scriptedModel([{ text: 'Here is the entry.', usage: { inputTokens: 1, outputTokens: 1 } }, reply({ ...GOOD, slug: 'my-slug' }), reply(GOOD)]);
  const out = await draftFixLogEntry(input(), { send: model.send, review: acceptingReviewer().send });
  assert.equal(out.attempts, 3);
  assert.match(lastUserTurn(model.calls[1].messages), /json: the reply is not one JSON object/);
  assert.match(lastUserTurn(model.calls[2].messages), /shape: .*slug|shape: \(reply\)/);
});

test('the last failure is a named, non-retryable error after the bounded attempts', async () => {
  const bad = reply({ ...GOOD, title: `The about page ${'x'.repeat(90)}` });
  const model = scriptedModel(Array.from({ length: FIX_LOG_MAX_ATTEMPTS }, () => bad));
  await assert.rejects(draftFixLogEntry(input(), { send: model.send, review: acceptingReviewer().send }), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure);
    assert.equal(err.type, 'FixLogEntryInvalid');
    assert.equal(err.nonRetryable, true);
    assert.match(err.message, /title-length/);
    assert.deepEqual((err.details?.[0] as { usage: unknown }).usage, { writer: { inputTokens: 300, outputTokens: 60 }, reviewer: { inputTokens: 0, outputTokens: 0 } });
    return true;
  });
  assert.equal(model.calls.length, FIX_LOG_MAX_ATTEMPTS);
});

test('a title whose slug another entry holds is sent back for a new title', async () => {
  const taken = { titles: ['Something else entirely about the page'], slugs: ['the-about-page-still-named-a-section-it-had-removed'] };
  const model = scriptedModel([reply(GOOD), reply({ ...GOOD, title: 'The about page named a section it no longer had' })]);
  const out = await draftFixLogEntry(input({ taken }), { send: model.send, review: acceptingReviewer().send });
  assert.equal(out.attempts, 2);
  assert.equal(out.slug, 'the-about-page-named-a-section-it-no-longer-had');
  assert.match(lastUserTurn(model.calls[1].messages), /slug-taken: .*write a different title/);
  assert.match(lastUserTurn(model.calls[0].messages), /- Something else entirely about the page/, 'the model reads the titles taken');
});

test('a finding without a fix pull request, or with another one, is refused before any model call', async () => {
  const model = scriptedModel([]);
  await assert.rejects(draftFixLogEntry(input({ pr: { ...input().pr, number: 901 } }), { send: model.send, review: acceptingReviewer().send }), /FindingNotInLog|#900, not #901/);
  const noPr = findingText('MP-950').replace(/^links:\n.*\n/m, 'links: {}\n');
  await assert.rejects(draftFixLogEntry(input({ finding: { key: 'MP-950', text: noPr } }), { send: model.send, review: acceptingReviewer().send }), /no fix pull request/);
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
    ['story-path', goodEntry({ story: 'The page at /about named three sections.' })],
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

// ── The review pass ─────────────────────────────────────────────────────────

const TODAY = '2026-11-27T09:00:00Z';

test('an accepted draft: the reviewer reads the sources, the facts as true and the writer fields, not the writer conversation', async () => {
  const model = scriptedModel([reply({ ...GOOD, lead: 'It failed. It is fixed.' }), reply(GOOD)]);
  const reviewer = acceptingReviewer();
  const rounds: number[] = [];
  const out = await draftFixLogEntry(input({ today: TODAY }), { send: model.send, review: reviewer.send, onReview: (n) => rounds.push(n) });
  assert.equal(out.reviewRounds, 1);
  assert.deepEqual(out.reviewNotes, []);
  assert.deepEqual(rounds, [1]);
  assert.equal(reviewer.calls.length, 1);
  const { system, messages } = reviewer.calls[0];
  assert.match(system, /^# Writing a fix log entry/, 'the brief opens the review prompt');
  assert.match(system, /review a fix log entry/);
  assert.match(system, /how the fault looked, sounded or reflected on the site/);
  assert.match(system, /A number or an event that no source holds/);
  assert.match(system, /quote the closest source line/);
  assert.equal(messages.length, 1, 'one turn: none of the writer conversation');
  const turn = String(messages[0].content);
  assert.match(turn, /Removes the stale section name/, 'the pull request body');
  assert.match(turn, /--- src\/pages\/about\.astro/, 'the diff');
  assert.match(turn, /# A synthetic finding/, 'the finding');
  assert.match(turn, /merged at 2026-11-19T05:00:00Z\. Today is 2026-11-27, 8 days later\./);
  assert.match(turn, /"changes"/, 'the facts as sources');
  assert.match(turn, /"lead": "A reader looking for that section/, 'the writer fields');
  assert.doesNotMatch(turn, /It failed\. It is fixed\./, 'not the writer earlier draft');
  assert.doesNotMatch(turn, /lead-sentences/, 'not the writer corrections');
  assert.match(lastUserTurn(model.calls[0].messages), /Today is 2026-11-27, 8 days later/, 'the writer reads the dates too');
});

test('a problem is corrected in one round: it goes back to the writer, the new draft is checked and reviewed again', async () => {
  const flagged = { quote: 'One of them had been removed.', rule: 'unsupported', reason: 'Searched the finding for "removed"; no source holds it.' };
  const mended = { ...GOOD, story: 'The about page named three sections.\n\nOne of the three was no longer on the page.' };
  const model = scriptedModel([reply(GOOD), reply(mended)]);
  const review = scriptedModel([problems([flagged]), { text: '```json\n{"verdict": "accept"}\n```', usage: { inputTokens: 60, outputTokens: 6 } }]);
  const out = await draftFixLogEntry(input(), { send: model.send, review: review.send });
  assert.equal(out.attempts, 2);
  assert.equal(out.reviewRounds, 2);
  assert.deepEqual(out.reviewNotes, []);
  assert.match(out.text, /no longer on the page/);
  assert.deepEqual(out.usage, { writer: { inputTokens: 200, outputTokens: 40 }, reviewer: { inputTokens: 110, outputTokens: 11 } });
  const correctionTurn = lastUserTurn(model.calls[1].messages);
  assert.match(correctionTurn, /"One of them had been removed\." \(unsupported\): Searched the finding/);
  assert.match(String(review.calls[1].messages[0].content), /no longer on the page/, 'the second review reads the corrected draft');
});

test('a corrected draft that fails a mechanical check is corrected within its round before the second review', async () => {
  const flagged = { quote: 'One of them had been removed.', rule: 'unsupported', reason: 'No source.' };
  const mended = { ...GOOD, story: 'The about page named three sections.\n\nOne was not on the page.' };
  const model = scriptedModel([reply(GOOD), reply({ ...mended, story: 'A — dash.' }), reply(mended)]);
  const review = scriptedModel([problems([flagged]), { text: '{"verdict":"accept"}', usage: { inputTokens: 50, outputTokens: 5 } }]);
  const out = await draftFixLogEntry(input(), { send: model.send, review: review.send });
  assert.equal(out.attempts, 3);
  assert.equal(out.reviewRounds, 2);
  assert.match(lastUserTurn(model.calls[2].messages), /em-dash/);
});

test('at the bound, the draft is returned with the reviewer problems as reviewNotes', async () => {
  const flagged = { quote: 'the heading the page promised', rule: 'unsupported', reason: 'Searched the finding and the diff for a heading; none.' };
  const model = scriptedModel([reply(GOOD), reply(GOOD)]);
  const review = scriptedModel([problems([flagged]), problems([flagged])]);
  const out = await draftFixLogEntry(input(), { send: model.send, review: review.send });
  assert.equal(out.reviewRounds, 2);
  assert.deepEqual(out.reviewNotes, [flagged]);
  assert.equal(model.calls.length, 2, 'no third writer turn after the last review');
  assert.equal(review.calls.length, 2);
  assert.match(out.text, /^title: /m, 'the draft is kept');
});

test('a corrected draft that cannot pass the checks gives back the last passing draft with its problems', async () => {
  const flagged = { quote: 'One of them had been removed.', rule: 'unsupported', reason: 'No source.' };
  const bad = reply({ ...GOOD, story: 'A — dash.' });
  const model = scriptedModel([reply(GOOD), bad, bad, bad]);
  const review = scriptedModel([problems([flagged])]);
  const out = await draftFixLogEntry(input(), { send: model.send, review: review.send });
  assert.equal(out.reviewRounds, 1);
  assert.deepEqual(out.reviewNotes, [flagged]);
  assert.match(out.text, /One of them had been removed\./, 'the first, passing draft');
  assert.doesNotMatch(out.text, /—/);
  assert.equal(out.attempts, 1 + FIX_LOG_MAX_ATTEMPTS);
});

test('a problem that quotes only a fact is dropped before the correction turn', async () => {
  const onFact = { quote: '2026-11-19T05:00:00Z', rule: 'unsupported', reason: 'The merge date is not in the finding.' };
  const model = scriptedModel([reply(GOOD)]);
  const review = scriptedModel([problems([onFact])]);
  const out = await draftFixLogEntry(input(), { send: model.send, review: review.send });
  assert.equal(model.calls.length, 1, 'no correction turn for a fact');
  assert.equal(out.reviewRounds, 1);
  assert.deepEqual(out.reviewNotes, []);
});

test('an unreadable review is one problem: the same draft is reviewed again, and at the bound it is the note', async () => {
  const model = scriptedModel([reply(GOOD)]);
  const review = scriptedModel([{ text: 'Looks fine to me.', usage: { inputTokens: 1, outputTokens: 1 } }, { text: '{"verdict":"maybe"}', usage: { inputTokens: 1, outputTokens: 1 } }]);
  const out = await draftFixLogEntry(input(), { send: model.send, review: review.send });
  assert.equal(model.calls.length, 1, 'the writer cannot mend an unreadable review');
  assert.equal(out.reviewRounds, 2);
  assert.equal(out.reviewNotes.length, 1);
  assert.equal(out.reviewNotes[0].rule, 'review');
  assert.match(out.reviewNotes[0].reason, /wrong shape/);
});

test('without a review model the writer model reviews too', async () => {
  const model = scriptedModel([reply(GOOD), { text: '{"verdict":"accept"}', usage: { inputTokens: 1, outputTokens: 1 } }]);
  const out = await draftFixLogEntry(input(), { send: model.send });
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].system, /review a fix log entry/);
  assert.equal(out.reviewRounds, 1);
});

test('a refused request carries its HTTP status as details', () => {
  const failure = classifyModelError(new Anthropic.APIError(401, undefined, 'invalid x-api-key', new Headers()));
  assert.ok(failure instanceof ApplicationFailure);
  assert.deepEqual(failure.details, [{ status: 401 }]);
});

// ── A path outside backticks (STW-710) ────────────────────────────────────────

test('a bare path is a site path or a repository path with a folder, and nothing in code, a link or a URL', () => {
  assert.deepEqual(
    bareStoryPaths('The page at /about/ and its twin /about.md, and src/pages/about.astro, changed.'),
    ['/about/', '/about.md', 'src/pages/about.astro'],
  );
  assert.deepEqual(bareStoryPaths('It ends a sentence at /rss.xml.'), ['/rss.xml']);
  assert.deepEqual(
    bareStoryPaths(
      [
        'Both `/about` and `src/pages/about.astro` are code. llms.txt and agents.md are names.',
        'See [the page](/about/) and https://www.mattpyle.com/about/ and github.com/mattpyle/x.md, which is a host.',
        '',
        '```',
        '/about',
        '```',
      ].join('\n'),
    ),
    [],
  );
});

test('the path check is for a draft only, so a published entry with a bare path still passes', () => {
  const text = goodEntry({ story: 'The page at /about named three sections.' });
  assert.deepEqual(checkEntry(text, { titles: [], slugs: [] }), []);
  assert.deepEqual(
    checkEntry(text, { titles: [], slugs: [] }, { newEntry: true }).map((f) => f.reason),
    ['the story holds /about outside backticks; put each path in backticks'],
  );
});

test('a draft with a bare path gets a correction turn, not a review note', async () => {
  const model = scriptedModel([reply({ ...GOOD, story: ['The page at /about named three sections.', '', 'One had been removed.'].join('\n') }), reply(GOOD)]);
  const reviewer = acceptingReviewer();
  const out = await draftFixLogEntry(input(), { send: model.send, review: reviewer.send });
  assert.equal(out.attempts, 2);
  assert.match(lastUserTurn(model.calls[1].messages), /story-path: the story holds \/about outside backticks/);
  assert.equal(reviewer.calls.length, 1, 'the reviewer saw only the corrected draft');
  assert.deepEqual(out.reviewNotes, []);
});
