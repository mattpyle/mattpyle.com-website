/**
 * A strict frontmatter reader for the content collections, for build-time scripts that run
 * outside Astro and therefore cannot call getCollection().
 *
 * WHY NOT A YAML PARSER: this is a build step for a site with three collections whose frontmatter
 * is uniformly flat scalars, sequences of strings, and folded prose, and the responder that
 * consumes its output has to stay dependency-free. A parser that understands exactly the subset in
 * use is smaller than the dependency and, more usefully, can refuse everything else.
 *
 * WHAT IT PARSES: flat `key: value` lines whose value is a double-quoted, single-quoted, or bare
 * scalar; `true` and `false`; a flow sequence of quoted strings (`["a", "b"]` or `[]`); a block
 * scalar in either style with any chomping indicator (`|`, `|-`, `|+`, `>`, `>-`, `>+`); and a
 * block sequence of scalars. The last two were added because they are what an editor writes: the
 * same post, saved by a tool rather than by hand, is legal YAML in a shape this reader used to
 * refuse. Explicit indentation indicators (`|2`), nested maps, anchors, aliases and tags are still
 * refused.
 *
 * IT THROWS RATHER THAN SKIPS. Every unparseable line fails the build with the file and the line
 * in the message. That is the whole design: a reader that silently dropped a field it did not
 * understand would publish an A2A digest missing a post, and the failure would surface as an
 * agent being told the site has less on it than it does. A build error is the cheap version of
 * that bug. If a post ever legitimately needs a construct this file refuses, teach it about that
 * one deliberately, with a test per shape.
 *
 * astro.config.mjs uses the narrower scripts/lib/writing-metadata.mjs, which reads four fields
 * with independent regexes, and passes the maps it builds into the sitemap helpers. This does not
 * replace it: that one is load-bearing for the sitemap and has its own tests.
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
 * A single-quoted YAML scalar, or null if the value is not one.
 * Single quotes carry no backslash escapes; a literal quote inside one is doubled.
 */
function singleQuotedScalar(value) {
  const match = value.match(/^'((?:[^']|'')*)'$/);
  return match ? match[1].replace(/''/g, "'") : null;
}

/**
 * A flow (inline) sequence of quoted strings: `["a", "b"]` or `[]`.
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
    const text = quotedScalar(item.trim()) ?? singleQuotedScalar(item.trim());
    if (text === null) {
      throw new Error(`${where}: inline array items must be quoted strings, got ${item.trim()}`);
    }
    return text;
  });
}

/**
 * One scalar value, whatever its quoting: a string, or a boolean for `true` and `false`.
 * A bare scalar is a date, an enum member or an asset path. A bare value containing ": " is far
 * more likely to be an unquoted string that needed quoting than a value we should accept, and a
 * value that opens a quote without closing it is a typo rather than a bare scalar.
 */
