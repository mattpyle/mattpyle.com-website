import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  AGENT_SURFACE_PATHS,
  WELL_KNOWN_SURFACE_PATHS,
  formatSurfaceLine,
  isAgentSurface,
} from '../src/lib/agent-surfaces.mjs';
import { readSkills, skillUrlFor, SKILLS_INDEX_PATH } from '../src/lib/agent-skills.mjs';
import { NEGOTIABLE_PAGE_MATCHER } from '../src/lib/markdown-negotiation.mjs';
import { ON_DEMAND_PATHS } from '../src/lib/on-demand-routes.mjs';
import { RETIRED_URL_MATCHER } from '../src/lib/retired-urls.mjs';

const middlewareSource = readFileSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)), 'utf8');

function matcherEntries() {
  const block = middlewareSource.match(/matcher:\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'middleware.ts must export a config.matcher array');
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test('every advertised surface is recognised', () => {
  for (const path of AGENT_SURFACE_PATHS) {
    assert.equal(isAgentSurface(path), true, path);
  }
});

test('the whole .well-known subtree counts, including paths the site does not serve', () => {
  assert.equal(isAgentSurface('/.well-known/agent-card.json'), true);
  assert.equal(isAgentSurface('/.well-known/ai-plugin.json'), true);
  assert.equal(isAgentSurface('/.well-known/security.txt'), true);
});

test('every named well-known surface is recognised, including the nested skill path', () => {
  // The skill URL is three segments deep. A prefix rule that only matched one level would still
  // pass every other test in this file and silently drop the half of the hypothesis that matters.
  for (const path of WELL_KNOWN_SURFACE_PATHS) {
    assert.equal(isAgentSurface(path), true, path);
  }
  assert.ok(WELL_KNOWN_SURFACE_PATHS.some((path) => path.split('/').length > 3));
});

test('the named well-known surfaces are the ones the site actually publishes', () => {
  // WELL_KNOWN_SURFACE_PATHS is a literal list because middleware.ts imports this module and it
  // must stay free of filesystem reads. This is the diff that keeps the literal honest: publish a
  // second skill and the list fails here rather than going unlogged forever.
  const expected = [
    '/.well-known/agent-card.json',
    '/.well-known/mcp-server',
    '/.well-known/ard.json',
    '/.well-known/ai-catalog.json',
    '/.well-known/mcp/server-card.json',
    SKILLS_INDEX_PATH,
    ...readSkills().map((skill) => skillUrlFor(skill.name)),
  ];
  assert.deepEqual([...WELL_KNOWN_SURFACE_PATHS].sort(), expected.sort());

  // The hand-written documents are asserted to exist as files, which is what "actually publishes"
  // means for them: none is generated, so nothing else in the build would notice a listed path that
  // serves a 404. The skills are covered by readSkills() reading their source. The two alias paths,
  // /.well-known/ai-catalog.json and /.well-known/mcp/server-card.json, are deliberately not in
  // this loop: a file at either would be the drift the alias exists to avoid, and each has its own
  // test below asserting the opposite.
  for (const path of [
    '/.well-known/agent-card.json',
    '/.well-known/mcp-server',
    '/.well-known/ard.json',
    '/mcp/server-card',
  ]) {
    const file = fileURLToPath(new URL(`../public${path}`, import.meta.url));
    assert.doesNotThrow(() => readFileSync(file), `${path} is listed as a surface but public${path} does not exist`);
  }
});

test('the scanner path is an alias onto the Server Card, not a second card', () => {
  // Same shape as the ai-catalog test below, and the same failure it guards: two files would be two
  // places for one card to drift, and the stale one is the one an agent would read. It matters more
  // here than for the catalogue, because these two paths belong to two readings of the same spec —
  // SEP-2127's discovery.md argues a server card does not belong under .well-known, and Cloudflare's
  // scanner probes nowhere else — so the temptation to let them say different things is real.
  const aliasFile = fileURLToPath(new URL('../public/.well-known/mcp/server-card.json', import.meta.url));
  assert.throws(
    () => readFileSync(aliasFile),
    'public/.well-known/mcp/server-card.json exists; the scanner path must stay a rewrite onto /mcp/server-card'
  );

  const vercelConfig = JSON.parse(
    readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8')
  );
  assert.ok(
    vercelConfig.rewrites?.some(
      (rule) => rule.source === '/.well-known/mcp/server-card.json' && rule.destination === '/mcp/server-card'
    ),
    'vercel.json must rewrite /.well-known/mcp/server-card.json to /mcp/server-card'
  );

  // Headers are matched against the request path, before the rewrite, so the alias needs its own
  // block and the two blocks have to agree. The card's media type is the whole point of the
  // Content-Type header here: a client that asked for application/mcp-server-card+json and got
  // application/json on one path but not the other has been told the two documents differ.
  const headersFor = (source) => vercelConfig.headers.find((block) => block.source === source)?.headers;
  assert.deepEqual(headersFor('/.well-known/mcp/server-card.json'), headersFor('/mcp/server-card'));

  // The four CORS headers discovery.md marks MUST, on both paths. A browser-based client is the
  // population this document exists for and the one a missing header locks out silently.
  for (const source of ['/mcp/server-card', '/.well-known/mcp/server-card.json']) {
    const keys = new Set(headersFor(source)?.map((header) => header.key));
    for (const required of [
      'Access-Control-Allow-Origin',
      'Access-Control-Allow-Methods',
      'Access-Control-Allow-Headers',
      'Access-Control-Expose-Headers',
    ]) {
      assert.ok(keys.has(required), `${source} is missing ${required}`);
    }
    assert.ok(
      headersFor(source)?.some(
        (header) => header.key === 'Content-Type' && header.value.startsWith('application/mcp-server-card+json')
      ),
      `${source} must declare the Server Card media type`
    );
  }
});

test('the ai-catalog path is an alias onto ard.json, not a second catalogue', () => {
  // The whole point of the predecessor path is that it is a second name for one file. A file at
  // the alias path would serve stale bytes the moment ard.json changed, which is the failure this
  // asserts against, and the rewrite is what makes the path answer at all.
  const aliasFile = fileURLToPath(new URL('../public/.well-known/ai-catalog.json', import.meta.url));
  assert.throws(
    () => readFileSync(aliasFile),
    'public/.well-known/ai-catalog.json exists; the predecessor path must stay a rewrite onto ard.json'
  );

  const vercelConfig = JSON.parse(
    readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8')
  );
  assert.ok(
    vercelConfig.rewrites?.some(
      (rule) => rule.source === '/.well-known/ai-catalog.json' && rule.destination === '/.well-known/ard.json'
    ),
    'vercel.json must rewrite /.well-known/ai-catalog.json to /.well-known/ard.json'
  );

  // Headers are matched against the request path, before the rewrite, so the alias needs its own
  // block and the two blocks have to agree. A drifted Content-Type is the one difference a client
  // on the old path would actually see.
  const headersFor = (source) => vercelConfig.headers.find((block) => block.source === source)?.headers;
  assert.deepEqual(headersFor('/.well-known/ai-catalog.json'), headersFor('/.well-known/ard.json'));
});

test('ordinary pages and reader furniture are not surfaces', () => {
  // /rss.xml and the icons are excluded on purpose; see the module comment.
  for (const path of ['/', '/about/', '/writing/some-post/', '/rss.xml', '/favicon.ico', '/site.webmanifest']) {
    assert.equal(isAgentSurface(path), false, path);
  }
});

test('a trailing slash does not hide a surface', () => {
  assert.equal(isAgentSurface('/llms.txt/'), true);
  assert.equal(isAgentSurface('/'), false);
});

// The matcher is what makes a static fetch reach a function at all. A path recognised by the
// module but missing from the matcher is silently never logged, which is the one failure mode of
// this feature that looks exactly like "no agent came".
test('middleware.ts matches every path the module recognises', () => {
  const matcher = matcherEntries();
  for (const path of AGENT_SURFACE_PATHS) {
    assert.ok(matcher.includes(path), `middleware.ts config.matcher is missing ${path}`);
  }
  assert.ok(matcher.includes('/.well-known/:path*'), 'config.matcher is missing the .well-known subtree');
});

test('the matcher lists no agent path the module would ignore', () => {
  // The page paths are in the matcher for markdown negotiation, not for surface logging —
  // NEGOTIABLE_PAGE_MATCHER in src/lib/markdown-negotiation.mjs owns them, and
  // tests/markdown-negotiation.test.mjs asserts that side of the sync. ON_DEMAND_PATHS is the
  // third reason a path can be in the matcher: query-string canonicalisation, owned by
  // src/lib/on-demand-routes.mjs and diffed in tests/on-demand-routes.test.mjs. RETIRED_URL_MATCHER
  // is the fourth: an old URL has to reach the function to be 301ed, and it is no longer a page.
  for (const entry of matcherEntries()) {
    if (NEGOTIABLE_PAGE_MATCHER.includes(entry)) continue;
    if (ON_DEMAND_PATHS.includes(entry)) continue;
    if (RETIRED_URL_MATCHER.includes(entry)) continue;
    const probe = entry.replace('/:path*', '/probe');
    assert.equal(isAgentSurface(probe), true, `${entry} is matched but not recognised as a surface`);
  }
});

test('the log line is one parseable line with exactly three fields', () => {
  const line = formatSurfaceLine({
    path: '/llms.txt',
    ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0)',
    accept: 'text/plain, */*',
  });
  assert.equal(line.includes('\n'), false);
  assert.equal(
    line,
    '[agent-surface] path="/llms.txt" ua="Mozilla/5.0 (compatible; ClaudeBot/1.0)" accept="text/plain, */*"'
  );
});

test('missing headers log as empty rather than as the string null', () => {
  assert.equal(
    formatSurfaceLine({ path: '/agents.md', ua: null, accept: null }),
    '[agent-surface] path="/agents.md" ua="" accept=""'
  );
});

test('a user agent containing quotes stays on one parseable line', () => {
  const line = formatSurfaceLine({ path: '/agents.md', ua: 'weird"agent\nnewline', accept: '*/*' });
  assert.equal(line.includes('\n'), false);
  assert.equal(line, '[agent-surface] path="/agents.md" ua="weird\\"agent\\nnewline" accept="*/*"');
});
