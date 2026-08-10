import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter } from '../../src/lib/frontmatter.js';

// The whole point of the wrapper: gray-matter's `javascript` engine is eval(), and a `---js`
// delimiter reaches it. If this test ever goes green by returning a parsed object instead of
// throwing, the override stopped taking and the engine is live again.
test('a ---js frontmatter block throws rather than executing', () => {
  const raw = ['---js', 'module.exports = { title: globalThis.EVALUATED = true };', '---', '', 'Body.'].join('\n');

  assert.throws(() => parseFrontmatter(raw), /javascript frontmatter is not supported/);
  assert.equal(
    (globalThis as Record<string, unknown>).EVALUATED,
    undefined,
    'the block must not have run',
  );
});

// `lib/engine.js` aliases `js` and `javascript` to one engine, so the single override closes
// both delimiters. Asserted rather than assumed, since it is an alias table in a dependency.
test('a ---javascript frontmatter block throws too', () => {
  const raw = ['---javascript', 'module.exports = { title: "x" };', '---', '', 'Body.'].join('\n');

  assert.throws(() => parseFrontmatter(raw), /javascript frontmatter is not supported/);
});

test('ordinary YAML frontmatter still parses', () => {
  const raw = ['---', 'title: A post', 'draft: true', '---', '', 'Body.'].join('\n');
  const parsed = parseFrontmatter(raw);

  assert.equal(parsed.data.title, 'A post');
  assert.equal(parsed.data.draft, true);
  assert.equal(parsed.content.trim(), 'Body.');
});

// A file with no frontmatter at all is the common case in the corpus scans, and it must stay a
// silent pass rather than becoming a throw.
test('a file with no frontmatter parses to empty data', () => {
  const parsed = parseFrontmatter('# Just a heading\n\nProse.\n');

  assert.deepEqual(parsed.data, {});
  assert.match(parsed.content, /Just a heading/);
});
