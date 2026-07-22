import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TELL_CATEGORIES,
  DETERMINISTIC_TELLS,
  LLM_JUDGED_TELLS,
  computeDeterministicTells,
  findEmDashDensity,
  findStockTransitions,
  findRuleOfThree,
  findListInflation,
  findUniformRhythm,
} from '../../src/lib/tells.js';

/**
 * Every deterministic tell gets a known-positive (must fire, non-zero) and a
 * known-negative (must not fire, zero) input, asserted directly against its
 * own counter rather than eyeballed against a study run. See build-log
 * "deterministic tell counters" entry for why: a tell that reads zero on real
 * content is ambiguous between "genuinely absent" and "the counter is
 * broken" until it has been proven against an input built to trigger it.
 */

test('DETERMINISTIC_TELLS and LLM_JUDGED_TELLS partition all eight categories without overlap or omission', () => {
  const combined = [...DETERMINISTIC_TELLS, ...LLM_JUDGED_TELLS].sort();
  assert.deepEqual(combined, [...TELL_CATEGORIES].sort());
  const overlap = DETERMINISTIC_TELLS.filter((c) => (LLM_JUDGED_TELLS as readonly string[]).includes(c));
  assert.deepEqual(overlap, []);
});

// --- EM_DASH_DENSITY --------------------------------------------------------

test('EM_DASH_DENSITY fires once per em dash character', () => {
  const findings = findEmDashDensity('This sentence has one em dash — right there.\nAnd two more — here — too.');
  assert.equal(findings.length, 3);
  for (const f of findings) assert.equal(f.category, 'EM_DASH_DENSITY');
});

test('EM_DASH_DENSITY does not fire on hyphens, en dashes, or double-hyphens', () => {
  const findings = findEmDashDensity('A well-known range, 10-12 or 10–12, and a -- double hyphen too.');
  assert.equal(findings.length, 0);
});

test('EM_DASH_DENSITY ignores em dashes inside fenced code blocks', () => {
  const text = ['prose with no dash here', '```', 'const x = a — b; // fake em dash in code', '```', 'more prose'].join(
    '\n',
  );
  assert.equal(findEmDashDensity(text).length, 0);
});

// --- STOCK_TRANSITIONS -------------------------------------------------------

test('STOCK_TRANSITIONS fires on the rubric\'s known phrases', () => {
  const text = [
    'Moreover, the results were clear.',
    "In today's fast-moving landscape, speed matters.",
    "Let's dive in and see what happened.",
    'The result? Total silence.',
  ].join('\n');
  const findings = findStockTransitions(text);
  assert.equal(findings.length, 4);
  for (const f of findings) assert.equal(f.category, 'STOCK_TRANSITIONS');
});

test('STOCK_TRANSITIONS does not fire on ordinary prose', () => {
  const findings = findStockTransitions('The site loaded quickly and the tests passed.');
  assert.equal(findings.length, 0);
});

// --- RULE_OF_THREE -----------------------------------------------------------

test('RULE_OF_THREE fires on an explicit "x, y, and z" triad', () => {
  const findings = findRuleOfThree('Read the docs, run the tests, and ship the code.');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'RULE_OF_THREE');
});

test('RULE_OF_THREE fires on an Oxford-comma-less triad too', () => {
  const findings = findRuleOfThree('It was faster, cleaner and more honest.');
  assert.equal(findings.length, 1);
});

test('RULE_OF_THREE does not fire on a plain two-item list', () => {
  const findings = findRuleOfThree('I like coffee and tea in the morning.');
  assert.equal(findings.length, 0);
});

// --- LIST_INFLATION -----------------------------------------------------------

test('LIST_INFLATION fires on a bullet item long enough and punctuated enough to read as a sentence', () => {
  const text = '- This is a full sentence that really should just be written as flowing prose.';
  const findings = findListInflation(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'LIST_INFLATION');
});

test('LIST_INFLATION does not fire on a short label-style bullet', () => {
  const text = ['- Fast', '- Type-safe', '- No config'].join('\n');
  assert.equal(findListInflation(text).length, 0);
});

// --- UNIFORM_RHYTHM -----------------------------------------------------------

test('UNIFORM_RHYTHM fires on 3+ consecutive paragraphs of near-identical shape', () => {
  const text = [
    'The site is fast and clean and modern in style today.',
    '',
    'The site is quick and light and modern in feel today.',
    '',
    'The site is neat and slick and modern in tone today.',
  ].join('\n');
  const findings = findUniformRhythm(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'UNIFORM_RHYTHM');
});

test('UNIFORM_RHYTHM does not fire on paragraphs of clearly different length', () => {
  const text = [
    'A short paragraph with just a few words in it.',
    '',
    'This second paragraph is considerably longer than the first one and covers a great deal more ground across many more words than its neighbours do.',
    '',
    'A third paragraph, medium in length, sits roughly between the two in size.',
  ].join('\n');
  assert.equal(findUniformRhythm(text).length, 0);
});

test('UNIFORM_RHYTHM does not fire on fewer than 3 similar paragraphs', () => {
  const text = [
    'The site is fast and clean and modern in style today.',
    '',
    'The site is quick and light and modern in feel today.',
  ].join('\n');
  assert.equal(findUniformRhythm(text).length, 0);
});

// --- Aggregation --------------------------------------------------------------

test('computeDeterministicTells runs all five counters and only tags deterministic categories', () => {
  const text = [
    'Moreover, this post reads oddly — really oddly.',
    '',
    '- This bullet is a full sentence that should have been written as prose.',
    '',
    'Read the docs, run the tests, and ship the code.',
  ].join('\n');
  const findings = computeDeterministicTells(text);
  assert.ok(findings.length >= 4);
  for (const f of findings) {
    assert.ok(
      (DETERMINISTIC_TELLS as readonly string[]).includes(f.category),
      `${f.category} should be a deterministic tell`,
    );
  }
});

test('computeDeterministicTells returns nothing on a clean, tell-free post', () => {
  const text = [
    '## A clean section',
    '',
    'This paragraph is plain prose. It has short sentences without any stock',
    'phrases or dash marks. Nothing here forms a list construction either.',
  ].join('\n');
  assert.deepEqual(computeDeterministicTells(text), []);
});
