import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  GENERATED_FILES,
  MAX_DIFF_LINES,
  summarise,
} from '../scripts/summarise-generated-diff.mjs';

/**
 * The CI job summary that replaced the committed diff of the three generated data files.
 * It runs only on pull requests, so a regression would first show on the next content PR.
 */

function root(files) {
  const dir = mkdtempSync(join(tmpdir(), 'generated-diff-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const same = Object.fromEntries(GENERATED_FILES.map((rel) => [rel, `${rel}\n`]));

test('a file identical on both sides reads "No change."', () => {
  const base = root(same);
  const head = root(same);
  try {
    const text = summarise(base, head);
    for (const rel of GENERATED_FILES) assert.ok(text.includes(`### \`${rel}\``));
    assert.equal(text.match(/No change\./g).length, GENERATED_FILES.length);
    assert.ok(!text.includes('```diff'));
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(head, { recursive: true, force: true });
  }
});

test('a changed file shows a diff labelled by relative path, the others stay unchanged', () => {
  const changed = GENERATED_FILES[0];
  const base = root(same);
  const head = root({ ...same, [changed]: 'new line\n' });
  try {
    const text = summarise(base, head);
    assert.ok(text.includes(`--- base/${changed}`));
    assert.ok(text.includes(`+++ head/${changed}`));
    assert.ok(text.includes('+new line'));
    assert.ok(!text.includes(tmpdir()), 'no absolute path leaks into the summary');
    assert.equal(text.match(/No change\./g).length, GENERATED_FILES.length - 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(head, { recursive: true, force: true });
  }
});

test('a file missing from a side is named, not fatal', () => {
  const base = root({});
  const head = root(same);
  try {
    assert.match(summarise(base, head), /Not generated on base\./);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(head, { recursive: true, force: true });
  }
});

test('a long diff is cut and says so', () => {
  const file = GENERATED_FILES[2];
  const lines = (n) => `${Array.from({ length: n }, (_, i) => `row ${i}`).join('\n')}\n`;
  const base = root({ ...same, [file]: lines(1) });
  const head = root({ ...same, [file]: lines(MAX_DIFF_LINES * 2) });
  try {
    assert.match(summarise(base, head), new RegExp(`Diff cut at ${MAX_DIFF_LINES} of \\d+ lines\\.`));
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(head, { recursive: true, force: true });
  }
});
