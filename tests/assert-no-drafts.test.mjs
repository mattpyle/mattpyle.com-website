import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { draftSlugsIn, findLeaks, referenceRe } from '../scripts/assert-no-drafts.mjs';

/** A throwaway content dir, returned with a trailing separator the way the script passes them. */
function contentDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'assert-no-drafts-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return dir + sep;
}

function distWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'assert-no-drafts-dist-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return dir + sep;
}

const published = (title) => `---
title: "${title}"
date: 2026-07-20
---

Body.
`;

const draft = (title) => `---
title: "${title}"
date: 2026-07-20
draft: true
---

Body.
`;

test('a published post that quotes draft frontmatter is not treated as a draft', () => {
  // The bug this replaced: the old scan regexed the whole file, so a post that
  // *documented* frontmatter in a fenced block failed its own build. On a site
  // about frontmatter and agent standards, that post is likely rather than
  // hypothetical.
  const dir = contentDir({
    'writing-about-frontmatter.md': `---
title: "How draft frontmatter works"
date: 2026-07-20
---

To hide a post from the feeds, set the flag in its frontmatter:

\`\`\`yaml
---
title: "Not ready yet"
draft: true
---
\`\`\`

That keeps it out of RSS.
`,
  });

  assert.deepEqual(draftSlugsIn(dir), []);
});

test('a real draft is still detected', () => {
  const dir = contentDir({ 'not-ready.md': draft('Not ready') });
  assert.deepEqual(draftSlugsIn(dir), ['not-ready']);
});

test('drafts in subdirectories and .mdx files are detected', () => {
  // Both were invisible to the old non-recursive, .md-only scan — a nested draft
  // could reach the feeds with the check reporting success.
  const dir = contentDir({
    'series/part-one.md': draft('Part one'),
    'inline.mdx': draft('Inline'),
    'shipped.md': published('Shipped'),
  });

  assert.deepEqual(draftSlugsIn(dir).sort(), ['inline', 'series/part-one']);
});

test('a draft whose slug prefixes a published slug does not false-positive', () => {
  // draft `foo` vs published `foo-bar`: the old substring match failed the build
  // on the published post's own sitemap entry.
  const dir = contentDir({
    'foo.md': draft('Foo'),
    'foo-bar.md': published('Foo bar'),
  });
  const dist = distWith({
    'sitemap-0.xml': '<url><loc>https://www.mattpyle.com/writing/foo-bar/</loc></url>',
    'rss.xml': '<link>https://www.mattpyle.com/writing/foo-bar/</link>',
    'llms.txt': '- [Foo bar](https://www.mattpyle.com/writing/foo-bar/)',
  });

  const { failures, draftCount } = findLeaks({
    collections: [{ dir, segment: 'writing' }],
    dist,
  });

  assert.equal(draftCount, 1);
  assert.deepEqual(failures, []);
});

test('a genuine leak of that same draft is still caught', () => {
  const dir = contentDir({
    'foo.md': draft('Foo'),
    'foo-bar.md': published('Foo bar'),
  });
  const dist = distWith({
    'sitemap-0.xml': '<url><loc>https://www.mattpyle.com/writing/foo/</loc></url>',
    'rss.xml': '<link>https://www.mattpyle.com/writing/foo-bar/</link>',
  });

  const { failures } = findLeaks({ collections: [{ dir, segment: 'writing' }], dist });

  assert.deepEqual(failures, ['foo: referenced in dist/sitemap-0.xml']);
});

test('a rendered draft page fails, and SHOW_DRAFTS exempts only that check', () => {
  const dir = contentDir({ 'foo.md': draft('Foo') });
  const dist = distWith({
    'writing/foo/index.html': '<html></html>',
    'rss.xml': '<link>https://www.mattpyle.com/writing/foo/</link>',
  });
  const collections = [{ dir, segment: 'writing' }];

  assert.deepEqual(findLeaks({ collections, dist }).failures, [
    'foo: page rendered at dist/writing/foo/index.html',
    'foo: referenced in dist/rss.xml',
  ]);

  // The feed leak is never skippable — entries cached by other people's readers
  // cannot be recalled.
  assert.deepEqual(findLeaks({ collections, dist, showDrafts: true }).failures, [
    'foo: referenced in dist/rss.xml',
  ]);
});

test('referenceRe matches the whole slug and stops at a boundary', () => {
  const re = referenceRe('writing', 'foo');
  assert.equal(re.test('/writing/foo/'), true);
  assert.equal(re.test('/writing/foo.md'), true);
  assert.equal(re.test('<loc>https://x/writing/foo</loc>'), true);
  assert.equal(re.test('/writing/foo-bar/'), false);
  assert.equal(re.test('/writing/foobar/'), false);
});

test('referenceRe treats a dotted slug literally rather than as a wildcard', () => {
  const re = referenceRe('writing', 'a.b');
  assert.equal(re.test('/writing/a.b/'), true);
  assert.equal(re.test('/writing/axb/'), false);
});
