/**
 * The narrow reader for the writing collection: four fields, read with independent regexes, for
 * build-time consumers that run outside Astro. astro.config.mjs, generate-og-images.mjs,
 * assert-no-drafts.mjs and validate-sitemap.mjs all use it.
 *
 * Quoting is the author's choice, not the reader's: a title reads the same double-quoted,
 * single-quoted, or bare, because all three are legal YAML and an editor picks for itself. A
 * field that is present but in a shape this reader does not understand throws with the file and
 * the field in the message, rather than reading as undefined — a silent undefined title reached
 * the OG generator only at publish, because that script skips drafts.
 *
 * NO TOP-LEVEL SIDE EFFECTS.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CONTENT_EXTENSION = /\.(?:md|mdx)$/i;

/** @param {string} directory */
function contentFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return contentFiles(path);
    return entry.isFile() && CONTENT_EXTENSION.test(entry.name) ? [path] : [];
  });
}

/** @param {string} source @param {string} field */
function frontmatterDate(source, field) {
  return source.match(
    new RegExp(`^${field}:\\s*["']?(\\d{4}-\\d{2}-\\d{2})["']?\\s*(?:#.*)?$`, 'm')
  )?.[1];
}

/**
 * One frontmatter string field, in any of the three quotings YAML allows for it.
 * Returns undefined when the field is absent, and throws when it is present but unreadable.
 *
 * @param {string} source The frontmatter block.
 * @param {string} field
 * @param {string} where A label for error messages.
 */
function frontmatterString(source, field, where) {
  const line = source.match(new RegExp(`^${field}:(?:[ \\t]+(.*))?$`, 'm'));
  if (!line) return undefined;

  const value = (line[1] ?? '').replace(/\s+$/, '');

  const quoted = value.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');

  const single = value.match(/^'((?:[^']|'')*)'$/);
  if (single) return single[1].replace(/''/g, "'");

  // A bare scalar, with any trailing comment removed. YAML needs whitespace before the `#`, so a
  // hash inside the title itself survives.
  const bare = value.replace(/\s+#.*$/, '').replace(/\s+$/, '');
  if (bare !== '' && !/^["'|>[{&*!%@`]/.test(bare) && !/:\s/.test(bare)) return bare;

  throw new Error(`${where}: "${field}" is present but this reader cannot read its value — ${value || '(empty)'}`);
}

/** @param {string} source */
function frontmatter(source) {
  return source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
}

/**
 * @param {string} directory
 * @returns {Map<string, { draft: boolean, lastmod: string, title: string | undefined, date: string | undefined }>}
 */
export function readWritingMetadata(directory) {
  return new Map(contentFiles(directory).map((path) => {
    const where = relative(directory, path);
    const source = frontmatter(readFileSync(path, 'utf8'));
    const draft = /^draft:\s*["']?true["']?\s*(?:#.*)?$/m.test(source);
    const date = frontmatterDate(source, 'date');
    const updated = frontmatterDate(source, 'updated');
    const title = frontmatterString(source, 'title', where);

    if (!date && !draft) {
      throw new Error(`${where}: published writing requires a date field`);
    }

    const slug = where
      .split(sep).join('/')
      .replace(CONTENT_EXTENSION, '');

    return [slug, { draft, lastmod: updated ?? date ?? '', title, date }];
  }));
}
