import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShortId, parseFindingRef, splitIdsAndWords } from '../../src/lib/finding-ids.js';

/** How a finding is named in a command, and where the ids end and the words begin. */

test('a short id is read in any case, with or without its hyphen', () => {
  for (const typed of ['MP-121', 'mp-121', 'Mp121', 'mp121', 'MP-0121']) assert.equal(normalizeShortId(typed), 'MP-121', typed);
  assert.equal(normalizeShortId('TI-1'), 'TI-1');
  for (const typed of ['121', 'MP-', 'MP-12a', 'fix', 'mp--121']) assert.equal(normalizeShortId(typed), null, typed);
});

test('a full key needs its double hyphen; site/key names the site', () => {
  assert.deepEqual(parseFindingRef('ux-rail-scrollbar--writing'), { kind: 'key', key: 'ux-rail-scrollbar--writing', text: 'ux-rail-scrollbar--writing' });
  assert.deepEqual(parseFindingRef('Mattpyle-Com/ux-rail-scrollbar--writing'), {
    kind: 'key',
    site: 'mattpyle-com',
    key: 'ux-rail-scrollbar--writing',
    text: 'mattpyle-com/ux-rail-scrollbar--writing',
  });
  // A plain word is a valid slug and still not a key.
  for (const word of ['fix', 'the-heading', 'a/b/c', '../etc--x', 'and/or?']) assert.equal(parseFindingRef(word), null, word);
});

test('several ids, mixed case, then the trailing words', () => {
  const { refs, words } = splitIdsAndWords('MP-176 mp178, TI-3 fix the heading too, not the footer');
  assert.deepEqual(refs.map((ref) => ref.text), ['MP-176', 'MP-178', 'TI-3']);
  assert.equal(words, 'fix the heading too, not the footer');
});

test('ids alone leave no words; words alone leave no ids', () => {
  assert.deepEqual(splitIdsAndWords('  mp121  '), { refs: [{ kind: 'short', short: 'MP-121', text: 'MP-121' }], words: '' });
  assert.deepEqual(splitIdsAndWords('fix the heading'), { refs: [], words: 'fix the heading' });
  assert.deepEqual(splitIdsAndWords(''), { refs: [], words: '' });
});

test('an id named twice counts once, and an id after the first word is a word', () => {
  const { refs, words } = splitIdsAndWords('MP-1 mp1 as in MP-2');
  assert.deepEqual(refs.map((ref) => ref.text), ['MP-1']);
  assert.equal(words, 'as in MP-2');
});

test('a short id and a full key can share one list', () => {
  const { refs, words } = splitIdsAndWords('MP-1,content-stale-claim--changelog ok');
  assert.deepEqual(refs.map((ref) => ref.kind), ['short', 'key']);
  assert.equal(words, 'ok');
});
