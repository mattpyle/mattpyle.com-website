import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { trailingSlashRedirectFor } from '../src/lib/trailing-slash.mjs';
import { AGENT_SURFACE_PATHS, WELL_KNOWN_SURFACE_PATHS } from '../src/lib/agent-surfaces.mjs';
import { ON_DEMAND_PATHS } from '../src/lib/on-demand-routes.mjs';

// Slash normalisation. The rule itself is three lines; these tests are mostly about the paths it
// must NOT rewrite, because this runs in front of every page on the site and a false positive is
// either a redirect loop or a broken discovery document.

const middlewareSource = readFileSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)), 'utf8');

test('a slash-less page path redirects to the slash form', () => {
  const cases = [
    ['/about', '/about/'],
    ['/writing', '/writing/'],
    ['/changelog', '/changelog/'],
    ['/scorecard', '/scorecard/'],
    ['/webmcp', '/webmcp/'],
    ['/steward', '/steward/'],
    ['/projects', '/projects/'],
    ['/writing/accessibility-and-ai', '/writing/accessibility-and-ai/'],
    ['/changelog/astro-rebuild', '/changelog/astro-rebuild/'],
    ['/changelog/2', '/changelog/2/'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(trailingSlashRedirectFor(input), expected, input);
  }
});

test('a path already in the slash form is left alone', () => {
  // Returning a target here would be a redirect loop, and these are the canonical URLs, so it
  // would be a loop on every page the site actually advertises.
  const canonical = [
    '/',
    '/about/',
    '/writing/',
    '/scorecard/',
    '/writing/accessibility-and-ai/',
    '/changelog/astro-rebuild/',
  ];
  for (const path of canonical) {
    assert.equal(trailingSlashRedirectFor(path), null, path);
  }
});

test('an extension path is never given a slash form', () => {
  // The `.md` siblings are the case this protects most directly: they are extension URLs, they
  // have no directory form, and an agent holding one must not be bounced.
  const files = [
    '/writing/accessibility-and-ai.md',
    '/changelog/astro-rebuild.md',
    '/about.md',
    '/scorecard.md',
    '/rss.xml',
    '/og-fallback.png',
    '/fonts/jetbrains-mono-latin.woff2',
  ];
  for (const path of files) {
    assert.equal(trailingSlashRedirectFor(path), null, path);
  }
});

test('every advertised agent surface is left alone', () => {
  // Asserted against the real lists rather than a hand-copied sample: these are the documents the
  // site publishes for agents, and a redirect on any of them is a broken discovery path.
  for (const path of [...AGENT_SURFACE_PATHS, ...WELL_KNOWN_SURFACE_PATHS]) {
    assert.equal(trailingSlashRedirectFor(path), null, path);
  }
});

test('only the final segment is inspected for an extension', () => {
  // A dot in an earlier segment does not make the path a file. /.well-known/ is the live example.
  assert.equal(trailingSlashRedirectFor('/.well-known/agent-skills'), '/.well-known/agent-skills/');
});

test('the redirect runs after the markdown negotiation branch', () => {
  // Ordering, asserted against the source because it is not observable from the exports, and it is
  // the entire reason this rule is not one line of vercel.json. If the redirect could run first, an
  // `Accept: text/markdown` request to a slash-less URL would 308 instead of being served markdown
  // — which is exactly what the platform `trailingSlash` did when it was measured on a preview.
  const negotiation = middlewareSource.indexOf('prefersMarkdown(accept)');
  const redirect = middlewareSource.indexOf('function slashRedirectOrNext');
  const firstCall = middlewareSource.indexOf('slashRedirectOrNext(url)');
  assert.ok(negotiation > 0, 'the middleware must still consult prefersMarkdown');
  assert.ok(redirect > 0, 'the middleware must define slashRedirectOrNext');
  assert.ok(
    firstCall > negotiation,
    'no slash redirect may be issued before the markdown negotiation decision'
  );
});

test('the JSON-RPC POST endpoints are absent from the matcher, so the redirect can never reach them', () => {
  // Two POST endpoints with no extension. If either were matched, a JSON-RPC call to the slash-less
  // form would 308, and a client that does not follow redirects on POST loses the endpoint: for
  // /a2a the URL the Agent Card and the DNS record publish, for /mcp the URL the MCP discovery
  // document and the registry listing publish. The rule would rewrite both happily — the matcher is
  // the only guard, which is why this is asserted against the source rather than against the rule.
  const block = middlewareSource.match(/matcher:\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'middleware.ts must export a config.matcher array');
  const matcher = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  for (const path of ['/a2a', '/mcp']) {
    assert.ok(!matcher.includes(path), `config.matcher must not include ${path}`);
    assert.ok(!matcher.includes(`${path}/`), `config.matcher must not include ${path}/`);
    assert.equal(trailingSlashRedirectFor(path), `${path}/`);
  }
});

test('neither POST endpoint is in a list that the matcher mirrors', () => {
  // ON_DEMAND_PATHS and AGENT_SURFACE_PATHS are both diffed into the matcher by a test, so adding
  // /mcp to either would put it in the matcher by the back door and 308 the endpoint — a failure
  // that would appear two files away from the edit that caused it.
  for (const path of ['/a2a', '/mcp']) {
    assert.ok(!ON_DEMAND_PATHS.includes(path), `${path} must not be an on-demand path`);
    assert.ok(!AGENT_SURFACE_PATHS.includes(path), `${path} must not be an agent surface`);
  }
});
