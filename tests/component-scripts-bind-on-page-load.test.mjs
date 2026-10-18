import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Every authored <script> block in a component or layout must bind on `astro:page-load`.
//
// The site uses Astro's ClientRouter, which re-renders the header and the body on every in-site
// navigation. A script that binds once at first load keeps its listeners on a node the router has
// already detached, and the control it wired stops working from the second page on. PR 367 did
// exactly that to the header's "more" menu. Binding inside an `astro:page-load` handler re-runs
// the wiring on every navigation.
//
// A block that must run once per document on purpose says so in its first line:
//
//   // page-load-exempt: <why>
//
// The comment is the only escape, so the reason sits beside the code it excuses.
//
// Only blocks with an authored body are read. A `<script ... />` with `set:html` or `src` has no
// body to inspect: Layout.astro's pre-paint script is one (its text lives in
// src/lib/appearance.mjs) and its JSON-LD tag is another.

const EXEMPT = /^\s*\/\/\s*page-load-exempt:\s*\S/;
const BINDS = /addEventListener\(\s*['"]astro:page-load['"]/;

// An attribute list that tolerates `>` inside quotes and braces, so `set:html={a > b}` cannot end
// the tag early.
const SCRIPT = /<script\b((?:[^>"'{}]|"[^"]*"|'[^']*'|\{[^}]*\})*)>([\s\S]*?)<\/script[^>]*>/gi;

/** Replace each comment's text with spaces, keeping newlines so line numbers survive. */
function blank(source, pattern) {
  return source.replace(pattern, (match) => match.replace(/[^\n]/g, ' '));
}

/**
 * Every authored script block in an .astro file, with the line its tag opens on.
 *
 * The frontmatter and template comments are blanked first: a docblock that mentions `<script>` in
 * prose (AppearanceUI.astro and WebMCP.astro both do) would otherwise open a block that runs to
 * the real one.
 *
 * @param {string} source
 * @returns {Array<{ line: number, body: string }>}
 */
function scriptBlocks(source) {
  let text = blank(source, /^---\r?\n[\s\S]*?\r?\n---/);
  text = blank(text, /\{\/\*[\s\S]*?\*\/\}/g);
  text = blank(text, /<!--[\s\S]*?-->/g);

  const blocks = [];
  for (const match of text.matchAll(SCRIPT)) {
    const attributes = match[1];
    if (/\bset:html\b|\bsrc\s*=/.test(attributes) || attributes.trimEnd().endsWith('/')) continue;
    const line = text.slice(0, match.index).split('\n').length;
    blocks.push({ line, body: match[2] });
  }
  return blocks;
}

/**
 * Why a block fails, or null when it passes.
 *
 * @param {string} body
 * @returns {string | null}
 */
function violation(body) {
  const firstLine = body.split('\n').find((row) => row.trim() !== '') ?? '';
  if (EXEMPT.test(firstLine)) return null;

  // Comments out first, so prose that names the event cannot satisfy the rule.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (BINDS.test(code)) return null;

  return 'does not call addEventListener("astro:page-load", ...) and has no "// page-load-exempt: <why>" first line';
}

const ROOT = new URL('../', import.meta.url);
const files = ['src/components', 'src/layouts'].flatMap((dir) =>
  readdirSync(new URL(`${dir}/`, ROOT))
    .filter((name) => name.endsWith('.astro'))
    .map((name) => `${dir}/${name}`)
);

test('every script block in src/components and src/layouts binds on astro:page-load', () => {
  const failures = [];
  let blocks = 0;
  for (const file of files) {
    const source = readFileSync(fileURLToPath(new URL(file, ROOT)), 'utf8');
    for (const { line, body } of scriptBlocks(source)) {
      blocks += 1;
      const reason = violation(body);
      if (reason) failures.push(`${file}:${line} ${reason}`);
    }
  }
  assert.ok(blocks > 0, 'found no script blocks: the reader has stopped matching');
  assert.deepEqual(failures, [], `\n${failures.join('\n')}\n`);
});

test('the reader finds the blocks that exist today', () => {
  // A guard against the reader going blind: if a refactor of the regexes drops these, the test
  // above would pass with nothing to check.
  const header = readFileSync(fileURLToPath(new URL('src/components/SiteHeader.astro', ROOT)), 'utf8');
  assert.equal(scriptBlocks(header).length, 1);
  const layout = readFileSync(fileURLToPath(new URL('src/layouts/Layout.astro', ROOT)), 'utf8');
  assert.equal(scriptBlocks(layout).length, 0, 'Layout has set:html tags only');
});

test('a block that binds once at first load fails (PR 367)', () => {
  const body = `
  const more = document.querySelector('.nav-more');
  if (more) {
    document.addEventListener('click', () => { more.open = false; });
  }
`;
  assert.match(violation(body), /astro:page-load/);
});

test('a block that binds inside an astro:page-load handler passes', () => {
  assert.equal(violation(`\n  document.addEventListener('astro:page-load', () => {});\n`), null);
  assert.equal(violation(`document.addEventListener("astro:page-load", init);`), null);
});

test('a comment that names the event does not satisfy the rule', () => {
  const body = `
  // binds on astro:page-load, honest
  /* document.addEventListener('astro:page-load', x) */
  document.addEventListener('click', x);
`;
  assert.ok(violation(body));
});

test('the exemption is the first line and carries a reason', () => {
  assert.equal(violation(`\n  // page-load-exempt: runs once per document\n  run();`), null);
  assert.ok(violation(`  // page-load-exempt:\n  run();`), 'a bare marker has no reason');
  assert.ok(violation(`  run();\n  // page-load-exempt: too late\n`), 'it must be the first line');
});

test('scriptBlocks skips set:html and src tags, and prose that mentions <script>', () => {
  const source = [
    '---',
    '/** Authored as an Astro <script> so the CSP hashes it. */',
    '---',
    '{/* a <script> in a template comment */}',
    '<script is:inline set:html={PRE} />',
    '<script type="application/ld+json" set:html={JSON.stringify(x)} />',
    '<script src="/a.js"></script>',
    '<script>',
    '  run();',
    '</script>',
  ].join('\n');
  const blocks = scriptBlocks(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].line, 8);
});

test('scriptBlocks reads upper-case tags', () => {
  assert.equal(scriptBlocks('<SCRIPT>\n  run();\n</SCRIPT >').length, 1);
});
