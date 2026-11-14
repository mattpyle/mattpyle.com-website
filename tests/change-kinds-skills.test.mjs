import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SKILL_IDS } from '../src/lib/a2a-audit-skill.mjs';
import { readSkills } from '../src/lib/agent-skills.mjs';
import { WELL_KNOWN_SURFACE_PATHS } from '../src/lib/agent-surfaces.mjs';
import { countWord } from '../src/lib/count-words.mjs';
import * as mcpServer from '../src/lib/mcp-audit-server.mjs';
import { createTools } from '../src/lib/webmcp-tools.mjs';
import { buildDigest } from '../scripts/generate-a2a-digest.mjs';

/**
 * Change kind "a new skill or tool", four families, one source each:
 *
 *   A2A skills    SKILL_IDS            src/lib/a2a-audit-skill.mjs
 *   Agent Skills  the files            src/data/skills/, read by readSkills() in src/lib/agent-skills.mjs
 *   MCP tools     MCP_TOOL_NAMES       src/lib/mcp-audit-server.mjs, with a test that it equals the
 *                                      names the file registers (the server had no list of its own)
 *   WebMCP tools  createTools()        src/lib/webmcp-tools.mjs; the read ones carry readOnlyHint
 *
 * What is data is generated: the digest's skill and tool counts (scripts/generate-a2a-digest.mjs).
 * What is prose is checked here, and a failure names the family, the member or the count, and the
 * file. A surface states a count where it states one and names every member where it lists them.
 * Nothing here writes a surface. See CHANGE-KINDS.md.
 */

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const capitalised = (word) => `${word[0].toUpperCase()}${word.slice(1)}`;

/**
 * The count word a file states, found by `pattern` (one capture group), compared to the source's.
 * A pattern that no longer matches fails too: the sentence moved, so say where it went.
 */
function assertCount(family, file, text, pattern, count, what) {
  const match = text.match(pattern);
  assert.ok(match, `${family}: ${file} no longer has the sentence that states ${what} (pattern ${pattern}); update the pattern in tests/change-kinds-skills.test.mjs`);
  assert.equal(match[1].toLowerCase(), countWord(count), `${family}: ${file} states ${what} as "${match[1]}", the source has ${count} (${countWord(count)})`);
}

function assertNames(family, file, text, names) {
  const missing = names.filter((name) => !text.includes(name));
  assert.deepEqual(missing, [], `${family}: ${file} does not name ${missing.join(', ')}`);
}

/* ------------------------------------------------------------------ A2A skills */

test('A2A skills: the prose states the count of SKILL_IDS and names every skill', () => {
  const ids = [...SKILL_IDS];
  const llms = read('src/pages/llms.txt.ts');
  assertNames('A2A skills', 'src/pages/llms.txt.ts', llms, ids);
  assertCount('A2A skills', 'src/pages/llms.txt.ts', llms, /\b(\w+) skills, answered by a JSON-RPC/, ids.length, 'the A2A skill count');

  const agents = read('public/agents.md');
  assertNames('A2A skills', 'public/agents.md', agents, ids);
  assertCount('A2A skills', 'public/agents.md', agents, /between them they do (\w+) things/, ids.length, 'the A2A skill count');

  // Checks only: the two JSON documents are not edited by this kind's tests.
  const card = JSON.parse(read('public/.well-known/agent-card.json'));
  assertCount('A2A skills', 'public/.well-known/agent-card.json', card.description, /\b(\w+) skills:/, ids.length, 'the A2A skill count');
  const ard = JSON.parse(read('public/.well-known/ard.json'));
  const a2a = ard.entries.find((entry) => entry.type === 'application/a2a-agent-card+json');
  assertCount('A2A skills', 'public/.well-known/ard.json', a2a.description, /\b(\w+) skills:/, ids.length, 'the A2A skill count');
});

/* ------------------------------------------------------------------ Agent Skills */

test('Agent Skills: the digest is generated from the skill files', () => {
  const skills = readSkills();
  const index = buildDigest().surfaces.find((surface) => surface.name === 'Agent Skills index').description;
  assert.ok(index.includes(`listing ${skills.length} skills`), `Agent Skills: the digest description does not state ${skills.length} skills`);
  for (const skill of skills) assert.ok(index.includes(skill.url), `Agent Skills: the digest description does not name ${skill.name}`);
  const ard = buildDigest().surfaces.find((surface) => surface.name === 'ARD catalogue').description;
  assert.ok(ard.includes(`the ${countWord(skills.length)} Agent Skills`), 'Agent Skills: the digest ARD description does not state the skill count');
});

