import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RETIRED_SECTIONS, RETIRED_URL_MATCHER, retiredUrlRedirect } from '../src/lib/retired-urls.mjs';
import { NEGOTIABLE_PAGE_MATCHER } from '../src/lib/markdown-negotiation.mjs';

// /builds became /projects on 2026-08-20. These tests are mostly about the paths the rule must
// NOT rewrite, because it runs in front of every page on the site and a false positive is a
// redirect to a URL that does not exist.

const middlewareSource = readFileSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)), 'utf8');

function matcherEntries() {
  const block = middlewareSource.match(/matcher:\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'middleware.ts must export a config.matcher array');
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test('every shape a retired section URL arrives in redirects to the same shape', () => {
  const cases = [
    ['/builds', '/projects/'],
    ['/builds/', '/projects/'],
    ['/builds.md', '/projects.md'],
    ['/builds/anything', '/projects/anything'],
    ['/builds/anything/', '/projects/anything/'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(retiredUrlRedirect(input), expected, input);
  }
});

test('a live path is left alone', () => {
  // A false positive here is a 301 to a URL that does not exist, on a page that works today.
  const live = [
    '/',
    '/projects',
    '/projects/',
    '/projects.md',
    '/about/',
    '/writing/accessibility-and-ai/',
    '/llms.txt',
    '/.well-known/agent-card.json',
    '/a2a',
    '/mcp',
  ];
  for (const path of live) {
    assert.equal(retiredUrlRedirect(path), null, path);
  }
});

test('a retired root never collides with a live one', () => {
  // The whole point of the rename is that the new root is live, so a map that pointed a section
  // at itself would be an infinite redirect on the section that replaced it.
  for (const [from, to] of Object.entries(RETIRED_SECTIONS)) {
    assert.notEqual(from, to);
    assert.equal(retiredUrlRedirect(to), null, `${to} is live and must not redirect`);
  }
});

// An old URL that never reaches the function 404s at the routing layer instead of 301ing, and
// the failure is invisible from anything the middleware itself exports.
test('middleware.ts matches every retired URL shape', () => {
  const matcher = matcherEntries();
  for (const entry of RETIRED_URL_MATCHER) {
    assert.ok(matcher.includes(entry), `middleware.ts config.matcher is missing ${entry}`);
  }
});

test('a retired root is no longer a negotiable page path', () => {
  // The two lists would contradict each other: negotiation would try to serve a section that
  // has moved. The redirect branch runs first, so the page list is the one that has to be clean.
  for (const from of Object.keys(RETIRED_SECTIONS)) {
    assert.ok(
      !NEGOTIABLE_PAGE_MATCHER.includes(`${from}/:path*`),
      `${from} is retired and must not be a negotiable page path`
    );
  }
});

// Ordering, asserted against the source: negotiation derives a `.md` sibling from the request
// path, so a retired URL that reached it would proxy to a sibling that no longer exists and fall
// back to HTML — a 404 — instead of redirecting.
test('the redirect runs before the markdown negotiation branch', () => {
  const redirect = middlewareSource.indexOf('retiredUrlRedirect(url.pathname)');
  const negotiation = middlewareSource.indexOf('prefersMarkdown(accept)');
  assert.ok(redirect > 0, 'the middleware must call retiredUrlRedirect');
  assert.ok(negotiation > redirect, 'a retired URL must redirect before negotiation sees it');
});
