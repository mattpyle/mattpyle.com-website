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

import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
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

let offences = 0;

for (const file of astroFiles(src)) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  // The frontmatter fence and the <style> block are not markup; only the template between them can
  // carry this defect.
  const withoutFrontmatter = text.replace(/^---[\s\S]*?\n---\n/, match => '\n'.repeat(match.split('\n').length - 1));
  const template = withoutFrontmatter.replace(/<style>[\s\S]*?<\/style>/g, match => '\n'.repeat(match.split('\n').length - 1));
  const lines = template.split('\n');

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

    if (glueBefore || glueAfter) {
      offences += 1;
      const where = `${relative(root, file).split(sep).join('/')}:${i + 1}`;
      console.error(`${where}\n    ${previous}\n    ${current}\n`);
    }
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