test('Agent Skills: the logged well-known paths equal the skill files', () => {
  // src/lib/agent-surfaces.mjs is bundled into middleware.ts for the edge, and agent-skills.mjs
  // reads the disk with node:fs, so the list stays hand-kept and this equality holds it.
  const listed = WELL_KNOWN_SURFACE_PATHS.filter((path) => /^\/\.well-known\/agent-skills\/[^/]+\/SKILL\.md$/.test(path)).sort();
  const expected = readSkills().map((skill) => skill.url).sort();
  assert.deepEqual(listed, expected, 'Agent Skills: WELL_KNOWN_SURFACE_PATHS in src/lib/agent-surfaces.mjs does not equal the skill files in src/data/skills/');
});

test('Agent Skills: llms.txt and agents.md state the count and agents.md names every skill', () => {
  const skills = readSkills();
  const names = skills.map((skill) => skill.name);
  const llms = read('src/pages/llms.txt.ts');
  assertCount('Agent Skills', 'src/pages/llms.txt.ts', llms, /and the (\w+) Agent Skills/, skills.length, 'the Agent Skills count');
  const agents = read('public/agents.md');
  assertNames('Agent Skills', 'public/agents.md', agents, names);
  assertCount('Agent Skills', 'public/agents.md', agents, /It lists (\w+) skills/, skills.length, 'the Agent Skills count');
  assertCount('Agent Skills', 'public/agents.md', agents, /and the (\w+) Agent Skills/, skills.length, 'the Agent Skills count');
});

/* ------------------------------------------------------------------ MCP tools */

/** Names `server.registerTool(...)` is called with in src/lib/mcp-audit-server.mjs. */
function registeredMcpNames() {
  const source = read('src/lib/mcp-audit-server.mjs');
  return [...source.matchAll(/\bregisterTool\(\s*(?:'([^']+)'|([A-Za-z_]\w*))/g)].map(([, literal, identifier]) => {
    if (literal) return literal;
    assert.equal(typeof mcpServer[identifier], 'string', `MCP tools: registerTool is called with ${identifier}, which src/lib/mcp-audit-server.mjs does not export as a name`);
    return mcpServer[identifier];
  });
}

test('MCP tools: MCP_TOOL_NAMES is exactly what the server registers', () => {
  assert.deepEqual([...mcpServer.MCP_TOOL_NAMES].sort(), registeredMcpNames().sort(), 'MCP tools: MCP_TOOL_NAMES in src/lib/mcp-audit-server.mjs differs from the names registered with registerTool');
});

/**
 * Surfaces that leave an MCP tool out on purpose, with the code that shows it is deliberate.
 * The discovery documents and llms.txt describe the fast tier and send a client to tools/list.
 */
const FAST_ONLY = [mcpServer.DEEP_TOOL_NAME, mcpServer.GET_AUDIT_TOOL_NAME];
const MCP_EXEMPT = {
  // scripts/validate-mcp-discovery.mjs: "the description has to name the fast tool and must not name either deep one".
  'public/.well-known/mcp-server': { names: FAST_ONLY, reason: 'the discovery document describes the fast tier only (scripts/validate-mcp-discovery.mjs)' },
  'public/mcp/server-card': { names: FAST_ONLY, reason: 'the Server Card describes the fast tier only (scripts/validate-mcp-discovery.mjs)' },
  // src/pages/llms.txt.ts: the MCP line says "audit_site(url) runs the fast audit ... tools/list enumerates the rest".
  'src/pages/llms.txt.ts': { names: FAST_ONLY, reason: 'the MCP line names the fast tool and sends a client to tools/list' },
};

test('MCP tools: every exemption has a reason and names a real tool', () => {
  for (const [file, { names, reason }] of Object.entries(MCP_EXEMPT)) {
    assert.ok(reason.length > 10, `MCP tools: the exemption for ${file} needs a reason`);
    for (const name of names) assert.ok(mcpServer.MCP_TOOL_NAMES.includes(name), `MCP tools: ${file} exempts ${name}, which is not an MCP tool`);
  }
});

test('MCP tools: each surface names every tool it is not exempt from', () => {
  const files = ['public/agents.md', 'src/components/steward/StewardBody.astro', ...Object.keys(MCP_EXEMPT)];
  for (const file of files) {
    const exempt = MCP_EXEMPT[file]?.names ?? [];
    assertNames('MCP tools', file, read(file), mcpServer.MCP_TOOL_NAMES.filter((name) => !exempt.includes(name)));
  }
});

test('MCP tools: the Steward page states the tool count', () => {
  assertCount('MCP tools', 'src/components/steward/StewardBody.astro', read('src/components/steward/StewardBody.astro'), /streamable-HTTP server with\s+(\w+)\s+tools/, mcpServer.MCP_TOOL_NAMES.length, 'the MCP tool count');
});

