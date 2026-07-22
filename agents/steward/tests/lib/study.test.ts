import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComparisonRows,
  groupByProvenance,
  renderComparison,
  type ComparisonRow,
} from '../../src/lib/study.js';
import type { StudyPiece, StudyRun } from '../../src/lib/study.js';
import { TELL_CATEGORIES, type TellCategory } from '../../src/lib/tells.js';

/** Strips ANSI colour codes so assertions can match on plain text. */
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9]+m/g, '');
}

function zeroCounts(overrides: Partial<Record<TellCategory, number>> = {}): Record<TellCategory, number> {
  return Object.fromEntries(TELL_CATEGORIES.map((c) => [c, overrides[c] ?? 0])) as Record<
    TellCategory,
    number
  >;
}

function run(overrides: Partial<StudyRun> = {}): StudyRun {
  return {
    run: 1,
    aiLikenessScore: 10,
    tellCounts: zeroCounts(),
    durationMs: 100,
    rubricSha256: 'abc',
    model: 'test-model',
    at: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function piece(overrides: Partial<StudyPiece> = {}): StudyPiece {
  return {
    collection: 'writing',
    slug: 'test-piece',
    provenance: 'human',
    draft: false,
    words: 100,
    runs: [run()],
    ...overrides,
  };
}

test('buildComparisonRows normalises tell counts per 100 words, not raw counts', () => {
  const p = piece({
    words: 200,
    runs: [run({ tellCounts: zeroCounts({ EM_DASH_DENSITY: 4 }) })],
  });
  const [row] = buildComparisonRows([p]);
  // 4 hits over 200 words -> 2 per 100 words, not 4.
  assert.equal(row.tellsPer100?.EM_DASH_DENSITY, 2);
});

test('buildComparisonRows averages tell counts and score across runs', () => {
  const p = piece({
    words: 100,
    runs: [
      run({ run: 1, aiLikenessScore: 10, tellCounts: zeroCounts({ ZINGER_BOLDING: 2 }) }),
      run({ run: 2, aiLikenessScore: 20, tellCounts: zeroCounts({ ZINGER_BOLDING: 4 }) }),
    ],
  });
  const [row] = buildComparisonRows([p]);
  assert.equal(row.meanScore, 15);
  assert.equal(row.tellsPer100?.ZINGER_BOLDING, 3);
});

test('buildComparisonRows reports null score for a piece with no runs', () => {
  const p = piece({ runs: [] });
  const [row] = buildComparisonRows([p]);
  assert.equal(row.meanScore, null);
});

test('buildComparisonRows reports null densities for a zero-word piece (no divide-by-zero)', () => {
  const p = piece({ words: 0 });
  const [row] = buildComparisonRows([p]);
  assert.equal(row.tellsPer100, null);
});

test('groupByProvenance clusters rows by label', () => {
  const rows: ComparisonRow[] = buildComparisonRows([
    piece({ slug: 'a', provenance: 'human' }),
    piece({ slug: 'b', provenance: 'ai' }),
    piece({ slug: 'c', provenance: 'human' }),
    piece({ slug: 'd', provenance: 'mixed' }),
  ]);
  const groups = groupByProvenance(rows);
  assert.deepEqual(
    groups.get('human')!.map((r) => r.slug),
    ['a', 'c'],
  );
  assert.equal(groups.get('ai')!.length, 1);
  assert.equal(groups.get('mixed')!.length, 1);
});

test('groupByProvenance orders known labels human, mixed, ai first; unknown labels last, alphabetically', () => {
  const rows: ComparisonRow[] = buildComparisonRows([
    piece({ slug: 'a', provenance: 'ai' }),
    piece({ slug: 'b', provenance: 'zzz-unknown' }),
    piece({ slug: 'c', provenance: 'human' }),
    piece({ slug: 'd', provenance: 'mixed' }),
    piece({ slug: 'e', provenance: 'aaa-unknown' }),
  ]);
  const groups = groupByProvenance(rows);
  assert.deepEqual(
    [...groups.keys()],
    ['human', 'mixed', 'ai', 'aaa-unknown', 'zzz-unknown'],
  );
});

test('renderComparison prints one section per provenance group and a row per piece', () => {
  const rows = buildComparisonRows([
    piece({ slug: 'human-post', provenance: 'human', words: 100 }),
    piece({ slug: 'ai-post', provenance: 'ai', words: 100 }),
  ]);
  const out = plain(renderComparison(rows));
  assert.match(out, /-- HUMAN \(n=1\) --/);
  assert.match(out, /-- AI \(n=1\) --/);
  assert.match(out, /human-post/);
  assert.match(out, /ai-post/);
});

test('renderComparison shows n/a for a piece with no word-normalised densities', () => {
  const rows = buildComparisonRows([piece({ slug: 'no-words', words: 0 })]);
  const out = plain(renderComparison(rows));
  assert.match(out, /n\/a/);
});
