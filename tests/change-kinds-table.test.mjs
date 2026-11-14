import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * CHANGE-KINDS.md names the file that holds each surface. A table nobody checks goes stale like
 * the surfaces it lists, so every repository path it names must exist.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// A path has a directory part. Bare names such as `llms.txt` are the published documents, not
// repository files, apart from the root files listed here.
const PATH_LIKE = /^(?:\.?[\w-]+\/)+[\w.\[\]-]+\.(?:mjs|ts|astro|json|md|txt|yml)$/;
const ROOT_FILES = new Set(['middleware.ts', 'vercel.json', 'CLAUDE.md']);

/** Backticked tokens that are file paths, not code. @param {string} markdown */
export function namedPaths(markdown) {
  return [...markdown.matchAll(/`([^`\s]+)`/g)].map((match) => match[1]).filter((token) => PATH_LIKE.test(token) || ROOT_FILES.has(token));
}

test('every path CHANGE-KINDS.md names exists', () => {
  const paths = namedPaths(readFileSync(`${ROOT}CHANGE-KINDS.md`, 'utf8'));
  assert.ok(paths.length > 20, 'the table names the files that hold each surface');
  const missing = paths.filter((path) => !existsSync(`${ROOT}${path}`));
  assert.deepEqual(missing, [], `CHANGE-KINDS.md names files that do not exist: ${missing.join(', ')}`);
});

test('the path finder skips code and finds paths', () => {
  assert.deepEqual(namedPaths('`src/a.mjs` and `updated:` and `llms.txt` and `x/[slug].md.ts` and `vercel.json`'), ['src/a.mjs', 'x/[slug].md.ts', 'vercel.json']);
});
