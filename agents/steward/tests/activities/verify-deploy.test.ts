import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyDeploy, buildVerificationPlan } from '../../src/activities/verify-deploy.js';
import type { Collection } from '../../src/config.js';

/**
 * `verifyDeploy` against a local mock origin (spec §11).
 *
 * The mock serves a *correct* site by default and each test breaks exactly one
 * thing, so a failing row is always attributable. Every row of the matrix gets a
 * failure case, and the matrix is exercised **per collection** — the two differ,
 * and the difference is load-bearing (see the RSS tests at the bottom).
 */

const TITLE = 'A Post About Things';

interface SiteOptions {
  collection: Collection;
  slug: string;
  /** Break exactly one thing. */
  break?:
    | 'html-404'
    | 'html-wrong-title'
    | 'html-wrong-content-type'
    | 'no-vary'
    | 'negotiation-ignored'
    | 'md-404'
    | 'llms-missing-slug'
    | 'sitemap-missing-url'
    | 'sitemap-index-404'
    | 'og-404'
    | 'og-wrong-type'
    | 'rss-missing-slug';
}

/** Spins a mock origin and returns its base URL plus a close function. */
async function mockSite(opts: SiteOptions): Promise<{ origin: string; close: () => Promise<void> }> {
  const { collection, slug } = opts;
  const canonical = `/${collection}/${slug}/`;
  const mdPath = `/${collection}/${slug}.md`;
  const ogPath = `/og/${collection}/${slug}.png`;
  const markdown = `---\ntitle: "${TITLE}"\n---\n\nBody.\n`;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const accept = (req.headers.accept ?? '').toString();
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };

    if (url === canonical) {
      if (opts.break === 'html-404') return send(404, 'text/html', 'nope');
      // The negotiated markdown variant, as middleware.ts implements it.
      if (/text\/markdown/.test(accept) && opts.break !== 'negotiation-ignored') {
        const headers: Record<string, string> = opts.break === 'no-vary' ? {} : { vary: 'Accept' };
        return send(200, 'text/markdown', markdown, headers);
      }
      const headers: Record<string, string> = opts.break === 'no-vary' ? {} : { vary: 'Accept' };
      const type = opts.break === 'html-wrong-content-type' ? 'text/plain' : 'text/html';
      const title = opts.break === 'html-wrong-title' ? 'A Completely Different Post' : TITLE;
      return send(200, type, `<!doctype html><h1>${title}</h1>`, headers);
    }

    if (url === mdPath) {
      if (opts.break === 'md-404') return send(404, 'text/plain', 'nope');
      return send(200, 'text/markdown', markdown);
    }

    if (url === '/llms.txt') {
      return send(200, 'text/plain', opts.break === 'llms-missing-slug' ? 'nothing here' : `- ${slug}`);
    }

    if (url === '/rss.xml') {
      return send(200, 'application/xml', opts.break === 'rss-missing-slug' ? '<rss/>' : `<rss>${slug}</rss>`);
    }

    if (url === '/sitemap-index.xml') {
      if (opts.break === 'sitemap-index-404') return send(404, 'application/xml', '');
      return send(200, 'application/xml', `<sitemapindex><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap></sitemapindex>`);
    }

    if (url === '/sitemap-0.xml') {
      const loc = opts.break === 'sitemap-missing-url' ? `${origin}/something-else/` : `${origin}${canonical}`;
      return send(200, 'application/xml', `<urlset><url><loc>${loc}</loc></url></urlset>`);
    }

    if (url === ogPath) {
      if (opts.break === 'og-404') return send(404, 'text/plain', '');
      const type = opts.break === 'og-wrong-type' ? 'text/html' : 'image/png';
      return send(200, type, 'PNG');
    }

    send(404, 'text/plain', 'not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function run(opts: SiteOptions) {
  const site = await mockSite(opts);
  try {
    return await verifyDeploy({
      slug: opts.slug,
      collection: opts.collection,
      title: TITLE,
      origin: site.origin,
    });
  } finally {
    await site.close();
  }
}

function failed(result: Awaited<ReturnType<typeof run>>): string[] {
  return result.verification.filter((r) => !r.ok).map((r) => r.check);
}

// ---------------------------------------------------------------------------
// The happy path, per collection.
// ---------------------------------------------------------------------------

test('a correct writing deploy passes every row', async () => {
  const result = await run({ collection: 'writing', slug: 'a-post' });
  assert.equal(result.deployVerified, true, JSON.stringify(result.verification, null, 2));
  assert.deepEqual(
    result.verification.map((r) => r.check).sort(),
    ['html', 'llms.txt', 'markdown-direct', 'markdown-negotiated', 'og-image', 'rss', 'sitemap'],
  );
});

