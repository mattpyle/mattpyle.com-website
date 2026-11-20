import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLACEHOLDER_MARKER,
  findPlaceholders,
  findPublishedPlaceholders,
} from '../scripts/lib/placeholders.mjs';
import { scaffoldSource } from '../scripts/new-post.mjs';

/** A throwaway site root with one writing collection. */
function siteWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'placeholders-'));
  const directory = join(root, 'src', 'content', 'writing');
  for (const [name, body] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return { root, directories: [directory] };
}

const post = ({ draft = false, description = '"A real description."', body = 'Body.\n' } = {}) => `---
title: "A post"
date: 2026-07-20
description: ${description}
tags: []
${draft ? 'draft: true\n' : ''}---

${body}`;

const scaffold = scaffoldSource({ title: 'A "quoted" title', date: '2026-07-20' });
const published = (source) => source.replace(/^draft: true\n/m, '');

test('the scaffold writes the marker the guard looks for, in both spots', () => {
  assert.equal(PLACEHOLDER_MARKER, 'REPLACE:');
  assert.deepEqual(findPlaceholders(scaffold), [
    { line: 4, what: 'description' },
    { line: 9, what: 'the body' },
  ]);
});

test("the scaffold's real output passes as a draft and fails once published", () => {
  assert.match(scaffold, /^draft: true$/m);
  assert.deepEqual(findPublishedPlaceholders(siteWith({ 'fresh.md': scaffold })), []);

  assert.deepEqual(findPublishedPlaceholders(siteWith({ 'fresh.md': published(scaffold) })), [
    'src/content/writing/fresh.md:4: description still holds the scaffold placeholder "REPLACE:". Write the description, or set draft: true.',
    'src/content/writing/fresh.md:8: the body still holds the scaffold placeholder "REPLACE:". Delete the comment, or set draft: true.',
  ]);
});

test('a published post with only one placeholder left still fails, on that line', () => {
  const failures = findPublishedPlaceholders(siteWith({
    'nested/half.mdx': post({ body: 'Intro.\n\n<!-- REPLACE: delete this comment. -->\n' }),
  }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^src\/content\/writing\/nested\/half\.mdx:10: the body /);
});

test('every quoting of a frontmatter value is caught', () => {
  for (const description of ['"REPLACE: x"', "'REPLACE: x'", '>-\n  REPLACE: x']) {
    const found = findPlaceholders(post({ description }));
    assert.equal(found.length, 1, description);
    assert.equal(found[0].what, 'description', description);
  }
});

test('the word in prose, in inline code and in a fenced block is content', () => {
  const body = [
    'REPLACE: this sentence opens with the marker and is prose.',
    '',
    'You must REPLACE the description; the scaffold marks it `<!-- REPLACE: delete this comment. -->`.',
    '',
    '```md',
    '---',
    'description: "REPLACE: one to two sentences."',
    '---',
    '',
    '<!-- REPLACE: delete this comment. -->',
    '```',
    '',
    '~~~~',
    '<!-- REPLACE: in a tilde fence -->',
    '```',
    '<!-- REPLACE: still inside, a shorter fence of another kind does not close it -->',
    '~~~~',
    '',
    '<!-- a comment that says REPLACE: later on is not the scaffold form -->',
    '',
  ].join('\n');
  const source = post({ description: '"How to REPLACE: a guide."', body });

  assert.deepEqual(findPlaceholders(source), []);
  assert.deepEqual(findPublishedPlaceholders(siteWith({ 'documents-the-scaffold.md': source })), []);
});

test('a comment after a closed fence is caught again', () => {
  const body = '```\ncode\n```\n\n<!-- REPLACE: delete this comment. -->\n';
  assert.deepEqual(findPlaceholders(post({ body })), [{ line: 12, what: 'the body' }]);
});

test('the preflight passes on this repository, and SHOW_DRAFTS does not change a draft exemption', () => {
  const script = fileURLToPath(new URL('../scripts/validate-placeholders.mjs', import.meta.url));
  for (const SHOW_DRAFTS of ['true', '']) {
    const out = execFileSync(process.execPath, [script], { env: { ...process.env, SHOW_DRAFTS }, encoding: 'utf8' });
    assert.match(out, /no published writing or changelog entry holds a scaffold placeholder/);
  }
});

test('prebuild runs the preflight and predev does not', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(scripts.prebuild, /validate-placeholders\.mjs/);
  assert.doesNotMatch(scripts.predev, /validate-placeholders\.mjs/);
});

test('new-post.mjs still refuses a missing title when run, and does nothing when imported', () => {
  const script = fileURLToPath(new URL('../scripts/new-post.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Usage: npm run new-post/);
});
