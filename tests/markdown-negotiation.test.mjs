import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  NEGOTIABLE_PAGE_MATCHER,
  hasCuratedSibling,
  markdownSiblingFor,
  prefersMarkdown,
} from '../src/lib/markdown-negotiation.mjs';

const middlewareSource = readFileSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)), 'utf8');
const vercelConfig = JSON.parse(
  readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8')
);

function matcherEntries() {
  const block = middlewareSource.match(/matcher:\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'middleware.ts must export a config.matcher array');
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test('a literal text/markdown token outranking html triggers negotiation', () => {
  assert.equal(prefersMarkdown('text/markdown'), true);
  assert.equal(prefersMarkdown('text/markdown, text/html;q=0.5'), true);
  assert.equal(prefersMarkdown('text/markdown;q=0.9, */*;q=0.1'), true);
});

test('a wildcard Accept never triggers markdown', () => {
  for (const header of ['*/*', 'text/*', 'text/html,application/xhtml+xml,*/*;q=0.8', null, '']) {
    assert.equal(prefersMarkdown(header), false, String(header));
  }
});

test('markdown must genuinely outrank html — ties and lower q favor html', () => {
  assert.equal(prefersMarkdown('text/markdown;q=0.5, text/html'), false);
  assert.equal(prefersMarkdown('text/markdown;q=1, text/html;q=1'), false);
  assert.equal(prefersMarkdown('text/markdown;q=0'), false);
});

test('every page path maps to the sibling URL its own path implies', () => {
  assert.equal(markdownSiblingFor('/'), '/index.md');
  assert.equal(markdownSiblingFor('/about'), '/about.md');
  assert.equal(markdownSiblingFor('/about/'), '/about.md');
  assert.equal(markdownSiblingFor('/writing/'), '/writing.md');
  assert.equal(markdownSiblingFor('/changelog/2'), '/changelog/2.md');
});

test('a curated route keeps precedence: an entry page maps onto its own .md.ts URL', () => {
  assert.equal(markdownSiblingFor('/writing/hello-world/'), '/writing/hello-world.md');
  assert.equal(hasCuratedSibling('/writing/hello-world.md'), true);
  assert.equal(hasCuratedSibling('/changelog/site-live.md'), true);
});

test('index pages and numeric changelog pagination convert like any other page', () => {
  // /writing.md and /changelog.md sit a level above the curated slug routes, so they never
  // collide with them; /changelog/2 is a pagination index, not an entry.
  assert.equal(hasCuratedSibling('/writing.md'), false);
  assert.equal(hasCuratedSibling('/changelog.md'), false);
  assert.equal(hasCuratedSibling('/changelog/2.md'), false);
});

test('a .md URL is never itself negotiable, so the proxy fetch cannot recurse', () => {
  assert.equal(markdownSiblingFor('/about.md'), null);
  assert.equal(markdownSiblingFor('/writing/hello-world.md'), null);
  assert.equal(markdownSiblingFor('/index.md'), null);
});

test('non-page routes map to no sibling', () => {
  for (const path of ['/llms.txt', '/rss.xml', '/sitemap-0.xml', '/webmcp/tools.json', '/favicon.ico']) {
    assert.equal(markdownSiblingFor(path), null, path);
  }
});

// A page path missing from the matcher never reaches the middleware, so it serves HTML
// forever and looks exactly like a page nobody negotiated with. Vercel reads the matcher
// statically, so the list cannot be imported — only diffed.
test('middleware.ts matches every negotiable page path', () => {
  const matcher = matcherEntries();
  for (const entry of NEGOTIABLE_PAGE_MATCHER) {
    assert.ok(matcher.includes(entry), `middleware.ts config.matcher is missing ${entry}`);
  }
});

test('every negotiable page path carries Vary: Accept in vercel.json', () => {
  const varyRules = vercelConfig.headers
    .filter((rule) => rule.headers.some((header) => header.key === 'Vary' && header.value === 'Accept'))
    .map((rule) => rule.source);

  // Section roots and the homepage are declared literally; subtree entries are covered by
  // the existing per-slug patterns, which are asserted separately below.
  for (const entry of NEGOTIABLE_PAGE_MATCHER) {
    if (entry.includes(':path*')) continue;
    assert.ok(varyRules.includes(entry), `vercel.json has no Vary: Accept rule for ${entry}`);
  }
  for (const section of ['writing', 'changelog']) {
    assert.ok(
      varyRules.includes(`/${section}/:slug([^/.]+)`),
      `vercel.json has no Vary: Accept rule for /${section} entry pages`
    );
  }
  for (const section of ['builds', 'webmcp', 'writing', 'changelog']) {
    assert.ok(varyRules.includes(`/${section}`) && varyRules.includes(`/${section}/`), section);
  }
});
