import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ON_DEMAND_PATHS, canonicalOnDemandPath } from '../src/lib/on-demand-routes.mjs';
import { trailingSlashRedirectFor } from '../src/lib/trailing-slash.mjs';

// Query-string canonicalisation on the routes that render per request. The rule is narrow on
// purpose and the tests below are mostly about the paths it must NOT touch: a redirect that
// escaped its three paths would strip utm parameters off every inbound link on the site.

const middlewareSource = readFileSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)), 'utf8');

function matcherEntries() {
  const block = middlewareSource.match(/matcher:\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'middleware.ts must export a config.matcher array');
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test('a query string on an on-demand path canonicalises to the fully canonical path', () => {
  // Slash form included, so the hop lands on the canonical URL rather than on a path that
  // immediately owes a second 308 to trailing-slash normalisation. One hop, always.
  const expected = {
    '/scorecard': '/scorecard/',
    '/scorecard/': '/scorecard/',
    '/scorecard.md': '/scorecard.md',
  };
  for (const path of ON_DEMAND_PATHS) {
    assert.equal(canonicalOnDemandPath(path, '?q=abc'), expected[path], path);
  }
});

test('canonicalisation never returns a target that would redirect again', () => {
  // The chain guard, stated as a property rather than a table: whatever this returns must be a
  // fixed point of both rules, or a cache-busting request costs two round trips.
  for (const path of ON_DEMAND_PATHS) {
    const target = canonicalOnDemandPath(path, '?q=abc');
    assert.equal(trailingSlashRedirectFor(target), null, `${path} -> ${target} redirects again`);
    assert.equal(canonicalOnDemandPath(target, ''), null, `${path} -> ${target} canonicalises again`);
  }
});

test('the same path without a query string is left alone', () => {
  for (const path of ON_DEMAND_PATHS) {
    assert.equal(canonicalOnDemandPath(path, ''), null, path);
  }
});

test('no other path is canonicalised, however it is dressed up', () => {
  // The prerendered pages already ignore the query string in their cache key, so redirecting them
  // would buy nothing and cost every utm parameter on the site.
  const untouched = [
    '/',
    '/about/',
    '/writing/accessibility-and-ai/',
    '/llms.txt',
    '/scorecard/history',
    '/scorecard.txt',
    '/SCORECARD',
  ];
  for (const path of untouched) {
    assert.equal(canonicalOnDemandPath(path, '?utm_source=newsletter'), null, path);
  }
});

// A path missing from the matcher never reaches the middleware, so the redirect never fires and
// the route stays cache-bustable — the exact failure this change exists to close. Vercel reads the
// matcher statically, so the list cannot be imported, only diffed.
test('middleware.ts matches every on-demand path', () => {
  const matcher = matcherEntries();
  for (const path of ON_DEMAND_PATHS) {
    assert.ok(matcher.includes(path), `middleware.ts config.matcher is missing ${path}`);
  }
});

test('the redirect branch runs before anything that counts a hit', () => {
  // Ordering, asserted against the source because it is not observable from the exports. A busted
  // request that reached countHit() first would still cost a store write per attack request.
  const redirect = middlewareSource.indexOf('canonicalOnDemandPath(url.pathname');
  const firstCount = middlewareSource.indexOf("countHit('");
  assert.ok(redirect > 0, 'the middleware must call canonicalOnDemandPath');
  assert.ok(firstCount > 0, 'the middleware must still count hits');
  assert.ok(redirect < firstCount, 'canonicalisation must come before the first countHit call');
});
