import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateDispositions,
  fallbackDisposition,
  unknownWordOf,
} from '../../src/lib/dispositions.js';
import type { Finding, PassResult } from '../../src/lib/report.js';

function unknownFinding(word: string): Finding {
  return {
    id: 'cspell-1',
    pass: 'cspell',
    severity: 'flag',
    message: `"${word}" is not in the dictionary (suggestions: x, y). Fix it, or add it to cspell.config.yaml if it is jargon.`,
    file: 'src/content/writing/post.md',
    line: 1,
  } as Finding;
}

function cspellPass(findings: Finding[]): PassResult {
  return {
    pass: 'cspell',
    verdict: 'flag',
    findings,
    startedAt: new Date().toISOString(),
    durationMs: 1,
  } as PassResult;
}

test('only cspell unknown-word findings are recognised', () => {
  assert.equal(unknownWordOf(unknownFinding('Kimi')), 'Kimi');
  // The "did you mean" shape is a known misspelling, not an unknown word — it
  // already carries a suggestion and needs no disposition.
  const known = { ...unknownFinding('x'), message: '"utilising" — did you mean "utilizing"?' };
  assert.equal(unknownWordOf(known as Finding), null);
});

test('a capitalised token mid-sentence leans proper noun', () => {
  const text = 'We tested it and Kimi handled the tool call correctly.';
  const p = fallbackDisposition('Kimi', text);
  assert.equal(p.disposition, 'proper_noun');
});

test('a capital explained by sentence position does NOT lean proper noun', () => {
  // The whole signal is a capital the position does not account for. At the
  // start of a sentence it accounts for itself, so this must fall through.
  const text = 'The agent replied.\n\nKimi handled the tool call correctly.';
  assert.equal(fallbackDisposition('Kimi', text).disposition, 'typo');
});

test('a heading capital does not lean proper noun either', () => {
  assert.equal(fallbackDisposition('Widgetry', '## Widgetry and other things').disposition, 'typo');
});

test('a lowercase unknown word leans typo', () => {
  assert.equal(fallbackDisposition('recieve', 'I recieve the message.').disposition, 'typo');
});

test('the editorial pass overrides the deterministic fallback', () => {
  // Position alone would call this a typo; the pass has read the post and knows
  // better. That precedence is the point of asking it.
  const text = 'Kimi handled the tool call.';
  const passes = annotateDispositions(
    [cspellPass([unknownFinding('Kimi')])],
    text,
    [{ word: 'Kimi', disposition: 'proper_noun', reason: 'a Moonshot AI model, used as a subject' }],
  );
  const msg = passes[0].findings[0].message;
  assert.match(msg, /likely proper noun/);
  assert.match(msg, /steward dict-add Kimi/, 'the annotation names the exact command');
  assert.match(msg, /Moonshot AI model/, "the pass's own reason is carried through");
});

test('annotation is additive — the original cspell message survives', () => {
  const passes = annotateDispositions([cspellPass([unknownFinding('Kimi')])], 'x Kimi y', []);
  assert.match(passes[0].findings[0].message, /is not in the dictionary/);
});

test('non-cspell passes are untouched', () => {
  const vale = { ...cspellPass([unknownFinding('Kimi')]), pass: 'vale' } as PassResult;
  const [out] = annotateDispositions([vale], 'x Kimi y', []);
  assert.equal(out.findings[0].message, vale.findings[0].message);
});

test('an unreadable post degrades to typo rather than losing the finding', () => {
  // Synthesis passes empty text when the file cannot be read. The finding must
  // still be there, and must not be nudged toward a dictionary add.
  const [out] = annotateDispositions([cspellPass([unknownFinding('Kimi')])], '', []);
  assert.match(out.findings[0].message, /likely typo/);
});
