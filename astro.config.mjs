// @ts-check
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';
import { readWritingMetadata } from './scripts/lib/writing-metadata.mjs';
import { SITE_ORIGIN } from './src/data/site-origin.mjs';
import { ON_DEMAND_PAGES, resolveSitemapLastmod } from './src/data/sitemap-lastmod.mjs';
import { PRE_PAINT_APPEARANCE_SCRIPT } from './src/lib/pre-paint-appearance.mjs';
import { videoEmbedMdastPlugin } from './src/lib/video-embed.mjs';
import { stripEmptySrcset } from './scripts/lib/empty-srcset.mjs';

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
  // DO NOT set `trailingSlash: 'always'` here. It reads like free dev parity with the
  // slash normalisation in middleware.ts, and it was adopted on that basis and then
  // reverted, measured on a preview deployment:
  //
  //   - The Vercel adapter turns it into a global 308 route in .vercel/output/config.json
  //     (`"src": "^/((?:[^/]+/)*[^/\\.]+)$"`), which is a second, wider redirect than the
  //     one the middleware issues, applied to paths the matcher deliberately excludes.
  //   - It registers /a2a at the slash form only (`"src": "^/a2a/$"`), so `POST /a2a`
  //     308'd. That is the endpoint the Agent Card, agents.md, and the `_a2a._agents` DNS
  //     record publish, and a client that does not follow redirects on POST loses it.
  //
  // Astro's setting is global with no per-route opt-out, so there is no spelling of it
  // that spares /a2a. Slash normalisation belongs in middleware.ts, where the matcher
  // decides what it reaches. The cost of leaving this unset is real but small: the dev
  // server answers both shapes, so a link that regresses to the slash-less form looks
  // fine locally and only costs a redirect once deployed.
  //
  // Build output does not depend on this either way: `build.format` is 'directory' (the
  // default), so every page is emitted as <route>/index.html and every canonical, sitemap
  // entry, and OG URL already carries the slash.
  // Astro 7 renders markdown through Sätteri, and naming the processor here is
  // the only way to add a plugin to it: `markdown.remarkPlugins` is deprecated
  // and @astrojs/markdown-remark is not installed. `satteri()` with no plugins is
  // exactly the default, so the one plugin below is the whole difference.
  //
  // It rewrites the `<Video />` tag Keystatic writes into a post. See
  // src/lib/video-embed.mjs for the shape it matches and for the two agent routes
  // that share the same helper.
  markdown: {
    syntaxHighlight: false,
    processor: satteri({ mdastPlugins: [videoEmbedMdastPlugin] }),
  },
  vite: {
    ssr: {
      // @mattpyle/steward is a workspace package that ships TypeScript source
      // with no build step, so the /mcp function's one import of it has to be
      // transpiled rather than left as a runtime `import` of a .ts file. Vite
      // usually infers this for a linked package; declaring it means the build
      // does not depend on that inference, which is the same reasoning that puts
      // the package in the root dependency list rather than relying on hoisting.
      //
      // Only the package itself. Its transitive `undici` stays external and is
      // traced into the function by the adapter like any other dependency.
      noExternal: ['@mattpyle/steward'],
    },
  },
  // 'never': keep CSS in external files. Astro's default ('auto') inlines small
  // bundles as <style> tags, which a strict style-src CSP (no 'unsafe-inline')
  // blocks outright.
  build: { inlineStylesheets: 'never' },
  security: {
    csp: {
      // These directives duplicate the Content-Security-Policy in vercel.json on
      // purpose, and the two must be edited together. Astro emits its policy as a
      // <meta> on a prerendered page, where it stacks with the vercel.json header,
      // but as a real response header on an on-demand render (/scorecard), and a
      // framework-set header *replaces* the vercel.json one rather than merging
      // with it. Before 2026-08-06 that left /scorecard with script-src and
      // style-src alone: no frame-ancestors, so the page was framable by any
      // origin. Declaring the full set here makes Astro's policy self-sufficient
      // whichever way it ships. See section 3 of the phase-one security audit.
      // frame-ancestors is ignored inside a <meta>; on the prerendered pages that
      // is fine, because the vercel.json header carries it there.
      directives: [
        // Nothing is loaded off-origin: fonts are self-hosted, there are no
        // frames, workers, or manifests. default-src exists so the directives
        // nobody thought to declare stop being unrestricted.
        //
        // It lives here and NOT in the vercel.json header, which is the one
        // place the two policies differ on purpose. A prerendered page carries
        // both, and a browser enforces their intersection: an inline script has
        // to be allowed by every policy present. The vercel.json header declares
        // no script-src, so adding default-src there would make 'self' the
        // fallback for scripts and refuse all 70 inline scripts on the site,
        // pre-paint appearance included, because the hashes that permit them
        // exist only in this policy. The rule: default-src belongs only in a
        // policy that also carries the script hashes.
        "default-src 'self'",
        "font-src 'self'",
        "img-src 'self'",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ],
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
      // The integration builds its list by walking the pages the build emitted, so an on-demand
      // page is invisible to it — /scorecard would silently drop out of the sitemap the moment it
      // stopped prerendering. These are declared instead, and still pass through `filter` and
      // `serialize`, so they get the same lastmod policy as everything else.
      customPages: ON_DEMAND_PAGES.map((pathname) => `${SITE_ORIGIN}${pathname}`),
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
    // One upstream defect, swept up at the end of the build: Astro serialises an empty
    // `srcset=""` on content-collection markdown images that produce no responsive variant, which
    // is a markup validity error. See scripts/lib/empty-srcset.mjs for the upstream code path and
    // the check that says when this can be deleted.
    {
      name: 'strip-empty-srcset',
      hooks: {
        'astro:build:done': async ({ dir, logger }) => {
          const root = fileURLToPath(dir);
          let files = 0;
          let removed = 0;
          for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
            if (!file.isFile() || !file.name.endsWith('.html')) continue;
            const full = join(file.parentPath, file.name);
            const result = stripEmptySrcset(readFileSync(full, 'utf8'));
            if (result.removed === 0) continue;
            writeFileSync(full, result.html, 'utf8');
            files++;
            removed += result.removed;
          }
          if (removed > 0) logger.info(`removed ${removed} empty srcset attribute(s) from ${files} page(s)`);
        },
      },
    },
  ],
});
