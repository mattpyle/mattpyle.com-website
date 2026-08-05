// Emits a `.md` sibling for every built HTML page that does not already have a curated one.
//
// Runs after `astro build`, over the built output rather than over source, because the whole
// point is to convert what the page actually renders — one rule, no per-page authoring, and
// a new page is covered the day it ships.
//
// Writes into both output roots. `dist/client` is what `npx serve dist/client` and the local
// audits read; `.vercel/output/static` is what actually deploys (Build Output API), and the
// adapter has already finished copying by the time this runs, so a file written only to
// dist/client would never reach production.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCuratedSibling, markdownSiblingFor } from '../src/lib/markdown-negotiation.mjs';
import { pageToMarkdown } from './lib/html-to-markdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const primaryRoot = join(root, 'dist', 'client');
const outputRoots = [primaryRoot, join(root, '.vercel', 'output', 'static')].filter((dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
});

if (outputRoots.length === 0) {
  throw new Error('emit-markdown-siblings: no build output found — run `astro build` first.');
}

/** @param {string} dir @returns {string[]} */
function htmlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(full));
    else if (entry.name.endsWith('.html')) found.push(full);
  }
  return found;
}

/**
 * The URL a built file is served at. `dist/client/about/index.html` -> `/about/`.
 * @param {string} file
 */
export function pageUrlFor(file) {
  const rel = relative(primaryRoot, file).split(sep).join('/');
  const withoutIndex = rel.replace(/(^|\/)index\.html$/, '$1');
  const withoutExtension = withoutIndex.replace(/\.html$/, '');
  return `/${withoutExtension}`;
}

let emitted = 0;
let curated = 0;
let skipped = 0;

for (const file of htmlFiles(primaryRoot)) {
  const pageUrl = pageUrlFor(file);
  const sibling = markdownSiblingFor(pageUrl);

  // A page path that maps to no sibling is not negotiable at all — nothing to emit.
  if (!sibling) {
    skipped += 1;
    console.warn(`emit-markdown-siblings: no sibling URL for ${pageUrl} — skipped.`);
    continue;
  }

  // The curated on-demand routes own these URLs. Emitting a static file here would shadow
  // them outright, because Vercel's `handle: filesystem` runs before the function routes.
  if (hasCuratedSibling(sibling)) {
    curated += 1;
    continue;
  }

  const markdown = pageToMarkdown(readFileSync(file, 'utf8'));
  if (!markdown) {
    throw new Error(
      `emit-markdown-siblings: ${pageUrl} produced no markdown — it has no <main> landmark, or nothing survived extraction.`
    );
  }

  for (const outputRoot of outputRoots) {
    const target = join(outputRoot, ...sibling.slice(1).split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markdown, 'utf8');
  }
  emitted += 1;
}

console.log(
  `emit-markdown-siblings: ${emitted} converted sibling(s) written to ${outputRoots.length} output root(s); ` +
    `${curated} page(s) served by a curated route; ${skipped} skipped.`
);
