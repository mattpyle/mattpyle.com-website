import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLlmsTxtConformance } from '../../src/lib/agent-audit/llms-txt-conformance.js';

/**
 * The llms.txt v2 conformance rules.
 *
 * Same shape as `agent-audit-checks.test.ts`: one conforming document, and each case breaks
 * exactly one thing, so a reported violation is always attributable to the break.
 *
 * The BOM case is the reason this suite exists rather than the site simply parsing its own file.
 * llmstxt.org v2 (modified 2026-08-10) made a BOM explicitly optional, and a checker that has not
 * caught up reports the worst possible failure for it — `﻿# Title` does not start with `# `,
 * so the document reads as having no H1 at all. The site's own llms.txt will never carry a BOM, so
 * nothing that only reads the real file could ever notice getting this wrong.
 */

const CONFORMING = [
  '# Matt Pyle',
  '',
  '> Director of Growth at Temporal Technologies.',
  '',
  'Some prose that is not a heading and not a list.',
  '',
  '## Pages',
  '',
  '- [Home](https://www.mattpyle.com/): bio and recent activity.',
  '- [Writing](https://www.mattpyle.com/writing/): all writing.',
  '',
].join('\n');

/** The rule ids reported for a document, sorted, so an assertion names rules rather than indexes. */
function rules(text: string): string[] {
  return checkLlmsTxtConformance(text)
    .violations.map((violation) => violation.rule)
    .sort();
}

test('a conforming document has no violations', () => {
  const result = checkLlmsTxtConformance(CONFORMING);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.equal(result.parsed.title, 'Matt Pyle');
  assert.equal(result.parsed.sections.length, 1);
  assert.equal(result.parsed.links.length, 2);
});

test('a byte order mark is optional in v2, not a failure', () => {
  const result = checkLlmsTxtConformance(`﻿${CONFORMING}`);
  assert.deepEqual(result.violations, []);
  // The parse has to be identical, not merely non-failing: a BOM that survived into the title
  // would poison every consumer downstream of it.
  assert.equal(result.parsed.title, 'Matt Pyle');
});

test('a missing H1 is the one required violation', () => {
  const result = checkLlmsTxtConformance(CONFORMING.replace('# Matt Pyle\n', ''));
  const h1 = result.violations.find((violation) => violation.rule === 'h1');
  assert.ok(h1, 'expected an h1 violation');
  assert.equal(h1.required, true);
  assert.equal(result.ok, false);
});

test('an H1 that is not the first line is reported even though it parses', () => {
  const text = `Intro prose before the title.\n\n${CONFORMING}`;
  assert.equal(checkLlmsTxtConformance(text).parsed.title, 'Matt Pyle');
  assert.deepEqual(rules(text), ['h1-first']);
});

test('a missing blockquote summary is reported', () => {
  assert.deepEqual(rules(CONFORMING.replace('> Director of Growth at Temporal Technologies.\n', '')), [
    'summary',
  ]);
});

test('a document with no "##" section has no links either', () => {
  const text = ['# Matt Pyle', '', '> A summary.', ''].join('\n');
  assert.deepEqual(rules(text), ['links', 'sections']);
});

test('a list item that does not lead with a link is reported once per item', () => {
  const text = CONFORMING.replace(
    '- [Writing](https://www.mattpyle.com/writing/): all writing.',
    '- **Writing** — see [the index](https://www.mattpyle.com/writing/).',
  );
  assert.deepEqual(rules(text), ['list-item-format']);
});

test('CRLF line endings parse the same as LF', () => {
  assert.deepEqual(checkLlmsTxtConformance(CONFORMING.replace(/\n/g, '\r\n')).violations, []);
});
