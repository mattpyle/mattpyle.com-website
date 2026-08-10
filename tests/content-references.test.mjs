import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findBrokenContentReferences } from '../scripts/lib/content-references.mjs';

/**
 * Each case builds a miniature repo in a temp directory: an `assets/` folder and a `content/`
 * collection beside it, with the same `../../assets/…` shape the real entries use.
 */
function fixture(entries, assets = ['tech-stack.png']) {
  const root = mkdtempSync(join(tmpdir(), 'content-refs-'));
  const contentRoot = join(root, 'src', 'content', 'changelog');
  mkdirSync(contentRoot, { recursive: true });
  mkdirSync(join(root, 'src', 'assets'), { recursive: true });

  for (const asset of assets) writeFileSync(join(root, 'src', 'assets', asset), '');
  for (const [name, body] of Object.entries(entries)) writeFileSync(join(contentRoot, name), body);

  return { root, contentRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const entry = (hero) => `---\ntitle: "A change"\ndate: 2026-08-09\nhero: ${hero}\n---\n\nBody.\n`;

test('a resolvable relative path passes', () => {
  const { root, contentRoot, cleanup } = fixture({ 'ok.md': entry('../../assets/tech-stack.png') });
  try {
    assert.deepEqual(findBrokenContentReferences({ root, contentRoot }), []);
  } finally {
    cleanup();
  }
});

test('a missing file names the entry, the field, the value and where it looked', () => {
  const { root, contentRoot, cleanup } = fixture({ 'typo.md': entry('../../assets/tech-stak.png') });
  try {
    const [failure, ...rest] = findBrokenContentReferences({ root, contentRoot });
    assert.equal(rest.length, 0);
    assert.match(failure, /src\/content\/changelog\/typo\.md:4/);
    assert.match(failure, /hero: \.\.\/\.\.\/assets\/tech-stak\.png/);
    assert.match(failure, /no such file/);
    assert.match(failure, /src\/assets\/tech-stak\.png/);
  } finally {
    cleanup();
  }
});

test('a path that differs only in case is a failure, not a pass', () => {
  // The bug this exists for: correct on Windows, broken on the Linux builder.
  const { root, contentRoot, cleanup } = fixture({ 'case.md': entry('../../assets/Tech-Stack.png') });
  try {
    const [failure, ...rest] = findBrokenContentReferences({ root, contentRoot });
    assert.equal(rest.length, 0);
    assert.match(failure, /wrong case/);
    assert.match(failure, /src\/assets\/tech-stack\.png/);
  } finally {
    cleanup();
  }
});

test('quoted values are checked, and non-relative values are left alone', () => {
  const { root, contentRoot, cleanup } = fixture({
    'quoted.md': entry('"../../assets/tech-stak.png"'),
    'absolute.md': `---\ntitle: "Other shapes"\nimage: /og/writing/whatever.png\nsite: https://example.com/x.png\nplain: not-a-path\n---\n`,
  });
  try {
    const failures = findBrokenContentReferences({ root, contentRoot });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /quoted\.md/);
  } finally {
    cleanup();
  }
});

test('a path running through a file reports cleanly instead of throwing ENOTDIR', () => {
  const { root, contentRoot, cleanup } = fixture({
    'through.md': entry('../../assets/tech-stack.png/nested.png'),
  });
  try {
    const [failure, ...rest] = findBrokenContentReferences({ root, contentRoot });
    assert.equal(rest.length, 0);
    assert.match(failure, /no such file/);
  } finally {
    cleanup();
  }
});

test('the reported line survives a blank line opening the frontmatter', () => {
  const { root, contentRoot, cleanup } = fixture({
    'blank.md': `---\n\ntitle: "A change"\nhero: ../../assets/tech-stak.png\n---\n`,
  });
  try {
    assert.match(findBrokenContentReferences({ root, contentRoot })[0], /blank\.md:4/);
  } finally {
    cleanup();
  }
});

test('a hash inside a value is part of the path, not a comment', () => {
  // YAML starts a comment at ` #`, not at any `#`. Truncating at the wrong one would invent a
  // failure for a legitimate filename.
  const { root, contentRoot, cleanup } = fixture(
    { 'hash.md': entry('../../assets/plate#2.png') },
    ['plate#2.png']
  );
  try {
    assert.deepEqual(findBrokenContentReferences({ root, contentRoot }), []);
  } finally {
    cleanup();
  }
});

test('every bad reference is reported, not just the first', () => {
  const { root, contentRoot, cleanup } = fixture({
    'one.md': entry('../../assets/missing-one.png'),
    'two.md': entry('../../assets/missing-two.png'),
  });
  try {
    assert.equal(findBrokenContentReferences({ root, contentRoot }).length, 2);
  } finally {
    cleanup();
  }
});

test('the real content tree is clean', () => {
  // The check the build runs, run here too, so a broken reference fails `npm test` as well.
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.deepEqual(
    findBrokenContentReferences({ root, contentRoot: join(root, 'src', 'content') }),
    []
  );
});
