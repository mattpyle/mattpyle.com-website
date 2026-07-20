import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summariseTells } from '../../src/lib/stats.js';
import {
  TELL_CATEGORIES,
  FORMAT_DRIVEN_TELLS,
  VOICE_DRIVEN_TELLS,
  type TellCategory,
} from '../../src/lib/tells.js';

/**
 * The per-100-words normalisation is the single number every cross-collection
 * comparison in the validation study depends on. The corpus has a ~9x genre gap
 * in length between a changelog entry and a writing post, so an error here does
 * not produce an obviously wrong answer — it produces a plausible ranking that
 * is measuring length.
 *
 * The E-Prime counting command in the README was hand-rolled twice and was wrong
 * both times, silently. These tests exist so the third hand-roll does not happen.
 */

function counts(overrides: Partial<Record<TellCategory, number>> = {}) {
  return Object.fromEntries(
    TELL_CATEGORIES.map((c) => [c, overrides[c] ?? 0]),
  ) as Record<TellCategory, number>;
}

test('densities are per 100 words, not per file', () => {
  // Same raw count, 10x the length: the density must fall by 10x. This is the
  // entire reason the study may not aggregate raw counts across collections.
  const short = summariseTells(counts({ NOT_X_BUT_Y: 5 }), 100);
  const long = summariseTells(counts({ NOT_X_BUT_Y: 5 }), 1000);

  assert.equal(short.tellTotalPer100, 5);
  assert.equal(long.tellTotalPer100, 0.5);
});

test('the voice aggregate excludes format tells and the unclassified one', () => {
  const summary = summariseTells(
    counts({
      // voice-driven
      NOT_X_BUT_Y: 2,
      STOCK_TRANSITIONS: 1,
      // format-driven — must not reach the voice aggregate
      UNIFORM_RHYTHM: 4,
      RULE_OF_THREE: 4,
      // unclassified — must reach NEITHER aggregate
      EM_DASH_DENSITY: 10,
    }),
    100,
  );

  assert.equal(summary.voiceTellsPer100, 3, 'voice aggregate picked up non-voice tells');
  assert.equal(summary.formatTellsPer100, 8, 'format aggregate is wrong');
  // The total still counts everything, including the unclassified tell.
  assert.equal(summary.tellTotalPer100, 21);
  // ...which means the two aggregates deliberately do not sum to the total.
  assert.notEqual(
    (summary.voiceTellsPer100 ?? 0) + (summary.formatTellsPer100 ?? 0),
    summary.tellTotalPer100,
  );
});

test('an unnormalisable review yields nulls, never zeroes', () => {
  // A post that has been renamed or unpublished has no word count. Reporting 0
  // would be read as "no tells found" by anything ranking these — the opposite
  // of the truth, which is that we do not know.
  for (const words of [0, null]) {
    const summary = summariseTells(counts({ NOT_X_BUT_Y: 3 }), words);
    assert.equal(summary.tellTotalPer100, null);
    assert.equal(summary.voiceTellsPer100, null);
    assert.equal(summary.formatTellsPer100, null);
    assert.equal(summary.tellsPer100, null);
  }
});

test('a review with no ai_tells pass is null, not zero', () => {
  // "The scorer ran and found nothing" and "the scorer did not run" must not
  // collapse into the same value.
  const summary = summariseTells(null, 500);
  assert.equal(summary.tellsPer100, null);
  assert.equal(summary.tellTotalPer100, null);
});

test('every category appears in the per-category densities', () => {
  const summary = summariseTells(counts({ LIST_INFLATION: 1 }), 200);
  assert.equal(Object.keys(summary.tellsPer100 ?? {}).length, TELL_CATEGORIES.length);
  assert.equal(summary.tellsPer100?.LIST_INFLATION, 0.5);
  // A tell that did not fire is a measured zero and must be present as one.
  assert.equal(summary.tellsPer100?.HEDGED_SYMMETRY, 0);
});

test('the format and voice lists do not overlap', () => {
  // A tell in both lists would be double-counted in the study's re-ranking.
  const overlap = FORMAT_DRIVEN_TELLS.filter((c) => VOICE_DRIVEN_TELLS.includes(c));
  assert.deepEqual(overlap, []);
});
