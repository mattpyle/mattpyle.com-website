/**
 * Every HTML route a production build serves, as site-absolute paths.
 *
 * Enumerated from `dist/client` rather than from the sitemap, because the sitemap is a curated
 * list: a page deliberately kept out of it still ships HTML a browser will parse and an agent will
 * read. The on-demand pages are added from the same list `validate-sitemap.mjs` reads, since they
 * have no file on disk to find.
 *
 * Shared by `validate-html.mjs` and `validate-llms-txt.mjs`, which both check something about
 * every page of a served build and must not disagree about what "every page" means.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ON_DEMAND_PAGES } from '../../src/data/sitemap-lastmod.mjs';

const root = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

/** The directory the Vercel adapter writes prerendered output to — not `dist/` itself. */
export const DIST = join(root, 'dist', 'client');

/** @returns {string[]} sorted, de-duplicated site-absolute paths */
export function builtRoutes() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) found.push(full);
    }
  };
  walk(DIST);

  const paths = found.map((file) => {
    const rel = relative(DIST, file).split(sep).join('/');
    return `/${rel.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '')}`;
  });

  return [...new Set([...paths, ...ON_DEMAND_PAGES])].sort();
}
