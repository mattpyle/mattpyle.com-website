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
    SKILLS_INDEX_PATH,
    ...readSkills().map((skill) => skillUrlFor(skill.name)),
  ];
  assert.deepEqual([...WELL_KNOWN_SURFACE_PATHS].sort(), expected.sort());
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
  // tests/markdown-negotiation.test.mjs asserts that side of the sync.
  for (const entry of matcherEntries()) {
    if (NEGOTIABLE_PAGE_MATCHER.includes(entry)) continue;
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
