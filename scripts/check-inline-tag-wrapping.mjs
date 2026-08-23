// Flags source line breaks that Astro's `compressHTML` would turn into a missing space.
//
// `compressHTML` (on by default, and on for this project) removes the whitespace either side of an
// element boundary when that whitespace contains a newline. A template line that STARTS with an
// inline tag, or ENDS with one, therefore renders glued to the text beside it:
//
//     ... reports back.        ->  ... reports back.<a …>llms.txt</a>
//     <a href="/llms.txt">llms.txt</a>,
//
// The defect is invisible in source and invisible in a diff; it only shows on the rendered page, so
// it is worth a script rather than a habit. Measured with a probe on the built /steward page,
// 2026-08-22: both directions lose the space.
//
// KNOWN GAP: a `{…}` interpolation renders a text node of its own and loses its space the same way
// (`is the {CHECKS.length}` on one line, `checks below` on the next, rendered "13checks below" —
// live on /steward until 2026-08-22). It is not flagged here because an attribute list written one
// `prop={value}` per line is indistinguishable from prose by line shape, and that pattern is
// everywhere in this repo: the check drowned in 130 false positives. Watch for it by hand.
//
// Advisory and standalone — run it after editing prose in an .astro template:
//   node scripts/check-inline-tag-wrapping.mjs
//
// Exit code 1 when a boundary is found, so it can join a check chain later if it earns it.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');

/** Inline elements whose surrounding whitespace is load-bearing prose. */
const INLINE = 'a|code|strong|em|abbr|span';

const OPENS = new RegExp(`^<(?:${INLINE})[\\s>]`);
const CLOSES = new RegExp(`</(?:${INLINE})>$`);
/** A line that is only a tag carries no text of its own, so no space is owed either side. */
const TAG_ONLY = new RegExp(`^<[^>]*>$`);

/** @param {string} dir @returns {string[]} */
function astroFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...astroFiles(full));
    else if (entry.name.endsWith('.astro')) found.push(full);
  }
  return found;
}

/**
 * Blank a matched region, keeping one newline per line it spanned so every line after it still
 * reports the number a reader will find it on.
 * @param {string} match
 */
const blank = (match) => '\n'.repeat(match.split('\n').length - 1);

/**
 * The part of an `.astro` file that becomes markup: not the frontmatter, not a `<style>` block,
 * and not a comment.
 *
 * COMMENTS COME OUT BEFORE THE STYLE BLOCK, AND THAT ORDER IS THE POINT. The style mask is a text
 * match, so a comment that merely NAMES the tag used to open a mask that then ran to the real
 * block's `</style>`; every line between the two stopped being checked and the file reported clean.
 * A docblock in src/pages/webmcp/index.astro did exactly that on 2026-08-22, hiding six live
 * offences from the one tool that can see this defect class. Taking comments out first means the
 * mask can only ever engage on a real element.
 *
 * @param {string} text
 */
export function templateOf(text) {
  return text
    .replace(/^---[\s\S]*?\n---\n/, blank)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, blank);
}

/**
 * The line breaks in one `.astro` source that sit against an inline tag.
 * @param {string} text
 * @returns {{ line: number, previous: string, current: string }[]}
 */
export function findOffences(text) {
  const lines = templateOf(text.replace(/\r\n/g, '\n')).split('\n');
  const found = [];

  for (let i = 1; i < lines.length; i += 1) {
    const previous = lines[i - 1].trim();
    const current = lines[i].trim();
    if (!previous || !current) continue;

    // A line ending in one of these is markup or an expression fragment, not prose, so no space is
    // owed after it; a line starting with one of them is likewise not text.
    const previousIsText = !'>{(}'.includes(previous.at(-1) ?? '');
    const currentIsText = !'<{()}'.includes(current[0] ?? '');

    // Text on the previous line, an inline tag opening this one.
    const glueBefore = OPENS.test(current) && previousIsText;
    // An inline tag closing the previous line, text opening this one.
    const glueAfter = CLOSES.test(previous) && !TAG_ONLY.test(previous) && currentIsText;

    if (glueBefore || glueAfter) found.push({ line: i + 1, previous, current });
  }

  return found;
}

function main() {
  let offences = 0;

  for (const file of astroFiles(src)) {
    const where = relative(root, file).split(sep).join('/');
    for (const { line, previous, current } of findOffences(readFileSync(file, 'utf8'))) {
      offences += 1;
      console.error(`${where}:${line}\n    ${previous}\n    ${current}\n`);
    }
  }

  if (offences > 0) {
    console.error(
      `check-inline-tag-wrapping: ${offences} line break(s) sit against an inline tag and will lose ` +
        `their space in the built HTML. Keep the tag and the text beside it on one source line.`
    );
    process.exit(1);
  }

  console.log('check-inline-tag-wrapping: no line break sits against an inline tag.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
