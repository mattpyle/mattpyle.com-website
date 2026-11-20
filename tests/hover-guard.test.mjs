import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import postcss from 'postcss';

/**
 * Every `:hover` rule sits inside `@media (hover: hover)`.
 *
 * A touch browser applies `:hover` to the last element tapped and keeps it until the next tap
 * elsewhere. A hover rule outside the media query therefore leaves a tapped row painted as if it
 * were selected. The rule here has no property judgement on purpose: a colour-only hover sticks
 * the same way, and a check with no exceptions by kind cannot be argued with.
 *
 * What it reads: the `<style>` block of each `.astro` file under `src/` and each `.css` file
 * under `src/`. What it flags: a rule whose selector list holds `:hover` and that has no
 * `@media` ancestor naming `(hover: hover)`. A list that mixes `:hover` with `:active`,
 * `[aria-current]` or `:focus-visible` is flagged too: split it, so the other state stays bare.
 *
 * An intended exception goes in FILE_EXEMPT (a whole file) or RULE_EXEMPT (one selector in one
 * file), with a reason. An exemption that no longer matches a bare rule fails, so the list
 * cannot outlive its cause. `tests/a11y/touch-hover.spec.ts` measures the same promise in a
 * browser with touch emulation.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** @type {Record<string, string>} */
const FILE_EXEMPT = {
  'src/styles/retro.css': 'second pull request: the retro appearance moves its hover rules behind the media query on its own',
};

/** `<file>|<selector as written, whitespace collapsed>` to the reason. @type {Record<string, string>} */
const RULE_EXEMPT = {};

const HOVER_MEDIA = /\(\s*hover\s*:\s*hover\s*\)/;

/**
 * The hover rules of a stylesheet that no `@media (hover: hover)` contains.
 * @param {string} css
 * @returns {{ line: number, selector: string }[]}
 */
export function unguardedHoverRules(css) {
  /** @type {{ line: number, selector: string }[]} */
  const found = [];
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selector.includes(':hover')) return;
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule') continue;
      const at = /** @type {import('postcss').AtRule} */ (parent);
      // `not (hover: hover)` is the opposite promise.
      if (at.name === 'media' && HOVER_MEDIA.test(at.params) && !/\bnot\b/.test(at.params)) return;
    }
    found.push({ line: rule.source?.start?.line ?? 0, selector: rule.selector.replace(/\s+/g, ' ') });
  });
  return found;
}

/**
 * The CSS of a source file, on the lines it has in the file. An `.astro` file gives its `<style>`
 * blocks; the frontmatter and HTML comments are blanked first, because either can name the tag.
 * @param {string} file
 * @param {string} source
 */
export function stylesOf(file, source) {
  if (file.endsWith('.css')) return source;
  const blank = (/** @type {string} */ text) => text.replace(/[^\n]/g, ' ');
  const masked = source.replace(/^---\n[\s\S]*?\n---/, blank).replace(/<!--[\s\S]*?-->/g, blank);
  let css = blank(masked);
  for (const match of masked.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    const start = match.index + match[0].indexOf('>') + 1;
    css = css.slice(0, start) + match[1] + css.slice(start + match[1].length);
  }
  return css;
}

function sourceFiles() {
  return readdirSync(`${ROOT}src`, { recursive: true, encoding: 'utf8' })
    .map((path) => `src/${path.replaceAll('\\', '/')}`)
    .filter((path) => path.endsWith('.astro') || path.endsWith('.css'))
    .sort();
}

test('every hover rule is inside @media (hover: hover)', () => {
  const files = sourceFiles();
  assert.ok(files.length > 30, 'the check found the site styles');
  /** @type {string[]} */
  const offences = [];
  const usedRules = new Set();
  const usedFiles = new Set();
  let guarded = 0; // files that hold a hover rule at all
  for (const file of files) {
    const css = stylesOf(file, readFileSync(`${ROOT}${file}`, 'utf8'));
    const bare = unguardedHoverRules(css);
    if (css.includes(':hover')) guarded += 1;
    for (const rule of bare) {
      const key = `${file}|${rule.selector}`;
      if (file in FILE_EXEMPT) usedFiles.add(file);
      else if (key in RULE_EXEMPT) usedRules.add(key);
      else offences.push(`${file}:${rule.line} ${rule.selector}`);
    }
  }
  assert.ok(guarded > 20, 'the check read hover rules, not empty style blocks');
  assert.deepEqual(
    offences,
    [],
    `hover rules outside @media (hover: hover). A touch device keeps :hover on the last element tapped, so wrap each rule in the media query:\n${offences.join('\n')}\n`,
  );
  for (const [key, reason] of [...Object.entries(FILE_EXEMPT), ...Object.entries(RULE_EXEMPT)]) {
    assert.ok(reason.trim().length > 0, `the exemption for ${key} needs a reason`);
    assert.ok(usedFiles.has(key) || usedRules.has(key), `the exemption for ${key} matches no bare hover rule. Remove it.`);
  }
});

test('the rule finder reads CSS, not text', () => {
  const css = [
    '/* a comment naming .ghost:hover { } is not a rule */',
    '.a::after { content: ":hover {"; }',
    '.bare:hover { color: red; }',
    '@media (hover: hover) { .ok:hover { color: red; } }',
    '@media (min-width: 600px) { .wide:hover { color: red; } }',
    '@media (min-width: 600px) and (hover: hover) { .both:hover { color: red; } }',
    '@media (hover: hover) { @supports (display: grid) { .deep:hover { color: red; } } }',
    '@media (hover: none) { .touch:hover { color: red; } }',
    '@media not (hover: hover) { .negated:hover { color: red; } }',
    '.row:hover .title,\n.row:active { color: red; }',
    '.pressed:active { color: red; }',
  ].join('\n');
  assert.deepEqual(unguardedHoverRules(css), [
    { line: 3, selector: '.bare:hover' },
    { line: 5, selector: '.wide:hover' },
    { line: 8, selector: '.touch:hover' },
    { line: 9, selector: '.negated:hover' },
    { line: 10, selector: '.row:hover .title, .row:active' },
  ]);
});

test('an .astro file gives its style block on its own lines', () => {
  const source = [
    '---',
    'const note = "<style> .front:hover { } </style>";',
    '---',
    '<!-- the <style> block below owns .comment:hover { } -->',
    '<p>text</p>',
    '<style>',
    '  .real:hover { color: red; }',
    '</style>',
  ].join('\n');
  assert.deepEqual(unguardedHoverRules(stylesOf('src/x.astro', source)), [{ line: 7, selector: '.real:hover' }]);
});