/* ------------------------------------------------------------------ WebMCP tools */

const WEBMCP = createTools(() => Promise.reject(new Error('no index in a test')));
const READ = WEBMCP.filter((tool) => tool.annotations?.readOnlyHint === true);
const WRITE = WEBMCP.filter((tool) => tool.annotations?.readOnlyHint !== true);

test('WebMCP tools: the digest is generated from createTools()', () => {
  const description = buildDigest().surfaces.find((surface) => surface.name === 'WebMCP tools').description;
  assert.ok(description.startsWith(`${capitalised(countWord(WEBMCP.length))} tools`), 'WebMCP tools: the digest description does not state the tool count');
  assert.ok(description.includes(`${countWord(READ.length)} read and ${countWord(WRITE.length)} write`), 'WebMCP tools: the digest description does not state the read and write counts');
});

test('WebMCP tools: each surface states the counts it states today', () => {
  const total = WEBMCP.length;
  const llms = read('src/pages/llms.txt.ts');
  assertCount('WebMCP tools', 'src/pages/llms.txt.ts', llms, /the (\w+) WebMCP tools this site registers/, total, 'the WebMCP tool count');
  assertCount('WebMCP tools', 'src/pages/llms.txt.ts', llms, /\((\w+) read, \w+ write\)/, READ.length, 'the WebMCP read count');
  assertCount('WebMCP tools', 'src/pages/llms.txt.ts', llms, /\(\w+ read, (\w+) write\)/, WRITE.length, 'the WebMCP write count');

  const full = read('src/pages/llms-full.txt.ts');
  assertCount('WebMCP tools', 'src/pages/llms-full.txt.ts', full, /register (\w+) WebMCP tools/, total, 'the WebMCP tool count');
  assertCount('WebMCP tools', 'src/pages/llms-full.txt.ts', full, /(\w+) are read-only/, READ.length, 'the WebMCP read count');
  assertCount('WebMCP tools', 'src/pages/llms-full.txt.ts', full, /(\w+) are write tools/, WRITE.length, 'the WebMCP write count');

  const agents = read('public/agents.md');
  assertCount('WebMCP tools', 'public/agents.md', agents, /register (\w+) WebMCP tools/, total, 'the WebMCP tool count');
  assertCount('WebMCP tools', 'public/agents.md', agents, /: (\w+) that read published content/, READ.length, 'the WebMCP read count');
  assertCount('WebMCP tools', 'public/agents.md', agents, /and (\w+) that write/, WRITE.length, 'the WebMCP write count');
  assertCount('WebMCP tools', 'public/agents.md', agents, /apart from the (\w+) above/, total, 'the WebMCP tool count');
  assertCount('WebMCP tools', 'public/agents.md', agents, /The (\w+) read tools mutate nothing/, READ.length, 'the WebMCP read count');

  const index = read('src/pages/webmcp/index.astro');
  assertCount('WebMCP tools', 'src/pages/webmcp/index.astro', index, /(\w+) live WebMCP tools/, total, 'the WebMCP tool count');
  assertCount('WebMCP tools', 'src/pages/webmcp/index.astro', index, /: (\w+) that read,/, READ.length, 'the WebMCP read count');
  assertCount('WebMCP tools', 'src/pages/webmcp/index.astro', index, /, (\w+) that write\./, WRITE.length, 'the WebMCP write count');
  assertCount('WebMCP tools', 'src/components/webmcp/WebmcpHero.astro', read('src/components/webmcp/WebmcpHero.astro'), /(\w+) typed tools/, total, 'the WebMCP tool count');
  const body = read('src/components/webmcp/WebmcpBody.astro');
  assertCount('WebMCP tools', 'src/components/webmcp/WebmcpBody.astro', body, /All (\w+) tools have been driven/, total, 'the WebMCP tool count');
  assertCount('WebMCP tools', 'src/components/webmcp/WebmcpBody.astro', body, /behind all (\w+) tools/, total, 'the WebMCP tool count');
});

test('WebMCP tools: llms-full.txt and agents.md name every tool', () => {
  // run_audit is left out of the member list on purpose: /audit/ declares it in the form's own
  // markup, it exists only while that page is open, and public/agents.md and tools.json list it
  // apart from the site-wide tools (`pageTools`). createTools() does not return it.
  const names = WEBMCP.map((tool) => tool.name);
  assertNames('WebMCP tools', 'src/pages/llms-full.txt.ts', read('src/pages/llms-full.txt.ts'), names);
  assertNames('WebMCP tools', 'public/agents.md', read('public/agents.md'), names);
});
