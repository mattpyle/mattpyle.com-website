// @ts-check
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const writingDir = fileURLToPath(new URL('./src/content/writing/', import.meta.url));

const writingFiles = readdirSync(writingDir).filter((file) => file.endsWith('.md'));

/** @type {Record<string, string>} slug -> ISO date, read from frontmatter */
const writingDates = Object.fromEntries(
  writingFiles
    .map((file) => {
      const source = readFileSync(writingDir + file, 'utf-8');
      const match = source.match(/^date:\s*"?(\d{4}-\d{2}-\d{2})"?/m);
      return [file.replace(/\.md$/, ''), match?.[1] ?? ''];
    })
    .filter(([, date]) => date !== '')
);

/** @type {Set<string>} slugs of draft: true posts — SHOW_DRAFTS must never leak these into the sitemap. */
const draftSlugs = new Set(
  writingFiles
    .filter((file) => /^draft:\s*true\s*$/m.test(readFileSync(writingDir + file, 'utf-8')))
    .map((file) => file.replace(/\.md$/, ''))
);

export default defineConfig({
  // www is the canonical host — the apex 308s to it at the edge (Vercel). Every
  // absolute URL (canonicals, OG, sitemap, JSON-LD, llms.txt, RSS) inherits this.
  site: 'https://www.mattpyle.com',
  markdown: { syntaxHighlight: false },
  // 'never': keep CSS in external files. Astro's default ('auto') inlines small
  // bundles as <style> tags, which a strict style-src CSP (no 'unsafe-inline')
  // blocks outright.
  build: { inlineStylesheets: 'never' },
  experimental: {
    csp: {
      // Google Fonts stylesheet link needs to stay allowed under the auto-generated,
      // per-page style-src hash policy — otherwise it's only allowed by vercel.json's
      // header CSP, and a header + meta CSP pair is enforced as an *intersection*.
      styleDirective: { resources: ["'self'", 'https://fonts.googleapis.com'] },
    },
  },
  integrations: [
    sitemap({
      filter: (url) => {
        const slug = url.replace(/\/$/, '').split('/writing/')[1];
        return !slug || !draftSlugs.has(slug);
      },
      serialize(item) {
        const slug = item.url.replace(/\/$/, '').split('/writing/')[1];
        const date = slug && writingDates[slug];
        if (date) item.lastmod = date;
        return item;
      },
    }),
  ],
});
