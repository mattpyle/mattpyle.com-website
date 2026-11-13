/**
 * The narrow reader for the fixes collection, for build-time consumers that run outside Astro:
 * astro.config.mjs (the sitemap), scripts/validate-sitemap.mjs and scripts/generate-page-paths.mjs.
 *
 * It returns each fix keyed by its `slug`, the segment of its URL, with the date its sitemap
 * entry carries: the later of `verified` (the day the fix was confirmed on production) and the
 * optional `updated`, as calendar dates: `verified` in America/Vancouver, the zone the pages show times in, `updated` as written.
 *
 * WHY NOT js-yaml: CI generates the page paths on the pull request's base commit in a worktree
 * with no `npm ci`, so every file the generators import may reach only `node:` builtins and
 * repository files. scripts/fix-log-entries.mjs uses js-yaml, so this file reads the four keys it
 * needs from the frontmatter block with node:fs and column-0 matches instead.
 * tests/generator-imports.test.mjs holds that rule; tests/fix-log-entries.test.mjs checks this
 * reader against the js-yaml one on every real entry.
 *
 * NO TOP-LEVEL SIDE EFFECTS.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENTRIES_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src/content/fixes');

/** The value of a column-0 `name:` line inside the frontmatter block, unquoted; undefined when absent. */
function frontmatterValue(block, name) {
  const match = block.match(new RegExp(`^${name}:[ \t]*(.*)$`, 'm'));
  if (!match) return undefined;
  const raw = match[1].trim();
  const quoted = raw.match(/^"(.*)"$/) ?? raw.match(/^'(.*)'$/);
  return quoted ? quoted[1] : raw;
}

/**
 * @param {string} [directory]
 * @returns {Map<string, { draft: boolean, lastmod: string, key: string }>}
 */
export function readFixMetadata(directory = ENTRIES_DIR) {
  const metadata = new Map();
  const files = existsSync(directory) ? readdirSync(directory).filter((f) => f.endsWith('.md')) : [];
  for (const file of files) {
    const text = readFileSync(join(directory, file), 'utf8').replace(/\r\n/g, '\n');
    const block = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? '';
    const key = frontmatterValue(block, 'key');
    if (key === undefined || key === '') throw new Error(`${file}: a fix needs a key`);
    const slug = frontmatterValue(block, 'slug');
    if (slug === undefined || slug === '') {
      throw new Error(`${file}: a fix needs a slug before its page can be listed`);
    }
    const verified = new Date(frontmatterValue(block, 'verified'));
    if (Number.isNaN(verified.getTime())) {
      throw new Error(`${file}: "verified" is not a date`);
    }
    if (metadata.has(slug)) throw new Error(`${file}: slug "${slug}" is used twice`);
    const day = (date) => date.toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
    const updatedRaw = frontmatterValue(block, 'updated');
    const updated = updatedRaw ? new Date(updatedRaw) : null;
    if (updated && Number.isNaN(updated.getTime())) throw new Error(`${file}: "updated" is not a date`);
    // `updated` is a calendar date, read as UTC like `found`. The later of `verified` and `updated`: an edit to the text moves the sitemap date.
    const lastmod = [day(verified), ...(updated ? [updated.toISOString().slice(0, 10)] : [])].sort().at(-1);
    metadata.set(slug, { draft: false, lastmod, key });
  }
  return metadata;
}
