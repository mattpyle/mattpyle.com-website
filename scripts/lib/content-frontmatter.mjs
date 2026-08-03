/**
 * A strict frontmatter reader for the content collections, for build-time scripts that run
 * outside Astro and therefore cannot call getCollection().
 *
 * WHY NOT A YAML PARSER: this is a build step for a site with three collections whose frontmatter
 * is uniformly flat scalars and inline arrays, and the responder that consumes its output has to
 * stay dependency-free. A parser that understands exactly the subset in use is smaller than the
 * dependency and, more usefully, can refuse everything else.
 *
 * IT THROWS RATHER THAN SKIPS. Every unparseable line fails the build with the file and the line
 * in the message. That is the whole design: a reader that silently dropped a field it did not
 * understand would publish an A2A digest missing a post, and the failure would surface as an
 * agent being told the site has less on it than it does. A build error is the cheap version of
 * that bug. If a post ever legitimately needs a block scalar or a nested map, teach this file
 * about it deliberately.
 *
 * src/data/sitemap-lastmod.mjs and astro.config.mjs use the narrower
 * scripts/lib/writing-metadata.mjs, which reads four fields with independent regexes. This does
 * not replace it: that one is load-bearing for the sitemap and has its own tests.
 *
 * NO TOP-LEVEL SIDE EFFECTS.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CONTENT_EXTENSION = /\.(?:md|mdx)$/i;

/** Every markdown file under a directory, recursively, sorted for stable output. */
function contentFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return contentFiles(path);
      return entry.isFile() && CONTENT_EXTENSION.test(entry.name) ? [path] : [];
    })
    .sort();
}

/**
 * A double-quoted YAML scalar, or null if the value is not one.
 * Handles the backslash escapes the content actually uses (\" inside a description).
 */
function quotedScalar(value) {
  const match = value.match(/^"((?:[^"\\]|\\.)*)"$/);
  return match ? match[1].replace(/\\(.)/g, '$1') : null;
}

/**
 * A flow (inline) sequence of double-quoted strings: `["a", "b"]` or `[]`.
 * Returns null if the value is not one.
 */
function flowSequence(value, where) {
  if (!value.startsWith('[')) return null;
  if (!value.endsWith(']')) {
    throw new Error(`${where}: unterminated inline array — this reader does not support multi-line sequences`);
  }
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => {
    const text = quotedScalar(item.trim());
    if (text === null) {
      throw new Error(`${where}: inline array items must be double-quoted strings, got ${item.trim()}`);
    }
    return text;
  });
}

/**
 * Parse one file's frontmatter into a flat object of strings, string arrays, and booleans.
 *
 * @param {string} source The whole file.
 * @param {string} where A label for error messages.
 * @returns {Record<string, string | string[] | boolean>}
 */
export function parseFrontmatter(source, where) {
  const block = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) throw new Error(`${where}: no frontmatter block`);

  /** @type {Record<string, string | string[] | boolean>} */
  const data = {};

  for (const [index, rawLine] of block[1].split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '' || line.trimStart().startsWith('#')) continue;

    const at = `${where}:${index + 1}`;
    if (/^\s/.test(line)) {
      throw new Error(`${at}: indented line — this reader does not support nested maps or block sequences`);
    }

    const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/);
    if (!key) throw new Error(`${at}: not a "key: value" line — ${line}`);

    const [, name, rawValue] = key;
    const value = (rawValue ?? '').trim();

    if (value === '') {
      throw new Error(`${at}: "${name}" has no value — block scalars and nested maps are not supported`);
    }
    if (value === '|' || value === '>' || value.startsWith('|') || value.startsWith('>')) {
      throw new Error(`${at}: "${name}" uses a block scalar, which this reader does not support`);
    }

    const sequence = flowSequence(value, at);
    if (sequence) {
      data[name] = sequence;
      continue;
    }

    const quoted = quotedScalar(value);
    if (quoted !== null) {
      data[name] = quoted;
      continue;
    }

    if (value === 'true' || value === 'false') {
      data[name] = value === 'true';
      continue;
    }

    // A bare scalar: a date, an enum member, an asset path. Anything with a ": " in it is far
    // more likely to be an unquoted string that needed quoting than a value we should accept.
    if (/:\s/.test(value)) {
      throw new Error(`${at}: "${name}" looks like an unquoted string containing a colon — quote it`);
    }
    data[name] = value;
  }

  return data;
}

/**
 * Read a whole collection directory.
 *
 * @param {string} directory
 * @returns {Array<{ slug: string, data: Record<string, string | string[] | boolean> }>}
 */
export function readCollection(directory) {
  return contentFiles(directory).map((path) => {
    const slug = relative(directory, path).split(sep).join('/').replace(CONTENT_EXTENSION, '');
    return { slug, data: parseFrontmatter(readFileSync(path, 'utf8'), slug) };
  });
}
