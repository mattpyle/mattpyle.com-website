import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
process.env.STEWARD_SITE_DIR = fixtures;

const { tellCitations } = await import('../../src/activities/tells.js');
const { TELL_CATEGORIES } = await import('../../src/lib/tells.js');

/**
 * The `tell_citations` pass (spec §8.6b) — the half of the ai-tells taxonomy
 * that runs on every review with no flag.
 *
 * `posts/known-good.md` is clean for every mechanical pass but not tell-free:
 * line 13 carries a real em dash ("... the fixture needs updating — decide
 * which..."), which is a voice tell for this author (see `lib/tells.ts`).
 */

test('citations are informational, never findings that move the verdict', async () => {
  const result = await tellCitations('posts/known-good.md');

  assert.equal(result.pass, 'tell_citations');
  // The load-bearing assertion. Style is the author's call (design rule 1), and
  // a `flag` here would put every post containing an em dash or a triad into
  // `overall: flag` — teaching the reader that the verdict means nothing.
  assert.equal(result.verdict, 'pass');
  for (const f of result.findings) assert.equal(f.severity, 'pass');
});

test('the em dash in the fixture is cited by line', async () => {
  const result = await tellCitations('posts/known-good.md');

  const emDash = result.findings.filter((f) => f.message.startsWith('EM_DASH_DENSITY'));
  assert.equal(emDash.length, 1);
  assert.equal(emDash[0].line, 13);
  assert.match(emDash[0].excerpt!, /the fixture needs updating/);
  assert.equal(emDash[0].file, 'posts/known-good.md');
});

test('no patch is ever proposed — citations inform, the author decides', async () => {
  const result = await tellCitations('posts/known-good.md');
  assert.deepEqual(result.patches, []);
});

test('metrics carry every category at zero, plus the word count the densities divide by', async () => {
  const result = await tellCitations('posts/known-good.md');
  const counts = result.metrics?.tellCounts as Record<string, number>;

  assert.equal(counts.EM_DASH_DENSITY, 1);
  // Present at zero rather than absent: an absent key and a zero are very
  // different things to anything doing arithmetic across the archive later.
  assert.equal(Object.keys(counts).length, TELL_CATEGORIES.length);
  for (const c of TELL_CATEGORIES) assert.equal(typeof counts[c], 'number');

  // The denominator is archived with the counts so a density computed months
  // later cannot silently use a different word count than the one measured.
  assert.ok((result.metrics?.words as number) > 0);
});

test('no composite score is computed anywhere in this pass', async () => {
  // The whole point of the split (spec §9.2): the composite failed its
  // validation study, so the free half must not carry one — not even quietly in
  // metrics, where `steward stats --tells` would pick it up as if it were real.
  const result = await tellCitations('posts/known-good.md');
  assert.equal(result.metrics?.aiLikenessScore, undefined);
});
