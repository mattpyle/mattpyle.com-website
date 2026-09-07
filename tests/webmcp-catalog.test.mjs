import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import './helpers/dom-stub.mjs';
import { createTools } from '../src/lib/webmcp-tools.mjs';
import { WEBMCP_PAGE_TOOLS, WEBMCP_TOOL_NOTES, WEBMCP_VERIFIED, ORIGIN_TRIAL_EXPIRY } from '../src/data/webmcp-catalog.mjs';
import { TOOL as AUDIT_TOOL } from '../src/data/audit-copy.mjs';
import { PAGE_PATHS } from '../src/data/page-paths.mjs';
import { buildToolsPayload } from '../src/pages/webmcp/tools.json.ts';
import { formatJson, tokenizeJson, BRACKET_DEPTH_COLOURS } from '../src/lib/format-json.mjs';
import { buildToolSnippet } from '../src/lib/webmcp-snippet.mjs';

/**
 * The join between the real tools and their editorial layer is the whole reason /webmcp and
 * /webmcp/tools.json can claim to be accurate. These tests are what makes that claim true after
 * the next tool is added: a new tool with no notes, or a note for a tool nobody registers, fails
 * here rather than shipping a page that describes a surface the site doesn't have.
 */

const throwingGetIndex = () => {
  throw new Error('definitions only');
};

const tools = createTools(throwingGetIndex);
const BASE = 'https://www.mattpyle.com';
const agentsMd = readFileSync(fileURLToPath(new URL('../public/agents.md', import.meta.url)), 'utf8');

/** agents.md is prose, so it spells its counts. Indexed by count, not a lookup by name. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Minimal JSON Schema check — enough for the four hand-written schemas, no dependency. */
function validateAgainstSchema(schema, args, label) {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const key of required) {
    assert.ok(key in args, `${label}: missing required property "${key}"`);
  }

  for (const [key, value] of Object.entries(args)) {
    assert.ok(properties[key], `${label}: "${key}" is not a declared property`);
    const property = properties[key];

    if (property.type === 'integer') {
      assert.ok(Number.isInteger(value), `${label}: "${key}" must be an integer`);
    } else if (property.type === 'number') {
      assert.equal(typeof value, 'number', `${label}: "${key}" must be a number`);
    } else if (property.type === 'string') {
      assert.equal(typeof value, 'string', `${label}: "${key}" must be a string`);
    }

    if (property.minimum !== undefined) assert.ok(value >= property.minimum, `${label}: "${key}" below minimum`);
    if (property.maximum !== undefined) assert.ok(value <= property.maximum, `${label}: "${key}" above maximum`);
    if (property.minLength !== undefined) assert.ok(value.length >= property.minLength, `${label}: "${key}" too short`);
    if (property.enum !== undefined) assert.ok(property.enum.includes(value), `${label}: "${key}" not in enum`);
  }
}

test('every registered tool has catalog notes, and every note has a tool', () => {
  const toolNames = tools.map((tool) => tool.name).sort();
  const noteNames = Object.keys(WEBMCP_TOOL_NOTES).sort();

  assert.deepEqual(noteNames, toolNames, 'webmcp-catalog.mjs and webmcp-tools.mjs must name the same tools');
});

// ── Tools declared on a page, in markup ───────────────────────────────────────
//
// The catalog's join for the six site-wide tools reads the real tool objects. There are no objects
// for a declarative tool: it is three attributes on a form, and Chrome builds the tool when it
// parses the page. So the join on this side is against the markup itself — every `toolname` in
// `src/` has a catalog entry, and every catalog entry has a form. Without it /webmcp could
// advertise a tool no page declares, or a page could declare one /webmcp never mentions, which is
// the same failure the six-tool join exists to prevent.

/** Every `toolname="…"` (or `toolname={…}`) the site's own source declares, with the file it is in. */
function declaredToolNames() {
  const roots = [new URL('../src/components/', import.meta.url), new URL('../src/pages/', import.meta.url)];
  const found = new Map();

  const walk = (dir) => {
    for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(astro|ts|mjs|html)$/.test(entry.name)) continue;
      const source = readFileSync(fileURLToPath(child), 'utf8');
      for (const match of source.matchAll(/\btoolname=(?:"([^"]+)"|\{([^}]+)\})/g)) {
        found.set(match[1] ?? match[2].trim(), fileURLToPath(child));
      }
    }
  };

  roots.forEach(walk);
  return found;
}

