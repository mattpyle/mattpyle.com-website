import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareChangelogEntries } from '../src/lib/changelog-order.ts';
import { parseFrontmatter } from '../scripts/lib/content-frontmatter.mjs';
import { buildDigest } from '../scripts/generate-a2a-digest.mjs';
import { PRODUCTION_ORIGIN } from '../src/data/site-origin.mjs';
import { siteSections } from '../src/data/site-sections.mjs';

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/data/a2a-digest.json', import.meta.url)), 'utf8')
);

test('the committed digest matches what the generator produces', () => {
  // The digest is committed so a reviewer can see what an agent will be told. That only means
  // anything if the two cannot diverge, which is what this asserts: forget to re-run prebuild
  // after adding a post and this fails rather than shipping a responder that has not heard of it.
  assert.deepEqual(committed, buildDigest());
});

test('the digest carries the site description and the full section map', () => {
  assert.equal(committed.site.url, `${PRODUCTION_ORIGIN}/`);
  assert.match(committed.site.description, /Director of Growth at Temporal/);
  assert.deepEqual(committed.site.sections, siteSections(PRODUCTION_ORIGIN));
  assert.deepEqual(
    committed.site.sections.map((section) => section.name),
    ['Home', 'Writing', 'Builds', 'Changelog', 'Scorecard', 'About']
  );
});

test('the digest carries at least one current published post, with a usable URL', () => {
  assert.ok(committed.writing.length >= 1, 'expected at least one published article');

  const [newest] = committed.writing;
  assert.ok(newest.title);
  assert.equal(newest.url, `${PRODUCTION_ORIGIN}/writing/${newest.url.split('/').pop()}`);
  assert.equal(newest.markdownUrl, `${newest.url}.md`);
  assert.ok(newest.description);
  assert.ok(!Number.isNaN(Date.parse(newest.date)));

  // Newest first, which is the order the reply presents them in.
  const dates = committed.writing.map((article) => Date.parse(article.date));
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
});

test('drafts never reach the digest', () => {
  // src/content/writing/steward-smoke-test.md is a permanent draft fixture, so this is a live
  // check rather than a hypothetical: draft: true has to keep a post off every public surface,
  // and A2A is now one of them.
  assert.equal(
    committed.writing.some((article) => article.url.endsWith('/steward-smoke-test')),
    false
  );
  assert.equal(committed.counts.writing, committed.writing.length);
});

test('the digest changelog is in the same order the site publishes', () => {
  // scripts/generate-a2a-digest.mjs transcribes compareChangelogEntries because it cannot import
  // TypeScript under the Node the build targets. This runs the real comparator over the same
  // entries and asserts the transcription still agrees with it.
  const entries = committed.changelog.map((entry) => ({
    id: entry.slug,
    data: {
      title: entry.title,
      date: new Date(entry.date),
      ...(entry.publishedAt ? { publishedAt: new Date(entry.publishedAt) } : {}),
      type: entry.type,
      significance: entry.significance,
    },
  }));

  assert.deepEqual(
    [...entries].sort(compareChangelogEntries).map((entry) => entry.id),
    entries.map((entry) => entry.id)
  );
});

test('the digest lists the agent surfaces, including both A2A ones', () => {
  const urls = committed.surfaces.map((surface) => surface.url);
  assert.ok(urls.includes(`${PRODUCTION_ORIGIN}/.well-known/agent-card.json`));
  assert.ok(urls.includes(`${PRODUCTION_ORIGIN}/a2a`));
  assert.ok(urls.includes(`${PRODUCTION_ORIGIN}/agents.md`));
  assert.ok(urls.includes(`${PRODUCTION_ORIGIN}/llms.txt`));
  for (const surface of committed.surfaces) {
    assert.ok(surface.name && surface.description, `surface ${surface.url} is missing prose`);
  }
});

test('counts describe the truncation rather than hiding it', () => {
  assert.equal(committed.counts.changelogListed, committed.changelog.length);
  assert.ok(committed.counts.changelog >= committed.counts.changelogListed);
});

test('the frontmatter reader throws on anything it does not understand', () => {
  // The reader exists to fail the build rather than silently drop a field; these are the shapes
  // it deliberately refuses.
  const cases = [
    ['---\ntitle: "ok"\nbody: |\n  block scalar\n---\n', /block scalar/],
    ['---\ntitle: "ok"\nnested:\n  key: "value"\n---\n', /no value|nested maps/],
    ['---\ntitle: "ok"\ntags:\n  - one\n---\n', /no value|nested maps/],
    ['---\ntitle: A title: with a colon\n---\n', /quote it/],
    ['no frontmatter at all\n', /no frontmatter/],
  ];
  for (const [source, expected] of cases) {
    assert.throws(() => parseFrontmatter(source, 'fixture'), expected, `should have thrown: ${source}`);
  }
});

test('the frontmatter reader handles the shapes the content actually uses', () => {
  const data = parseFrontmatter(
    [
      '---',
      'title: "Hello, \\"World\\"!"',
      'date: 2026-07-18',
      'publishedAt: 2026-08-02T22:45:00-07:00',
      'tags: ["agents", "temporal"]',
      'empty: []',
      'draft: false',
      'type: feature',
      'hero: ../../assets/retro-mode.png',
      '# a comment',
      '---',
      '',
      'body',
    ].join('\n'),
    'fixture'
  );

  assert.deepEqual(data, {
    title: 'Hello, "World"!',
    date: '2026-07-18',
    publishedAt: '2026-08-02T22:45:00-07:00',
    tags: ['agents', 'temporal'],
    empty: [],
    draft: false,
    type: 'feature',
    hero: '../../assets/retro-mode.png',
  });
});
