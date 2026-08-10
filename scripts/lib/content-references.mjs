import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const CONTENT_EXTENSION = /\.(?:md|mdx)$/i;

/**
 * `key: value`, with value optionally quoted. Frontmatter in this repo is flat; nested keys are
 * indented and are deliberately skipped rather than half-parsed.
 */
const SCALAR_FIELD =
  /^([A-Za-z_][\w-]*):[ \t]+(?:"([^"]*)"|'([^']*)'|(.*?))[ \t]*(?:[ \t]#.*)?$/;

/** Only relative paths are ours to resolve. Bare URLs and `/og/…` roots belong to Zod. */
const RELATIVE_PATH = /^\.{1,2}\//;

/**
 * Known limit: column-0 scalars only. A sequence (`- ../../assets/x.png`) or a nested mapping
 * value is skipped, so an array-of-images field would need this widened. No such field exists in
 * src/content.config.ts today, and guessing at YAML shapes that are not in the schema would cost
 * more than it caught.
 */


/** @param {string} directory */
function contentFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return contentFiles(path);
    return entry.isFile() && CONTENT_EXTENSION.test(entry.name) ? [path] : [];
  });
}

/**
 * The frontmatter block's lines, in file order.
 *
 * `[ \t]*` after the opening fence rather than `\s*`: `\s` matches a newline, so a block that
 * opens with a blank line would have it eaten and every reported line number would be one short.
 * Reporting the wrong line in the file this script exists to point at would be a poor joke.
 *
 * @param {string} source
 */
function frontmatterLines(source) {
  const block = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
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

    // readdirSync throws ENOTDIR when a path runs through a file (`…/tech-stack.png/x`). A script
    // whose whole job is a readable failure must not answer that with a raw Node stack.
    let names;
    try {
      names = readdirSync(current);
    } catch {
      return null;
    }

    // Exact first: a case-sensitive filesystem can hold both `Tech-Stack.png` and
    // `tech-stack.png`, and matching insensitively would call the correct one wrongly cased.
    const match = names.includes(segment)
      ? segment
      : names.find((name) => name.toLowerCase() === segment.toLowerCase());
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