test('every page-scoped tool is declared by a form, and every declaring form is in the catalog', () => {
  const declared = declaredToolNames();

  // The one entry today is written as `toolname={TOOL.name}`, so the join runs through the copy
  // module: the attribute and the catalog have to agree on the same constant, not on two literals.
  assert.deepEqual(
    [...declared.keys()].sort(),
    ['TOOL.name'],
    'a toolname attribute appeared or disappeared in src/ — add or remove its catalog entry',
  );
  assert.equal(AUDIT_TOOL.name, 'run_audit');

  assert.deepEqual(
    WEBMCP_PAGE_TOOLS.map((tool) => tool.name),
    [AUDIT_TOOL.name],
    'webmcp-catalog.mjs and the markup must name the same page-scoped tools',
  );
});

test('a page-scoped tool never shares a name with a site-wide one', () => {
  // They would be two different tools with one name in the same document. The site-wide six are
  // registered on every page, including the page that declares this one.
  const siteWide = new Set(tools.map((tool) => tool.name));
  for (const tool of WEBMCP_PAGE_TOOLS) {
    assert.equal(siteWide.has(tool.name), false, `${tool.name} is registered site-wide as well`);
  }
});

test('each page-scoped tool names a page this site serves, and says what calling it does', () => {
  for (const tool of WEBMCP_PAGE_TOOLS) {
    assert.match(tool.page, /^\/[a-z0-9/-]*\/$/, `${tool.name}: page must be a canonical slash path`);
    assert.ok(
      PAGE_PATHS.includes(tool.page.replace(/\/$/, '')),
      `${tool.name}: ${tool.page} is not a page this site publishes`,
    );
    assert.ok(['read', 'write'].includes(tool.kind), `${tool.name}: kind must be read or write`);
    assert.ok(tool.returns.length > 0, `${tool.name}: needs a returns line`);
    assert.ok(tool.notes.length > 0, `${tool.name}: needs its scope stated`);
  }
});

test('the manifest lists page-scoped tools apart from site-wide ones, with their page', () => {
  // Flattening the two would tell an agent it can call run_audit from the homepage, which is false:
  // a declarative tool exists only while the page carrying its form is open.
  const payload = buildToolsPayload(BASE);

  assert.equal(payload.pageTools.length, WEBMCP_PAGE_TOOLS.length);
  assert.equal(
    payload.tools.some((entry) => entry.name === AUDIT_TOOL.name),
    false,
    'a page-scoped tool must not appear in the site-wide list',
  );

  const [entry] = payload.pageTools;
  assert.equal(entry.name, AUDIT_TOOL.name);
  assert.equal(entry.page, `${BASE}/audit/`);
  assert.equal(entry.description, AUDIT_TOOL.description, 'the manifest and the form say the same thing');
  assert.equal('inputSchema' in entry, false, 'Chrome builds the schema from the form; this site does not author one');
});

test('each note declares a kind and a returns line', () => {
  for (const [name, notes] of Object.entries(WEBMCP_TOOL_NOTES)) {
    assert.ok(['read', 'write'].includes(notes.kind), `${name}: kind must be read or write`);
    assert.equal(typeof notes.returns, 'string');
    assert.ok(notes.returns.length > 0, `${name}: needs a returns line`);
  }
});

test("each note's example validates against that tool's own inputSchema", () => {
  for (const tool of tools) {
    const notes = WEBMCP_TOOL_NOTES[tool.name];
    validateAgainstSchema(tool.inputSchema, notes.example, `${tool.name} example`);
  }
});