function scalar(value, where, name) {
  const quoted = quotedScalar(value) ?? singleQuotedScalar(value);
  if (quoted !== null) return quoted;
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^["']/.test(value)) {
    throw new Error(`${where}: "${name}" opens a quote it does not close`);
  }
  if (/^[{&*!%@`]/.test(value)) {
    throw new Error(`${where}: "${name}" uses a YAML construct this reader does not support — ${value}`);
  }
  if (/:\s/.test(value)) {
    throw new Error(`${where}: "${name}" looks like an unquoted string containing a colon — quote it`);
  }
  return value;
}

/** The leading whitespace of a line. */
function indentOf(line) {
  return line.match(/^[ \t]*/)[0];
}

/**
 * The lines that belong to the block under a `key:` line: every following line that is blank or
 * indented. Returns those lines and the index of the first line that does not belong.
 */
function blockLines(lines, start) {
  let end = start;
  while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end += 1;
  return { body: lines.slice(start, end), end };
}

/**
 * Strip the block's common indentation, taken from its first non-blank line, as YAML does.
 * A non-blank line indented less than that is malformed rather than the end of the block, because
 * blockLines() has already stopped at the first unindented line.
 */
function dedent(body, where, name) {
  const first = body.find((line) => line.trim() !== '');
  if (first === undefined) return [];
  const indent = indentOf(first);
  return body.map((line) => {
    if (line.trim() === '') return '';
    if (!line.startsWith(indent)) {
      throw new Error(`${where}: "${name}" has a line indented less than the block it opens`);
    }
    return line.slice(indent.length);
  });
}

/**
 * Fold a `>` block scalar: a single line break between two equally-indented lines becomes a
 * space, a blank line becomes a line break, and a more-indented line keeps its own breaks.
 */
function fold(body) {
  let text = '';
  for (const [index, line] of body.entries()) {
    if (index === 0) {
      text = line;
      continue;
    }
    const previous = body[index - 1];
    if (line === '') {
      text += '\n';
      continue;
    }
    if (previous === '') {
      text += line;
      continue;
    }
    if (/^[ \t]/.test(line) || /^[ \t]/.test(previous)) {
      text += `\n${line}`;
      continue;
    }
    text += ` ${line}`;
  }
  return text;
}

/**
 * A block scalar under a `key:` line whose value is a style indicator.
 * @returns {{ value: string, end: number }}
 */
function blockScalar(indicator, lines, start, where, name) {
  const header = indicator.match(/^([|>])([+-]?)$/);
  if (!header) {
    throw new Error(`${where}: "${name}" uses a block scalar header this reader does not support — ${indicator}`);
  }
  const [, style, chomping] = header;
  const { body, end } = blockLines(lines, start);
  const content = dedent(body, where, name);
  const raw = `${style === '|' ? content.join('\n') : fold(content)}\n`;

  if (chomping === '+') return { value: raw, end };
  const stripped = raw.replace(/\n+$/, '');
  if (chomping === '-') return { value: stripped, end };
  return { value: stripped === '' ? '' : `${stripped}\n`, end };
}

/**
 * A block sequence under a `key:` line with no value: one `- item` per indented line.
 * @returns {{ value: Array<string | boolean>, end: number }}
 */
function blockSequence(lines, start, where, name) {
  const { body, end } = blockLines(lines, start);
  const content = dedent(body, where, name).filter((line) => line.trim() !== '');
  const value = content.map((line) => {
    const item = line.match(/^-(?:[ \t]+(.*))?$/);
    if (!item) {
      throw new Error(`${where}: "${name}" is a block sequence whose items must be scalars — ${line.trim()}`);
    }
    const text = (item[1] ?? '').replace(/\s+$/, '');
    if (text === '') {
      throw new Error(`${where}: "${name}" has a sequence item with no value`);
    }
    return scalar(text, where, name);
  });
  return { value, end };
}

/**
 * Parse one file's frontmatter into a flat object of strings, arrays, and booleans.
 *
 * @param {string} source The whole file.
 * @param {string} where A label for error messages.
 * @returns {Record<string, string | Array<string | boolean> | boolean>}
 */
export function parseFrontmatter(source, where) {
  const block = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) throw new Error(`${where}: no frontmatter block`);

  /** @type {Record<string, string | Array<string | boolean> | boolean>} */
  const data = {};
  const lines = block[1].split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\s+$/, '');
    if (line === '' || line.trimStart().startsWith('#')) continue;

    const at = `${where}:${index + 1}`;
    if (/^\s/.test(line)) {
      throw new Error(`${at}: indented line that follows no key — this reader does not support nested maps`);
    }

    const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/);
    if (!key) throw new Error(`${at}: not a "key: value" line — ${line}`);

    const [, name, rawValue] = key;
    const value = (rawValue ?? '').trim();

    if (value.startsWith('|') || value.startsWith('>')) {
      const block = blockScalar(value, lines, index + 1, at, name);
      data[name] = block.value;
      index = block.end - 1;
      continue;
    }

    if (value === '') {
      const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== '');
      if (next === undefined || !/^[ \t]/.test(next)) {
        throw new Error(`${at}: "${name}" has no value`);
      }
      if (!/^[ \t]*-(?:[ \t]|$)/.test(next)) {
        throw new Error(`${at}: "${name}" opens a nested map, which this reader does not support`);
      }
      const sequence = blockSequence(lines, index + 1, at, name);
      data[name] = sequence.value;
      index = sequence.end - 1;
      continue;
    }

    const inline = flowSequence(value, at);
    if (inline) {
      data[name] = inline;
      continue;
    }

    data[name] = scalar(value, at, name);
  }

  return data;
}

/**
 * Read a whole collection directory.
 *
 * @param {string} directory
 * @returns {Array<{ slug: string, data: Record<string, string | Array<string | boolean> | boolean> }>}
 */
export function readCollection(directory) {
  return contentFiles(directory).map((path) => {
    const slug = relative(directory, path).split(sep).join('/').replace(CONTENT_EXTENSION, '');
    return { slug, data: parseFrontmatter(readFileSync(path, 'utf8'), slug) };
  });
}
