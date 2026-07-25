import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import './helpers/dom-stub.mjs';
import { createTools } from '../src/lib/webmcp-tools.mjs';
import { WEBMCP_TOOL_NOTES, WEBMCP_VERIFIED, ORIGIN_TRIAL_EXPIRY } from '../src/data/webmcp-catalog.mjs';
import { buildToolsPayload } from '../src/pages/webmcp/tools.json.ts';
import { formatJson, tokenizeJson } from '../src/lib/format-json.mjs';

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

  assert.equal(payload.docs, `${BASE}/webmcp`);
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

test('agents.md marks the write tool as a write and states its client-local scope', () => {
  const writeTools = tools.filter((tool) => WEBMCP_TOOL_NOTES[tool.name].kind === 'write');
  assert.ok(writeTools.length > 0, 'expected at least one write tool');
  assert.match(agentsMd, /\bwrite\b/i);
  assert.match(agentsMd, /localStorage/);
});

test('formatJson tokenizes keys, strings, literals, and punctuation', () => {
  const tokens = formatJson({ mode: 'retro', limit: 5, ok: true, missing: null });
  const kinds = new Set(tokens.map((token) => token.kind));

  assert.ok(kinds.has('key'));
  assert.ok(kinds.has('string'));
  assert.ok(kinds.has('literal'));
  assert.ok(kinds.has('punctuation'));

  const keys = tokens.filter((token) => token.kind === 'key').map((token) => token.text);
  assert.deepEqual(keys, ['"mode"', '"limit"', '"ok"', '"missing"']);

  const literals = tokens.filter((token) => token.kind === 'literal').map((token) => token.text);
  assert.deepEqual(literals, ['5', 'true', 'null']);
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

test('tokenizeJson is reusable across calls (no sticky-regex state leak)', () => {
  const source = '{\n  "a": 1\n}';
  assert.equal(tokenizeJson(source).map((t) => t.text).join(''), source);
  assert.equal(tokenizeJson(source).map((t) => t.text).join(''), source);
});
