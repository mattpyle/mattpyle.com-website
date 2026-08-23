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
  for (const section of ['projects', 'webmcp', 'writing', 'changelog']) {
    assert.ok(varyRules.includes(`/${section}`) && varyRules.includes(`/${section}/`), section);
  }
});

// Every fixed-path negotiable page advertises its markdown variant in a Link header, so an agent
// learns the variant exists without spending a request to guess at it (RFC 8288; the steward fast
// audit's `link-headers` check is the acceptance). The value is asserted against markdownSiblingFor
// rather than against a second literal list: a header pointing at a sibling URL the middleware
// would not serve is worse than no header, and only deriving both from the same function can
// prevent it. The two entry-page families are absent on purpose — their sibling URL depends on the
// slug, which needs a captured parameter in the header value.
test('every fixed-path negotiable page advertises its markdown sibling in a Link header', () => {
  const linkRules = new Map(
    vercelConfig.headers
      .map((rule) => [rule.source, rule.headers.find((header) => header.key === 'Link')?.value])
      .filter(([, value]) => value)
  );

  for (const entry of NEGOTIABLE_PAGE_MATCHER) {
    if (entry.includes(':path*') || entry.includes(':slug')) continue;
    const value = linkRules.get(entry);
    assert.ok(value, `vercel.json has no Link header for ${entry}`);

    const sibling = markdownSiblingFor(entry);
    assert.ok(sibling, `${entry} maps to no markdown sibling`);
    assert.ok(
      value.includes(`<${sibling}>; rel="alternate"; type="text/markdown"`),
      `${entry} advertises the wrong alternate: ${value}`
    );
  }
});

// The homepage keeps the two rel values it already carried. The steward check only looks for an
// alternate, so a rewrite that dropped these would pass it while removing the site's own discovery
// pointers from the one page every agent arrives at.
test('the homepage Link header keeps its describedby and service-desc entries', () => {
  const home = vercelConfig.headers.find((rule) => rule.source === '/');
  const link = home.headers.find((header) => header.key === 'Link').value;
  for (const expected of [
    '</llms.txt>; rel="describedby"; type="text/markdown"',
    '</agents.md>; rel="describedby"; type="text/markdown"',
    '</.well-known/agent-card.json>; rel="service-desc"; type="application/a2a+json"',
    '</index.md>; rel="alternate"; type="text/markdown"',
  ]) {
    assert.ok(link.includes(expected), `homepage Link header lost ${expected}`);
  }
});
