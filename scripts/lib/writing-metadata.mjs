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

/** @param {string} source @param {string} field */
function frontmatterString(source, field) {
  const match = source.match(new RegExp(`^${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, 'm'));
  return match?.[1].replace(/\\(.)/g, '$1');
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
    const source = frontmatter(readFileSync(path, 'utf8'));
    const draft = /^draft:\s*["']?true["']?\s*(?:#.*)?$/m.test(source);
    const date = frontmatterDate(source, 'date');
    const updated = frontmatterDate(source, 'updated');
    const title = frontmatterString(source, 'title');

    if (!date && !draft) {
      throw new Error(`${relative(directory, path)}: published writing requires a date field`);
    }

    const slug = relative(directory, path)
      .split(sep).join('/')
      .replace(CONTENT_EXTENSION, '');

    return [slug, { draft, lastmod: updated ?? date ?? '', title, date }];
  }));
}
