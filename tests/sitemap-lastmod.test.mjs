import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const policy = await import('../src/data/sitemap-lastmod.mjs').catch(() => null);
const metadata = await import('../scripts/lib/writing-metadata.mjs').catch(() => null);

test('sitemap policy modules are available', () => {
  assert.ok(policy, 'expected src/data/sitemap-lastmod.mjs to exist');
  assert.ok(metadata, 'expected scripts/lib/writing-metadata.mjs to exist');
});

test('latestDate returns the newest valid calendar date', { skip: !policy }, () => {
  assert.equal(policy.latestDate('2026-07-13', '2026-07-15', undefined), '2026-07-15');
  assert.throws(() => policy.latestDate('15 July 2026'), /YYYY-MM-DD/);
  assert.throws(() => policy.latestDate('2026-02-30'), /valid calendar date/);
});

test('static routes resolve against the site-wide significant-change date', { skip: !policy }, () => {
  assert.equal(policy.resolveStaticLastmod('/about/'), '2026-07-15');
  assert.equal(policy.resolveStaticLastmod('/missing/'), undefined);
});

test('scorecard verification label is derived from the shared ISO date', { skip: !policy }, () => {
  assert.deepEqual(policy.SCORECARD_VERIFIED, {
    iso: '2026-07-15',
    label: '15 Jul 2026',
  });
});

test('writing metadata uses updated over date and discovers nested MDX', { skip: !metadata }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'writing-metadata-'));
  try {
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'post.md'), '---\ntitle: "Post"\ndate: 2026-07-10\nupdated: 2026-07-14\ndraft: false\n---\n');
    writeFileSync(join(directory, 'nested', 'draft.mdx'), '---\ndate: "2026-07-12" # authored date\ndraft: true # keep private\n---\n');

    const entries = metadata.readWritingMetadata(directory);

    assert.deepEqual(entries.get('post'), { draft: false, lastmod: '2026-07-14', title: 'Post', date: '2026-07-10' });
    assert.deepEqual(entries.get('nested/draft'), { draft: true, lastmod: '2026-07-12', title: undefined, date: '2026-07-12' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('writing metadata unescapes quoted title strings', { skip: !metadata }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'writing-metadata-'));
  try {
    writeFileSync(join(directory, 'quoted.md'), '---\ntitle: "She said \\"hi\\""\ndate: 2026-07-10\ndraft: false\n---\n');
    const entries = metadata.readWritingMetadata(directory);
    assert.equal(entries.get('quoted').title, 'She said "hi"');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('published writing without a date is rejected', { skip: !metadata }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'writing-metadata-'));
  try {
    writeFileSync(join(directory, 'undated.md'), '---\ntitle: Undated\ndraft: false\n---\n');
    assert.throws(() => metadata.readWritingMetadata(directory), /undated\.md.*date/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sitemap resolver covers static, index, published, draft, and unknown routes', { skip: !policy }, () => {
  const writing = new Map([
    ['older', { draft: false, lastmod: '2026-07-13' }],
    ['newer', { draft: false, lastmod: '2026-07-16' }],
    ['draft', { draft: true, lastmod: '2026-07-20' }],
  ]);

  assert.equal(policy.resolveSitemapLastmod('/', writing), '2026-07-15');
  assert.equal(policy.resolveSitemapLastmod('/writing/', writing), '2026-07-16');
  assert.equal(policy.resolveSitemapLastmod('/writing/older/', writing), '2026-07-15');
  assert.equal(policy.resolveSitemapLastmod('/writing/draft/', writing), undefined);
  assert.equal(policy.resolveSitemapLastmod('/new-page/', writing), undefined);
});
