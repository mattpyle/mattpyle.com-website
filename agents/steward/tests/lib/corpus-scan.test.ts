import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CorpusScanRow } from '../../src/lib/corpus-scan.js';

// config.ts resolves SITE_DIR from the environment at import time, so the
// fixture root has to be set before any module that imports config.ts loads
// — same pattern as tests/activities/frontmatter.test.ts.
const scanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-corpus-scan-'));
process.env.STEWARD_SITE_DIR = scanRoot;

const { groupByProvenance, renderCorpusScan, scanCorpusDeterministic } = await import(
  '../../src/lib/corpus-scan.js'
);

/** Strips ANSI colour codes so assertions can match on plain text. */
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9]+m/g, '');
}

function zeroDeterministicCounts(): CorpusScanRow['tellCounts'] {
  return {
    EM_DASH_DENSITY: 0,
    STOCK_TRANSITIONS: 0,
    RULE_OF_THREE: 0,
    LIST_INFLATION: 0,
    UNIFORM_RHYTHM: 0,
  };
}

function row(overrides: Partial<CorpusScanRow> = {}): CorpusScanRow {
  return {
    collection: 'writing',
    slug: 'test-piece',
    provenance: 'human',
    words: 100,
    tellCounts: zeroDeterministicCounts(),
    tellsPer100: zeroDeterministicCounts(),
    ...overrides,
  };
}

// --- groupByProvenance / renderCorpusScan (pure, synthetic rows) -----------

test('groupByProvenance clusters rows by label, known labels first', () => {
  const groups = groupByProvenance([
    row({ slug: 'a', provenance: 'ai' }),
    row({ slug: 'b', provenance: 'human' }),
    row({ slug: 'c', provenance: 'mixed' }),
    row({ slug: 'd', provenance: 'unlabelled' }),
  ]);
  assert.deepEqual([...groups.keys()], ['human', 'mixed', 'ai', 'unlabelled']);
});

test('renderCorpusScan prints one section per provenance group and names the 3 LLM-only tells', () => {
  const out = plain(
    renderCorpusScan([
      row({ slug: 'human-post', provenance: 'human' }),
      row({ slug: 'ai-post', provenance: 'ai' }),
    ]),
  );
  assert.match(out, /-- HUMAN \(n=1\) --/);
  assert.match(out, /-- AI \(n=1\) --/);
  assert.match(out, /human-post/);
  assert.match(out, /ai-post/);
  // The 3 judgment tells must be named as unmeasured, not silently absent.
  assert.match(out, /LLM-only — not measured here: NOT_X_BUT_Y, ZINGER_BOLDING, HEDGED_SYMMETRY/);
  assert.match(out, /Zero Anthropic API calls made/);
});

test('renderCorpusScan shows n/a for a zero-word piece rather than dividing by zero', () => {
  const out = plain(renderCorpusScan([row({ slug: 'empty', words: 0, tellsPer100: null })]));
  assert.match(out, /n\/a/);
});

// --- scanCorpusDeterministic (real fs traversal, temp fixture root) --------
//
// Exercises the actual directory scan against a throwaway `src/content/`
// tree, proving three things a synthetic-row test cannot: fixtures
// (`*smoke-test*`/`*fixture*`) are excluded, frontmatter does not leak into
// the count, and per-100-word density is computed from the real body word
// count of the file on disk.

test('scanCorpusDeterministic scans real files, excludes fixtures, and normalises per 100 words', async () => {
  const writingDir = path.join(scanRoot, 'src', 'content', 'writing');
  await fs.mkdir(writingDir, { recursive: true });

  // A real post: one em dash, no surrounding spaces so it doesn't split into
  // its own whitespace-delimited token -> an unambiguous 9-word body.
  await fs.writeFile(
    path.join(writingDir, 'em-dash-post.md'),
    [
      '---',
      'title: "Has an em dash"',
      'date: 2026-07-21',
      '---',
      '',
      'One two three four five six seven eight nine—ten.',
      '',
    ].join('\n'),
    'utf8',
  );

  // A fixture: must be excluded from the scan entirely, per the same rule
  // stats.ts uses (README rule 4 — "fixtures are planted defects, not writing").
  await fs.writeFile(
    path.join(writingDir, 'steward-smoke-test.md'),
    ['---', 'title: "Fixture"', 'date: 2026-07-21', '---', '', 'Ignore me — I am a fixture.', ''].join('\n'),
    'utf8',
  );

  const rows = await scanCorpusDeterministic();
  const slugs = rows.map((r) => r.slug);
  assert.ok(slugs.includes('em-dash-post'));
  assert.ok(!slugs.includes('steward-smoke-test'), 'fixture file should be excluded from the scan');

  const found = rows.find((r) => r.slug === 'em-dash-post')!;
  assert.equal(found.collection, 'writing');
  assert.equal(found.words, 9);
  assert.equal(found.tellCounts.EM_DASH_DENSITY, 1);
  // 1 hit / 9 words * 100, rounded to 3dp — same rounding `scanCorpusDeterministic` applies.
  assert.equal(found.tellsPer100?.EM_DASH_DENSITY, Number(((1 / 9) * 100).toFixed(3)));
  // No prior `steward score` run for this throwaway fixture -> no ground truth.
  assert.equal(found.provenance, 'unlabelled');
});

test('scanCorpusDeterministic tolerates a collection directory that does not exist', async () => {
  // Only `src/content/writing/` was created above (in `scanRoot`) — there is
  // no `src/content/changelog/` at all. The scan must not throw on a missing
  // directory; it should simply contribute zero rows for that collection.
  const rows = await scanCorpusDeterministic();
  assert.ok(rows.every((r) => r.collection === 'writing'));
});
