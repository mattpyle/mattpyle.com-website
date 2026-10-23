import assert from 'node:assert/strict';
import test from 'node:test';

import { pageToMarkdown } from '../scripts/lib/html-to-markdown.mjs';
import { STEWARD_FAST_CHECKS } from '../src/data/steward-audit-checks.mjs';
import { auditMarkdownDocument } from '../src/lib/audit-markdown.mjs';
import { splitInlineCode } from '../src/lib/inline-code.mjs';

/**
 * The backticked terms in a check description, on every surface that prints one.
 *
 * `plain` is read three ways: /steward and /audit render it as HTML, audit.md writes it into a
 * markdown table, and steward.md is converted from the built /steward HTML. The splitter serves
 * the first two, and the last two assertions pin that both markdown twins end up with a real code
 * span rather than a literal or an escaped backtick.
 */

test('a sentence with no backticks is one text segment', () => {
  const plain = 'There is a robots.txt, it is served as text, and its groups and rules parse.';
  assert.deepEqual(splitInlineCode(plain), [{ text: plain, code: false }]);
  assert.deepEqual(splitInlineCode(''), []);
});

test('a backticked term becomes a code segment and keeps the spaces either side', () => {
  assert.deepEqual(splitInlineCode('A request with `Accept: text/markdown` returns markdown.'), [
    { text: 'A request with ', code: false },
    { text: 'Accept: text/markdown', code: true },
    { text: ' returns markdown.', code: false },
  ]);
  assert.deepEqual(splitInlineCode('alternates in a `Link` header, where'), [
    { text: 'alternates in a ', code: false },
    { text: 'Link', code: true },
    { text: ' header, where', code: false },
  ]);
});

test('a code span at the start or the end leaves no empty segment beside it', () => {
  assert.deepEqual(splitInlineCode('`Link` leads.'), [
    { text: 'Link', code: true },
    { text: ' leads.', code: false },
  ]);
  assert.deepEqual(splitInlineCode('It ends in `Link`'), [
    { text: 'It ends in ', code: false },
    { text: 'Link', code: true },
  ]);
  assert.deepEqual(splitInlineCode('`Link`'), [{ text: 'Link', code: true }]);
  assert.deepEqual(splitInlineCode('`a``b`'), [
    { text: 'a', code: true },
    { text: 'b', code: true },
  ]);
});

test('an unmatched backtick stays a literal character and turns nothing after it into code', () => {
  const unmatched = 'A stray ` and then the rest of the sentence.';
  assert.deepEqual(splitInlineCode(unmatched), [{ text: unmatched, code: false }]);

  // A pair closes before the stray one, so the tail stays text.
  assert.deepEqual(splitInlineCode('in a `Link` header with a stray ` after it'), [
    { text: 'in a ', code: false },
    { text: 'Link', code: true },
    { text: ' header with a stray ` after it', code: false },
  ]);
});

test('an empty pair of backticks stays literal text', () => {
  assert.deepEqual(splitInlineCode('An empty `` pair.'), [{ text: 'An empty `` pair.', code: false }]);
  assert.deepEqual(splitInlineCode('``'), [{ text: '``', code: false }]);
});

test('markup characters pass through a segment untouched, for the template to escape', () => {
  assert.deepEqual(splitInlineCode('a < b & `<script>&amp;` c'), [
    { text: 'a < b & ', code: false },
    { text: '<script>&amp;', code: true },
    { text: ' c', code: false },
  ]);
});

test('the fifteen checks carry exactly two code terms and no leftover backtick', () => {
  const segments = STEWARD_FAST_CHECKS.flatMap((check) => splitInlineCode(check.plain));

  assert.deepEqual(
    segments.filter((segment) => segment.code).map((segment) => segment.text),
    ['Accept: text/markdown', 'Link']
  );
  for (const segment of segments) {
    assert.equal(segment.text.includes('`'), false, segment.text);
  }

  // Splitting loses nothing: the segments rejoin to the sentence the data file holds.
  for (const check of STEWARD_FAST_CHECKS) {
    const rejoined = splitInlineCode(check.plain)
      .map((segment) => (segment.code ? `\`${segment.text}\`` : segment.text))
      .join('');
    assert.equal(rejoined, check.plain);
  }
});

test('a code element in a check description reaches steward.md as a code span', () => {
  const markdown = pageToMarkdown(
    '<!doctype html><html><head><title>Steward — Matt Pyle</title><meta name="description" content="A page."><link rel="canonical" href="https://www.mattpyle.com/steward/"></head><body><main class="site-main" id="main"><h1>Steward</h1><ul><li><span class="check-detail">A request with <code>Accept: text/markdown</code> returns markdown.</span></li></ul></main></body></html>'
  );

  assert.ok(markdown.includes('with `Accept: text/markdown` returns'), markdown);
  assert.equal(markdown.includes('\\'), false, markdown);
});

test('audit.md still carries both descriptions verbatim, backticks unescaped', () => {
  const { body } = auditMarkdownDocument({ asked: null, now: new Date('2026-09-05T13:30:00.000Z') });

  for (const id of ['markdown-negotiation-home', 'link-headers']) {
    const check = STEWARD_FAST_CHECKS.find((candidate) => candidate.id === id);
    assert.ok(check.plain.includes('`'), `${id} no longer marks a term as code`);
    assert.ok(body.includes(check.plain), `audit.md changed the ${id} description`);
  }
});
