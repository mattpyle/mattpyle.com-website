import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { staticPagePaths } from '../../scripts/generate-page-paths.mjs';

/** The pages the site builds, shared by the change-kinds page tests. See CHANGE-KINDS.md. */

export const ROOT = new URL('../../', import.meta.url);
export const read = (path) => readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8');

/** No trailing slash, except the root. @param {string} path */
export function canon(path) {
  const bare = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return bare === '' ? '/' : bare;
}

/** The pages the site builds at the top level of src/pages, plus the changelog's page 1. */
export function builtPages() {
  return new Set([...staticPagePaths(), '/changelog'].map(canon));
}