test('the dates the page is allowed to state are ISO calendar dates', () => {
  assert.match(WEBMCP_VERIFIED.iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(ORIGIN_TRIAL_EXPIRY, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(WEBMCP_VERIFIED.chrome.length > 0);
});

test('the tools.json payload carries one complete entry per registered tool', () => {
  const payload = buildToolsPayload(BASE);

  assert.equal(payload.tools.length, tools.length);
  assert.deepEqual(
    payload.tools.map((entry) => entry.name),
    tools.map((tool) => tool.name)
  );

  for (const entry of payload.tools) {
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.description.length > 0, `${entry.name}: manifest needs a description`);
    assert.equal(entry.inputSchema.type, 'object', `${entry.name}: manifest needs an object schema`);
    assert.ok(['read', 'write'].includes(entry.kind));
    assert.equal(typeof entry.returns, 'string');
    assert.notEqual(entry.example, undefined);
  }

  assert.equal(payload.docs, `${BASE}/webmcp/`);
  assert.equal(payload.index, `${BASE}/webmcp/index.json`);
  assert.equal(payload.verified.date, WEBMCP_VERIFIED.iso);
});

test('the tools.json payload is serializable', () => {
  const payload = buildToolsPayload(BASE);
  const roundTripped = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(roundTripped.tools.map((t) => t.name), tools.map((t) => t.name));
});

test('the tools.json payload leaks no private working docs', () => {
  // A leak has happened before. These are the private paths this repo keeps out of the public
  // build (see .gitignore); none of them may reach a file an agent fetches.
  const serialized = JSON.stringify(buildToolsPayload(BASE));
  for (const forbidden of ['webmcp-retro', 'steward', 'backlog', 'CLAUDE.md']) {
    assert.ok(!serialized.includes(forbidden), `tools.json must not mention ${forbidden}`);
  }
});

test('agents.md names every registered tool and no longer claims three read-only tools', () => {
  for (const tool of tools) {
    assert.ok(agentsMd.includes(tool.name), `public/agents.md must document ${tool.name}`);
  }
  assert.ok(!/three\s+\*{0,2}read-only/i.test(agentsMd), 'public/agents.md still claims "three read-only" tools');
});

test('agents.md marks every write tool as a write and states its client-local scope', () => {
  const writeTools = tools.filter((tool) => WEBMCP_TOOL_NOTES[tool.name].kind === 'write');
  assert.ok(writeTools.length > 0, 'expected at least one write tool');
  assert.match(agentsMd, /\bwrite\b/i);
  assert.match(agentsMd, /localStorage/);

  // The count in the prose is the thing that silently goes stale — it went stale once already,
  // which is why the "three read-only" guard above exists. Assert the current numbers instead of
  // banning last year's sentence.
  const readCount = tools.length - writeTools.length;
  assert.ok(
    agentsMd.includes(`${NUMBER_WORDS[tools.length]} WebMCP tools`),
    `public/agents.md must say "${NUMBER_WORDS[tools.length]} WebMCP tools"`
  );
  assert.ok(
    agentsMd.includes(`${NUMBER_WORDS[readCount]} that read`),
    `public/agents.md must say "${NUMBER_WORDS[readCount]} that read"`
  );
  assert.ok(
    agentsMd.includes(`${NUMBER_WORDS[writeTools.length]} that write`),
    `public/agents.md must say "${NUMBER_WORDS[writeTools.length]} that write"`
  );
});

test('agents.md documents every localStorage key the tools and their UI write', () => {
  // A tool that writes to a key nobody has documented is exactly the sort of thing an agent
  // should be able to find out about before it calls the tool.
  for (const key of ['mattpyle:appearance', 'mattpyle:guestbook', 'mattpyle:webmaster-notes', 'mattpyle:visits']) {
    assert.ok(agentsMd.includes(key), `public/agents.md must document the ${key} storage key`);
  }
});

test('agents.md states that tool-written guest-book entries are labelled as such', () => {
  // The badge is the point of the build; a public doc that omits it lets an agent think its entry
  // is indistinguishable from a human's.
  assert.match(agentsMd, /SIGNED BY AGENT/);
});

test('formatJson tokenizes keys, strings, numbers, keywords, brackets, and punctuation', () => {
  const tokens = formatJson({ mode: 'retro', limit: 5, ok: true, missing: null });
  const kinds = new Set(tokens.map((token) => token.kind));

  for (const kind of ['key', 'string', 'number', 'keyword', 'bracket', 'punctuation']) {
    assert.ok(kinds.has(kind), `expected a ${kind} token`);
  }

  const keys = tokens.filter((token) => token.kind === 'key').map((token) => token.text);
  assert.deepEqual(keys, ['"mode"', '"limit"', '"ok"', '"missing"']);

  // true/false/null are keywords, not numbers — the split that stops `null` reading as a value.
  assert.deepEqual(tokens.filter((t) => t.kind === 'number').map((t) => t.text), ['5']);
  assert.deepEqual(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text), ['true', 'null']);
});

test('bracket pairs share a depth colour, and depth cycles every three levels', () => {
  const tokens = formatJson({ a: { b: { c: { d: [1] } } } });
  const brackets = tokens.filter((token) => token.kind === 'bracket');

  // Openers descend 0,1,2,0,1 …; each closer matches its own opener, so the sequence mirrors.
  const openers = brackets.filter((b) => b.text === '{' || b.text === '[').map((b) => b.depth);
  const closers = brackets.filter((b) => b.text === '}' || b.text === ']').map((b) => b.depth);
  assert.deepEqual(openers, [0, 1, 2, 0, 1]);
  assert.deepEqual(closers, [...openers].reverse(), 'each closer must match its opener');

  // Every depth is a valid index into the three-colour ramp.
  for (const bracket of brackets) {
    assert.ok(
      Number.isInteger(bracket.depth) && bracket.depth >= 0 && bracket.depth < BRACKET_DEPTH_COLOURS,
      `depth ${bracket.depth} is outside the ramp`
    );
  }
});