test('a correct changelog deploy passes every row', async () => {
  const result = await run({ collection: 'changelog', slug: 'an-entry' });
  assert.equal(result.deployVerified, true, JSON.stringify(result.verification, null, 2));
});

// ---------------------------------------------------------------------------
// THE RSS RULE — the row that differs by collection.
//
// `src/pages/rss.xml.ts` calls `getCollection('writing')` only. Asserting RSS
// for a changelog entry would fail forever and *correctly*, which is exactly
// what makes it dangerous: the workflow's retry loop would sleep and re-check
// ten times against a condition the site will never satisfy, then park claiming
// the deploy had not propagated. A permanently-failing check masquerades as a
// transient one.
// ---------------------------------------------------------------------------

test('the RSS row is present for writing and absent for changelog', () => {
  const writing = buildVerificationPlan('a-post', 'writing', 'https://x', TITLE).map((c) => c.check);
  const changelog = buildVerificationPlan('an-entry', 'changelog', 'https://x', TITLE).map((c) => c.check);

  assert.ok(writing.includes('rss'), 'writing posts are in the feed');
  assert.ok(!changelog.includes('rss'), 'changelog entries are absent from /rss.xml by design');
  // Every other row is shared, so the plans differ by exactly one check.
  assert.deepEqual(
    writing.filter((c) => c !== 'rss').sort(),
    changelog.slice().sort(),
  );
});

test('a changelog entry verifies even when /rss.xml never mentions it', async () => {
  // The mock is told to omit the slug from RSS. For a changelog entry this is
  // the site behaving correctly, and the deploy must still verify.
  const result = await run({ collection: 'changelog', slug: 'an-entry', break: 'rss-missing-slug' });
  assert.equal(result.deployVerified, true, 'changelog must not be gated on the writing feed');
});

test('a writing post fails when the slug is missing from /rss.xml', async () => {
  const result = await run({ collection: 'writing', slug: 'a-post', break: 'rss-missing-slug' });
  assert.equal(result.deployVerified, false);
  assert.deepEqual(failed(result), ['rss']);
});

// ---------------------------------------------------------------------------
// One failure case per remaining row, run against BOTH collections.
// ---------------------------------------------------------------------------

const ROW_FAILURES: { name: SiteOptions['break']; expects: string }[] = [
  { name: 'html-404', expects: 'html' },
  { name: 'html-wrong-title', expects: 'html' },
  { name: 'html-wrong-content-type', expects: 'html' },
  { name: 'negotiation-ignored', expects: 'markdown-negotiated' },
  { name: 'md-404', expects: 'markdown-direct' },
  { name: 'llms-missing-slug', expects: 'llms.txt' },
  { name: 'sitemap-missing-url', expects: 'sitemap' },
  { name: 'sitemap-index-404', expects: 'sitemap' },
  { name: 'og-404', expects: 'og-image' },
  { name: 'og-wrong-type', expects: 'og-image' },
];

for (const collection of ['writing', 'changelog'] as const) {
  for (const { name, expects } of ROW_FAILURES) {
    test(`${collection}: "${name}" fails the ${expects} row`, async () => {
      const result = await run({ collection, slug: 'a-slug', break: name });
      assert.equal(result.deployVerified, false);
      assert.ok(
        failed(result).includes(expects),
        `expected ${expects} to fail, got: ${failed(result).join(', ')}`,
      );
    });
  }

  test(`${collection}: a missing Vary: Accept fails the negotiated-markdown row`, async () => {
    // Both collections have a `Vary: Accept` rule in vercel.json. Without it the
    // edge cache will serve HTML and markdown interchangeably for one URL, which
    // is a correctness bug that no status code reveals.
    const result = await run({ collection, slug: 'a-slug', break: 'no-vary' });
    assert.equal(result.deployVerified, false);
    assert.ok(failed(result).includes('markdown-negotiated'));
    const row = result.verification.find((r) => r.check === 'markdown-negotiated')!;
    assert.match(row.detail, /Vary/);
  });
}

// ---------------------------------------------------------------------------

test('an unreachable origin produces failed rows, not a thrown activity', async () => {
  // A site mid-deploy refuses connections. That is the expected state while
  // waiting for a merge, so it must be data for the retry loop rather than an
  // activity failure.
  const result = await verifyDeploy({
    slug: 'a-post',
    collection: 'writing',
    title: TITLE,
    // Reserved-for-documentation port that nothing listens on.
    origin: 'http://127.0.0.1:1',
  });
  assert.equal(result.deployVerified, false);
  assert.equal(failed(result).length, result.verification.length, 'every row should fail');
  assert.ok(result.verification.every((r) => /request failed/.test(r.detail)));
});
