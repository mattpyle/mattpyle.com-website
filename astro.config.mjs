// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';
import { readWritingMetadata } from './scripts/lib/writing-metadata.mjs';
import { resolveSitemapLastmod } from './src/data/sitemap-lastmod.mjs';

const writingDir = fileURLToPath(new URL('./src/content/writing/', import.meta.url));
const writingMetadata = readWritingMetadata(writingDir);

/** @param {string} url */
function writingSlug(url) {
  const pathname = new URL(url).pathname;
  return pathname.startsWith('/writing/') && pathname !== '/writing/'
    ? decodeURIComponent(pathname.slice('/writing/'.length).replace(/\/$/, ''))
    : undefined;
}

export default defineConfig({
  // www is the canonical host — the apex 308s to it at the edge (Vercel). Every
  // absolute URL (canonicals, OG, sitemap, JSON-LD, llms.txt, RSS) inherits this.
  site: 'https://www.mattpyle.com',
  // Output stays 'static' (the default) — every page still prerenders exactly
  // as before. The adapter only exists so a handful of routes can opt into
  // on-demand rendering per-page via `export const prerender = false` (see
  // src/pages/writing/[slug].md.ts), which static output alone can't run.
  adapter: vercel(),
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
        const slug = writingSlug(url);
        return !slug || !writingMetadata.get(slug)?.draft;
      },
      serialize(item) {
        const lastmod = resolveSitemapLastmod(new URL(item.url).pathname, writingMetadata);
        if (!lastmod) {
          throw new Error(`Sitemap URL ${item.url} has no lastmod policy`);
        }
        item.lastmod = lastmod;
        return item;
      },
    }),
  ],
});
