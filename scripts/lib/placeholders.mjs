/**
 * The scaffold placeholder marker, and the scan that finds one left in a published entry.
 *
 * `scripts/new-post.mjs` writes the marker into the two spots a person must rewrite: the
 * `description` value and one HTML comment at the top of the body. Both reach the page if they
 * are left: the description feeds the index card and the meta description, and the comment is
 * served in the HTML. `scripts/validate-placeholders.mjs` fails a build on either.
 *
 * WHAT COUNTS. The marker only where the scaffold puts it: opening a frontmatter value, or
 * opening an HTML comment in the body. The word in a sentence, the marker inside a fenced code
 * block and the marker inside inline code are all ordinary content, so a post that documents the
 * scaffold can quote it.
 *
 * A DRAFT IS EXEMPT, whatever SHOW_DRAFTS says: the placeholders exist so that a draft starts
 * with them. Draft status comes from scripts/lib/writing-metadata.mjs, the reader the sitemap and
 * assert-no-drafts.mjs already trust.
 *
 * NO TOP-LEVEL SIDE EFFECTS.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readWritingMetadata } from './writing-metadata.mjs';

/** The one marker. The scaffold writes it and the guard looks for it. */
export const PLACEHOLDER_MARKER = 'REPLACE:';

const FRONTMATTER_VALUE = new RegExp(`^(?:([A-Za-z_][\\w-]*):)?\\s*(?:-\\s+)?(?:[|>][+-]?\\s*)?["']?${PLACEHOLDER_MARKER}`);
const COMMENT = new RegExp(`<!--\\s*${PLACEHOLDER_MARKER}`);
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;

/**
 * Every placeholder in one entry's source.
 *
 * @param {string} source The whole file.
 * @returns {Array<{ line: number, what: string }>} 1-based lines.
 */
export function findPlaceholders(source) {
  const lines = source.split(/\r?\n/);
  const found = [];

  let index = 0;
  if (/^---\s*$/.test(lines[0] ?? '')) {
    let field = 'frontmatter';
    for (index = 1; index < lines.length && !/^---\s*$/.test(lines[index]); index++) {
      const key = lines[index].match(/^([A-Za-z_][\w-]*):/)?.[1];
      if (key) field = key;
      if (FRONTMATTER_VALUE.test(lines[index])) found.push({ line: index + 1, what: field });
    }
    index++;
  }

  /** @type {string | null} The fence that opened the block being skipped. */
  let fence = null;
  for (; index < lines.length; index++) {
    const marker = lines[index].match(FENCE)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (COMMENT.test(lines[index].replace(INLINE_CODE, ''))) found.push({ line: index + 1, what: 'the body' });
  }

  return found;
}

/**
 * The file behind a slug from readWritingMetadata, which reports the slug and not the path.
 *
 * @param {string} directory @param {string} slug
 */
function entryPath(directory, slug) {
  const path = ['.md', '.mdx'].map((extension) => join(directory, slug + extension)).find(existsSync);
  if (!path) throw new Error(`${slug}: no .md or .mdx file for this entry under ${directory}`);
  return path;
}

/**
 * Every placeholder left in a published entry, as a message that names the file and the line.
 *
 * @param {{ root: string, directories: string[] }} options `root` is what the reported paths are
 *   relative to; `directories` are the draft-capable collection directories.
 * @returns {string[]}
 */
export function findPublishedPlaceholders({ root, directories }) {
  const failures = [];
  for (const directory of directories) {
    for (const [slug, { draft }] of readWritingMetadata(directory)) {
      if (draft) continue;
      const path = entryPath(directory, slug);
      const file = relative(root, path).split(sep).join('/');
      for (const { line, what } of findPlaceholders(readFileSync(path, 'utf8'))) {
        const fix = what === 'the body'
          ? 'Delete the comment'
          : `Write the ${what}`;
        failures.push(
          `${file}:${line}: ${what} still holds the scaffold placeholder "${PLACEHOLDER_MARKER}". ${fix}, or set draft: true.`
        );
      }
    }
  }
  return failures;
}
