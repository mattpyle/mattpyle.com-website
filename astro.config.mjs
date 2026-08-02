// @ts-check
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';
import { readWritingMetadata } from './scripts/lib/writing-metadata.mjs';
import { SITE_ORIGIN } from './src/data/site-origin.mjs';
import { resolveSitemapLastmod } from './src/data/sitemap-lastmod.mjs';
import { PRE_PAINT_APPEARANCE_SCRIPT } from './src/lib/pre-paint-appearance.mjs';

// Astro hashes the scripts it bundles. It does not hash is:inline scripts, in
// <head> or in <body>, because is:inline means "emit these bytes untouched".
// The pre-paint appearance script has to be is:inline to beat first paint, so
// its hash is computed here from the same constant Layout.astro renders, and
// declared as an additional script-src hash. Derived, never pasted: a literal
// would work until the first edit to the script and then fail silently, which
// is precisely how the script came to be dead from 0b9832a to 2026-08-01.
// scripts/validate-csp-hashes.mjs re-checks this against the built HTML.
// Typed as the literal shape rather than imported as Astro's CspHash: that type
// only lives at astro/dist/core/csp/config.js, a deep internal path, and this
// spelling is the same sha256 member of the union it exports.
/** @type {`sha256-${string}`} */
const prePaintAppearanceHash = `sha256-${createHash('sha256')
  .update(PRE_PAINT_APPEARANCE_SCRIPT, 'utf8')
  .digest('base64')}`;

const writingDir = fileURLToPath(new URL('./src/content/writing/', import.meta.url));
const writingMetadata = readWritingMetadata(writingDir);
// readWritingMetadata reads any content dir's frontmatter (title/date/draft/
// updated) — reused verbatim for the changelog collection.
const changelogDir = fileURLToPath(new URL('./src/content/changelog/', import.meta.url));
const changelogMetadata = readWritingMetadata(changelogDir);

/** @param {string} url @param {string} section */
function collectionSlug(url, section) {
  const pathname = new URL(url).pathname;
  const prefix = `/${section}/`;
  return pathname.startsWith(prefix) && pathname !== prefix
    ? decodeURIComponent(pathname.slice(prefix.length).replace(/\/$/, ''))
    : undefined;
}

export default defineConfig({
  // www is the canonical host — the apex 308s to it at the edge (Vercel). Every
  // absolute URL (canonicals, OG, sitemap, JSON-LD, llms.txt, RSS) inherits this.
  site: `${SITE_ORIGIN}/`,
  // Output stays 'static' (the default) — every page still prerenders exactly
  // as before. The adapter only exists so a handful of routes can opt into
  // on-demand rendering per-page via `export const prerender = false` (see
  // src/pages/writing/[slug].md.ts), which static output alone can't run.
  adapter: vercel({
    webAnalytics: { enabled: true },
  }),
  markdown: { syntaxHighlight: false },
  // 'never': keep CSS in external files. Astro's default ('auto') inlines small
  // bundles as <style> tags, which a strict style-src CSP (no 'unsafe-inline')
  // blocks outright.
  build: { inlineStylesheets: 'never' },
  security: {
    csp: {
      // 'self' covers the site's own external stylesheets (inlineStylesheets is
      // 'never', so all CSS ships as files). Fonts are self-hosted as of Batch 9,
      // so the old https://fonts.googleapis.com carve-out is gone.
      styleDirective: { resources: ["'self'"] },
      // resources is deliberately left alone: Astro's default script-src stays,
      // and this only adds the one hash it declines to compute. No
      // 'unsafe-inline' here, ever: it would void every hash in the directive.
      scriptDirective: { hashes: [prePaintAppearanceHash] },
    },
  },
  integrations: [
    sitemap({
      filter: (url) => {
        const writingId = collectionSlug(url, 'writing');
        if (writingId) return !writingMetadata.get(writingId)?.draft;
        const changelogId = collectionSlug(url, 'changelog');
        if (changelogId) {
          // /changelog/2, /changelog/3 … are pagination index pages, not entries —
          // keep them out of the sitemap (page 1, /changelog/, stays in).
          if (/^\d+$/.test(changelogId)) return false;
          return !changelogMetadata.get(changelogId)?.draft;
        }
        return true;
      },
      serialize(item) {
        const lastmod = resolveSitemapLastmod(
          new URL(item.url).pathname,
          writingMetadata,
          changelogMetadata,
        );
        if (!lastmod) {
          throw new Error(`Sitemap URL ${item.url} has no lastmod policy`);
        }
        item.lastmod = lastmod;
        return item;
      },
    }),
  ],
});
