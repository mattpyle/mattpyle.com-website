import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assertValidSlug, isValidSlug, postRelPath, urlPathFor } from '../../src/config.js';

/**
 * These tests exist because `agents/steward/CLAUDE.md` states the private-docs
 * guarantee as *architectural* — "every LLM-bound read resolves through
 * `postRelPath`, which hard-codes the content collections". Hard-coding the
 * prefix was never enough on its own: `path.join` normalises traversal away, so
 * an unvalidated slug walked straight out of the content directory and into the
 * files that must never reach an external API.
 */

test('real slugs are accepted', () => {
  for (const slug of ['hello-world', 'i-turned-on-a-screen-reader', 'astro-rebuild', 'webmcp-tools']) {
    assert.equal(isValidSlug(slug), true, slug);
  }
});

test('digits and hyphenated numerics are fine', () => {
  assert.equal(isValidSlug('post-2026-07'), true);
  assert.equal(isValidSlug('h2'), true);
});

const REJECTED = [
  '../../../steward/steward-spec', // the leak: resolves to a real private doc
  '../../../CLAUDE',
  '..',
  'a/b',
  'a\\b', // Windows separator — this repo runs on Windows
  '/etc/passwd',
  'hello-world.md', // extension already supplied by postRelPath
  'Hello-World', // case: would resolve differently per filesystem
  'hello_world',
  'hello world',
  'hello--world', // empty segment
  '-hello',
  'hello-',
  '',
];

for (const slug of REJECTED) {
  test(`rejects ${JSON.stringify(slug)}`, () => {
    assert.equal(isValidSlug(slug), false);
    assert.throws(() => assertValidSlug(slug), /Invalid slug/);
    assert.throws(() => postRelPath(slug), /Invalid slug/);
    assert.throws(() => urlPathFor(slug), /Invalid slug/);
  });
}

test('the traversal this closes really did escape the collection', () => {
  // Demonstrates the bug rather than asserting the fix in the abstract: the
  // unvalidated interpolation normalises to a private file outside src/content.
  const unguarded = `src/content/writing/${'../../../steward/steward-spec'}.md`;
  assert.equal(path.join(unguarded), path.join('steward/steward-spec.md'));
  assert.equal(unguarded.startsWith('src/content/'), true); // looks contained...
  assert.equal(path.join(unguarded).startsWith('src'), false); // ...but is not.

  // And is now unreachable through the documented choke point.
  assert.throws(() => postRelPath('../../../steward/steward-spec'), /Invalid slug/);
});

test('a valid slug still resolves inside its collection', () => {
  assert.equal(postRelPath('hello-world'), 'src/content/writing/hello-world.md');
  assert.equal(postRelPath('astro-rebuild', 'changelog'), 'src/content/changelog/astro-rebuild.md');
  assert.equal(urlPathFor('hello-world'), '/writing/hello-world/');
});
