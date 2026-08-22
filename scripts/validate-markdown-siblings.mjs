// Coverage gate for site-wide markdown negotiation.
//
// This feature's failure mode is silent and one-sided: a human loading the page sees perfect
// HTML whether or not the `.md` sibling exists, and the middleware falls back to HTML when
// the sibling 404s, so a completely broken emit step looks exactly like a working one from
// the outside. The build is the only place a gap can be caught, so a gap fails the build.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCuratedSibling, markdownSiblingFor } from '../src/lib/markdown-negotiation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const primaryRoot = join(root, 'dist', 'client');
const outputRoots = [primaryRoot, join(root, '.vercel', 'output', 'static')].filter((dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
});

// The source routes that answer the curated sibling URLs. Checked as files rather than
// trusted, so deleting one turns into a build failure instead of a live 404.
const CURATED_ROUTES = [
  'src/pages/writing/[slug].md.ts',
  'src/pages/changelog/[slug].md.ts',
  // /activity renders on demand, so no built HTML exists for the emit step to convert; this
  // route is the page's only markdown sibling. Deleting it would leave the negotiation contract
  // silently falling back to HTML on one of the site's audited routes. It replaced
  // src/pages/scorecard.md.ts on 2026-08-22, when the store read moved and /scorecard went back to
  // prerendering with an ordinary converted sibling.
  'src/pages/activity.md.ts',
];
for (const route of CURATED_ROUTES) {
  assert.ok(existsSync(join(root, route)), `curated markdown route is missing: ${route}`);
}

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

const allFiles = filesUnder(primaryRoot);
const htmlPages = allFiles.filter((file) => file.endsWith('.html'));
assert.ok(htmlPages.length > 0, 'no built HTML pages found — did astro build run?');

let coveredByRoute = 0;
let coveredByFile = 0;

for (const file of htmlPages) {
  const rel = relative(primaryRoot, file).split(sep).join('/');
  const pageUrl = `/${rel.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '')}`;
  const sibling = markdownSiblingFor(pageUrl);

  assert.ok(sibling, `built page ${pageUrl} maps to no markdown sibling URL`);

  if (hasCuratedSibling(sibling)) {
    coveredByRoute += 1;
    continue;
  }

  for (const outputRoot of outputRoots) {
    const target = join(outputRoot, ...sibling.slice(1).split('/'));
    assert.ok(
      existsSync(target),
      `${pageUrl} has no markdown sibling at ${sibling} in ${relative(root, outputRoot)}`
    );
    const body = readFileSync(target, 'utf8');
    assert.ok(body.trim().length > 0, `markdown sibling ${sibling} is empty`);
    // Frontmatter plus a heading is the floor: an extraction that silently produced only
    // frontmatter would otherwise pass the emptiness check.
    assert.ok(
      body.split('---\n').length >= 3 && /\n#{1,6} \S/.test(body),
      `markdown sibling ${sibling} has no frontmatter and heading — extraction likely failed`
    );
  }
  coveredByFile += 1;
}

// The `.md` variants are a negotiated representation of a page, not pages of their own.
// Listing one in the sitemap or the RSS feed would invite crawlers to index a duplicate.
const sitemapPath = join(primaryRoot, 'sitemap-0.xml');
if (existsSync(sitemapPath)) {
  const sitemap = readFileSync(sitemapPath, 'utf8');
  assert.ok(!sitemap.includes('.md<'), 'sitemap-0.xml lists a .md sibling');
}
const rssPath = join(primaryRoot, 'rss.xml');
if (existsSync(rssPath)) {
  assert.ok(!readFileSync(rssPath, 'utf8').includes('.md<'), 'rss.xml lists a .md sibling');
}

console.log(
  `validate-markdown-siblings: ${htmlPages.length} built page(s) covered — ` +
    `${coveredByFile} by a converted file in ${outputRoots.length} output root(s), ${coveredByRoute} by a curated route.`
);
