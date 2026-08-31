/**
 * The three legal-YAML shapes the two hand-rolled frontmatter readers used to refuse, and the
 * constructs each one still refuses.
 *
 * The shapes come from a measured round trip through an off-the-shelf editor: it writes an
 * unquoted title, folds a long description into a `>-` block scalar, and expands an inline tag
 * array into a block sequence. All three are legal YAML, and all three broke `npm run build` and
 * `predev`. The matrix is not square: title quoting is writing-metadata.mjs's, and the block
 * scalar and the block sequence are content-frontmatter.mjs's.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFrontmatter } from '../scripts/lib/content-frontmatter.mjs';
import { readWritingMetadata } from '../scripts/lib/writing-metadata.mjs';

/** Read one post through the writing reader, in a directory of its own. */
function readOne(source, name = 'post.md') {
  const directory = mkdtempSync(join(tmpdir(), 'frontmatter-readers-'));
  try {
    writeFileSync(join(directory, name), source);
    return readWritingMetadata(directory).get(name.replace(/\.md$/, ''));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('writing-metadata reads a title in all three quotings', () => {
  const cases = [
    ['title: "Hello, World!"', 'Hello, World!'],
    ["title: 'Hello, World!'", 'Hello, World!'],
    ['title: Hello, World!', 'Hello, World!'],
    ['title: "She said \\"go\\""', 'She said "go"'],
    ["title: It''s here", "It''s here"],
    ["title: 'It''s here'", "It's here"],
    ['title: Hello  # a trailing comment', 'Hello'],
    ['title: C# and F#', 'C# and F#'],
  ];

  for (const [line, expected] of cases) {
    assert.equal(readOne(`---\n${line}\ndate: 2026-08-30\n---\n\nbody\n`).title, expected, line);
  }
});

test('writing-metadata still distinguishes an absent title from an unreadable one', () => {
  // undefined means "no title field". A field that is there but in a shape this reader cannot
  // read has to say so, because the one consumer that reads .title skips drafts, so an undefined
  // title on a draft used to surface only at publish.
  assert.equal(readOne('---\ndate: 2026-08-30\n---\n\nbody\n').title, undefined);

  for (const line of ['title: "unterminated', 'title:', 'title: >-', 'title: ["a"]']) {
    assert.throws(
      () => readOne(`---\n${line}\ndate: 2026-08-30\n---\n\nbody\n`),
      /"title" is present but this reader cannot read its value/,
      line
    );
  }
});

test('writing-metadata reads dates and drafts unchanged by the quoting change', () => {
  const entry = readOne('---\ntitle: Bare title\ndate: 2026-08-30\nupdated: "2026-08-31"\ndraft: true\n---\n\nbody\n');
  assert.deepEqual(entry, { draft: true, lastmod: '2026-08-31', title: 'Bare title', date: '2026-08-30' });
});

test('content-frontmatter parses a folded block scalar', () => {
  const data = parseFrontmatter(
    [
      '---',
      'title: Hello, World!',
      'description: >-',
      '  A description long enough that the editor folded it across two lines',
      '  rather than leaving it on one.',
      'date: 2026-08-30',
      '---',
      '',
      'body',
    ].join('\n'),
    'fixture'
  );

  assert.deepEqual(data, {
    title: 'Hello, World!',
    description:
      'A description long enough that the editor folded it across two lines rather than leaving it on one.',
    date: '2026-08-30',
  });
});

test('content-frontmatter parses every block scalar style and chomping indicator', () => {
  const scalar = (indicator) =>
    parseFrontmatter(`---\ntext: ${indicator}\n  one\n  two\n\n---\n`, 'fixture').text;

  assert.equal(scalar('>'), 'one two\n');
  assert.equal(scalar('>-'), 'one two');
  assert.equal(scalar('>+'), 'one two\n\n');
  assert.equal(scalar('|'), 'one\ntwo\n');
  assert.equal(scalar('|-'), 'one\ntwo');
  assert.equal(scalar('|+'), 'one\ntwo\n\n');

  // A blank line inside a folded scalar is a paragraph break, not a space.
  assert.equal(
    parseFrontmatter('---\ntext: >-\n  one\n\n  two\n---\n', 'fixture').text,
    'one\ntwo'
  );
});

test('content-frontmatter parses a block sequence, and the key after it', () => {
  const data = parseFrontmatter(
    [
      '---',
      'title: "Hello"',
      'tags:',
      '  - agents',
      '  - "temporal"',
      "  - 'tech'",
      'draft: false',
      '---',
      '',
      'body',
    ].join('\n'),
    'fixture'
  );

  assert.deepEqual(data, {
    title: 'Hello',
    tags: ['agents', 'temporal', 'tech'],
    draft: false,
  });
});

test('content-frontmatter reads the whole editor-written shape at once', () => {
  // All three shapes in one file, which is what a round trip through the editor produces.
  const data = parseFrontmatter(
    [
      '---',
      'title: Hello, World!',
      'tags:',
      '  - agents',
      '  - temporal',
      'draft: false',
      'description: >-',
      '  The frontmatter an editor writes, folded and expanded, which this reader',
      '  used to refuse.',
      'date: 2026-08-30',
      '---',
      '',
      'body',
    ].join('\n'),
    'fixture'
  );

  assert.deepEqual(data, {
    title: 'Hello, World!',
    tags: ['agents', 'temporal'],
    draft: false,
    description: 'The frontmatter an editor writes, folded and expanded, which this reader used to refuse.',
    date: '2026-08-30',
  });
});

test('content-frontmatter still refuses what it does not understand', () => {
  const cases = [
    ['---\nnested:\n  key: "value"\n---\n', /nested map/],
    ['---\ntext: |2\n  explicit indent\n---\n', /does not support/],
    ['---\ntags:\n  - one:\n      two: three\n---\n', /does not support|must be scalars/],
    ['---\ntags:\n  -\n---\n', /sequence item with no value/],
    ['---\nempty:\n---\n', /has no value/],
    ['---\nanchored: &name value\n---\n', /does not support/],
    ['---\nmap: {a: 1}\n---\n', /does not support/],
    ['---\ntags: ["a", "b"\n---\n', /unterminated inline array/],
  ];

  for (const [source, expected] of cases) {
    assert.throws(() => parseFrontmatter(source, 'fixture'), expected, `should have thrown: ${source}`);
  }
});

test('both readers name the file and the line in the message', () => {
  assert.throws(
    () => parseFrontmatter('---\ntitle: "ok"\nnested:\n  key: 1\n---\n', 'a-slug'),
    // The line named is the key that opened the block, not the indented line under it.
    /^Error: a-slug:2: /
  );
  assert.throws(() => readOne('---\ntitle:\ndate: 2026-08-30\n---\n', 'a-slug.md'), /^Error: a-slug\.md: /);
});
