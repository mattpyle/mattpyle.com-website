import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const CONTENT_EXTENSION = /\.(?:md|mdx)$/i;

/**
 * `key: value`, with value optionally quoted. Frontmatter in this repo is flat; nested keys are
 * indented and are deliberately skipped rather than half-parsed.
 */
const SCALAR_FIELD = /^([A-Za-z_][\w-]*):[ \t]+(?:"([^"]*)"|'([^']*)'|([^#\r\n]*?))[ \t]*(?:#.*)?$/;

/** Only relative paths are ours to resolve. Bare URLs and `/og/…` roots belong to Zod. */
const RELATIVE_PATH = /^\.{1,2}\//;

/** @param {string} directory */
function contentFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return contentFiles(path);
    return entry.isFile() && CONTENT_EXTENSION.test(entry.name) ? [path] : [];
  });
}

/** @param {string} source */
function frontmatterLines(source) {
  const block = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return block === undefined ? [] : block.split(/\r?\n/);
}

/** @param {string} root @param {string} absolute */
function display(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * The path as the filesystem actually spells it, or null when a segment is not there.
 *
 * `existsSync` alone is not enough on a case-insensitive filesystem, which is what Windows and
 * macOS give you and what Vercel's Linux builders do not.
 *
 * @param {string} root the directory to start walking from; the path must be inside it
 * @param {string} absolute
 * @returns {string | null}
 */
function realCasedPath(root, absolute) {
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;

  for (const segment of segments) {
    if (segment === '..') return null; // Outside the tree: nothing here can vouch for it.
    const match = readdirSync(current).find((name) => name.toLowerCase() === segment.toLowerCase());
    if (match === undefined) return null;
    current = join(current, match);
  }
  return current;
}

/**
 * Every relative asset path in content frontmatter that does not resolve, exactly.
 *
 * @param {{ root: string, contentRoot: string }} where
 * @returns {string[]} one human-readable failure per bad reference, newest field first per file
 */
export function findBrokenContentReferences({ root, contentRoot }) {
  const failures = [];

  for (const file of contentFiles(contentRoot)) {
    const lines = frontmatterLines(readFileSync(file, 'utf8'));

    lines.forEach((line, index) => {
      const match = SCALAR_FIELD.exec(line);
      if (!match) return;

      const [, field, doubleQuoted, singleQuoted, bare] = match;
      const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
      if (!RELATIVE_PATH.test(value)) return;

      const absolute = resolve(dirname(file), value);
      const cased = realCasedPath(root, absolute);
      // +2 because line 1 of the file is the opening `---` and these lines are 1-based.
      const at = `${display(root, file)}:${index + 2}`;

      if (cased === null) {
        failures.push(
          `${at}  ${field}: ${value}\n` +
          `    no such file — looked for ${display(root, absolute)}`
        );
        return;
      }

      if (cased !== absolute) {
        failures.push(
          `${at}  ${field}: ${value}\n` +
          `    wrong case — the file on disk is ${display(root, cased)}\n` +
          `    this resolves on Windows and macOS and fails the Linux build on Vercel`
        );
      }
    });
  }

  return failures;
}
