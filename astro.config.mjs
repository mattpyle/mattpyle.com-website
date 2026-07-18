// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';
import { readWritingMetadata } from './scripts/lib/writing-metadata.mjs';
import { SITE_ORIGIN } from './src/data/site-origin.mjs';
import { resolveSitemapLastmod } from './src/data/sitemap-lastmod.mjs';

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
