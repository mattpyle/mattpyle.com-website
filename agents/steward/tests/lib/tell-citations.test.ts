import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyWordCount,
  categoryOfMessage,
  citationMessage,
  formatTellGroup,
  groupArchivedCitations,
  groupTellCitations,
  per100,
} from '../../src/lib/tell-citations.js';
import type { DeterministicTellFinding } from '../../src/lib/tells.js';

/**
 * The shaping layer under the citations: counts, densities, and the round trip
 * that lets a report read back off disk render as counts rather than as a wall
 * of individual lines.
 */

function finding(
  category: DeterministicTellFinding['category'],
  line: number,
): DeterministicTellFinding {
  return { category, line, excerpt: 'x', message: 'm', evidence: 'e' };
}

test('groups are ordered commonest first and keep repeated lines as separate hits', () => {
  const groups = groupTellCitations(
    [
      finding('EM_DASH_DENSITY', 10),
      finding('RULE_OF_THREE', 5),
      finding('RULE_OF_THREE', 5),
      finding('RULE_OF_THREE', 2),
    ],
    200,
  );

  assert.deepEqual(
    groups.map((g) => g.category),
    ['RULE_OF_THREE', 'EM_DASH_DENSITY'],
  );
  // Two triads on line 5 are two findings, not one. The counters emit one per
  // match, and collapsing them here would silently undercount the density.
  assert.deepEqual(groups[0].lines, [2, 5, 5]);
  assert.equal(groups[0].count, 3);
});

test('density is per 100 body words, and null rather than zero when there is nothing to divide by', () => {
  assert.equal(per100(5, 1545), 0.32);
  assert.equal(per100(15, 1545), 0.97);
  // A 0 here would read as "no tells" to anything ranking these; an
  // unnormalisable count is a gap in the data, not a clean result.
  assert.equal(per100(5, 0), null);

  const [group] = groupTellCitations([finding('EM_DASH_DENSITY', 1)], 0);
  assert.equal(group.per100, null);
  assert.match(formatTellGroup(group), /—\/100w/);
});

test('word count excludes frontmatter', () => {
  const text = ['---', 'title: "one two three four five"', 'draft: true', '---', '', 'a b c'].join(
    '\n',
  );
  assert.equal(bodyWordCount(text), 3);
});

test('a citation message round-trips its category, and non-citations read as null', () => {
  const message = citationMessage('EM_DASH_DENSITY', 'em dash (—)');
  assert.equal(message, 'EM_DASH_DENSITY: em dash (—)');
  assert.equal(categoryOfMessage(message), 'EM_DASH_DENSITY');
  // The renderer runs this over whatever is in an archived report; anything that
  // is not one of the eight categories must not be grouped as a tell.
  assert.equal(categoryOfMessage('buried lede: the real result is in paragraph four'), null);
  assert.equal(categoryOfMessage('no colon here'), null);
});

test('archived findings regroup into the same counts the activity produced', () => {
  const raw = [
    finding('RULE_OF_THREE', 4),
    finding('RULE_OF_THREE', 9),
    finding('EM_DASH_DENSITY', 7),
  ];
  const fromRaw = groupTellCitations(raw, 100);
  const fromArchive = groupArchivedCitations(
    raw.map((f) => ({ message: citationMessage(f.category, f.message), line: f.line })),
    100,
  );
  assert.deepEqual(fromArchive, fromRaw);
});

test('findings from other passes are ignored when regrouping an archived report', () => {
  const groups = groupArchivedCitations(
    [
      { message: citationMessage('EM_DASH_DENSITY', 'em dash (—)'), line: 3 },
      { message: 'unknown word "recieve"', line: 4 },
      // A citation with no line cannot be cited, so it is not counted either.
      { message: citationMessage('RULE_OF_THREE', 'triad'), line: undefined },
    ],
    100,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].category, 'EM_DASH_DENSITY');
});