test('commas and colons stay punctuation, not brackets', () => {
  const tokens = formatJson({ a: 1, b: 2 });
  const punctuation = tokens.filter((t) => t.kind === 'punctuation').map((t) => t.text);
  assert.deepEqual(punctuation, [':', ',', ':']);
});

test('formatJson does not mistake a string containing "null" for a keyword', () => {
  const tokens = formatJson({ note: 'null', flag: false, count: -12.5 });
  assert.deepEqual(tokens.filter((t) => t.kind === 'string').map((t) => t.text), ['"null"']);
  assert.deepEqual(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text), ['false']);
  assert.deepEqual(tokens.filter((t) => t.kind === 'number').map((t) => t.text), ['-12.5']);
});

test('formatJson round-trips: concatenating every token reproduces the source exactly', () => {
  const value = {
    posts: [
      { title: 'A "quoted" title', url: 'https://example.com/a', tags: ['agents', 'webmcp'] },
      { title: 'Colons: and, commas', count: -12.5, featured: false },
    ],
  };
  const source = JSON.stringify(value, null, 2);
  assert.equal(formatJson(value).map((token) => token.text).join(''), source);
});

test('formatJson does not mistake a colon inside a string for a key separator', () => {
  const tokens = formatJson({ note: 'a: b' });
  const strings = tokens.filter((token) => token.kind === 'string').map((token) => token.text);
  assert.deepEqual(strings, ['"a: b"']);
});

test('formatJson prints something rather than crashing on an undefined return', () => {
  assert.deepEqual(formatJson(undefined), [{ text: 'undefined', kind: 'plain' }]);
});

test('buildToolSnippet resolves a tool object first, then calls executeTool with a JSON string', () => {
  // Both halves are load-bearing and were established by running them (see webmcp-snippet.mjs):
  // executeTool takes a RegisteredTool from getTools(), never a name, and a JSON string, never an object.
  assert.equal(
    buildToolSnippet('get_recent_writing', { limit: 5 }),
    "const tool = (await document.modelContext.getTools()).find(t => t.name === 'get_recent_writing');\n" +
      `await document.modelContext.executeTool(tool, '{"limit":5}');`
  );
  assert.equal(
    buildToolSnippet('describe_site'),
    "const tool = (await document.modelContext.getTools()).find(t => t.name === 'describe_site');\n" +
      "await document.modelContext.executeTool(tool, '{}');"
  );
});

test('no snippet passes a bare tool name to executeTool', () => {
  // The exact regression that shipped to production: executeTool('name', …) throws
  // "The provided value is not of type 'RegisteredTool'".
  for (const tool of tools) {
    const snippet = buildToolSnippet(tool.name, WEBMCP_TOOL_NOTES[tool.name].example);
    assert.ok(
      !snippet.includes(`executeTool('`),
      `${tool.name}: executeTool must receive a tool object, not a name string`
    );
    assert.ok(snippet.includes('getTools()'), `${tool.name}: snippet must resolve the tool first`);
  }
});

test('buildToolSnippet escapes payloads that would break the single-quoted literal', () => {
  // An apostrophe in a live input would otherwise close the string early and ship a snippet that
  // does not parse — the copy button hands this to a real console.
  const snippet = buildToolSnippet('search_content', { query: "it's" });
  assert.ok(snippet.includes("\\'"), 'expected the apostrophe to be escaped');
  assert.ok(
    snippet.endsWith(`await document.modelContext.executeTool(tool, '{"query":"it\\'s"}');`),
    `unexpected call line: ${snippet}`
  );

  // A backslash must survive both JSON encoding and the literal escaping.
  const withBackslash = buildToolSnippet('search_content', { query: 'a\\b' });
  assert.ok(
    withBackslash.endsWith(`await document.modelContext.executeTool(tool, '{"query":"a\\\\\\\\b"}');`),
    `unexpected call line: ${withBackslash}`
  );
});

test('every catalog example produces a snippet whose argument round-trips as JSON', () => {
  for (const tool of tools) {
    const example = WEBMCP_TOOL_NOTES[tool.name].example;
    const snippet = buildToolSnippet(tool.name, example);
    const payload = snippet.match(/executeTool\(tool, '(.*)'\);$/)[1]
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
    assert.deepEqual(JSON.parse(payload), example, `${tool.name}: snippet argument must parse back`);
  }
});

test('tokenizeJson is reusable across calls (no sticky-regex state leak)', () => {
  const source = '{\n  "a": 1\n}';
  assert.equal(tokenizeJson(source).map((t) => t.text).join(''), source);
  assert.equal(tokenizeJson(source).map((t) => t.text).join(''), source);
});
