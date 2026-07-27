// Fails the build if any draft:true writing entry leaked into dist/ — the HTML
// page, RSS, the sitemap, or llms.txt/llms-full.txt.
//
// SHOW_DRAFTS=true is a local-only preview flag (see CLAUDE.md "Previewing a
// draft") that lets a draft's HTML page render in a real production build.
// That page check is the ONLY thing this script skips under SHOW_DRAFTS — RSS,
// the sitemap, and llms.txt/llms-full.txt are never allowed to reference a
// draft, in any environment, flag or no flag.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readWritingMetadata } from './lib/writing-metadata.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// The @astrojs/vercel adapter (needed for the on-demand /writing/[slug].md
// endpoint) makes Astro write static output to dist/client/, not dist/ —
// dist/ itself now only holds the adapter's server bundle.
const distDir = `${root}dist/client/`;

// Every draft-capable content collection: its source dir and the URL segment its
// pages/feed references use. A draft in any of these must never reach dist/.
const COLLECTIONS = [
  { dir: `${root}src/content/writing/`, segment: 'writing' },
  { dir: `${root}src/content/changelog/`, segment: 'changelog' },
];

// The feeds a draft must never appear in, whatever the flag state.
const FEED_FILES = ['llms.txt', 'llms-full.txt', 'sitemap-0.xml', 'sitemap-index.xml', 'rss.xml'];

/**
 * Matches a reference to exactly this entry, and not to an entry whose slug
 * merely starts with it.
 *
 * A plain `includes('/writing/' + slug)` failed a build whenever a published
 * post's slug extended a draft's: draft `foo` matched published `foo-bar`. The
 * trailing guard requires the next character to end the slug — a `/` before the
 * trailing slash, a `.` before `.md`, or a quote/angle bracket in the sitemap
 * and RSS markup — so `foo` no longer matches `foo-bar` while every genuine
 * reference still hits. Nested slugs (`a/b`) work unchanged, since the guard
 * only inspects what follows the whole slug.
 */
export function referenceRe(segment, slug) {
  const escaped = `/${segment}/${slug}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![A-Za-z0-9_-])`);
}

/**
 * The draft slugs in one collection directory.
 *
 * Shares the content pipeline's own frontmatter parser rather than regexing the
 * whole file. Scanning raw source for /^draft:\s*true$/m matched a `draft: true`
 * line inside a fenced code block, so a published post that *documented*
 * frontmatter failed the build — a likely post on a site whose subject matter is
 * frontmatter and agent standards. The shared helper also recurses
 * subdirectories and handles .mdx, both of which the old inline scan silently
 * skipped, so a nested draft was invisible to this check entirely.
 */
export function draftSlugsIn(dir) {
  return [...readWritingMetadata(dir)]
    .filter(([, meta]) => meta.draft)
    .map(([slug]) => slug);
}

/**
 * Every leak found, as human-readable strings. Pure apart from reading dist/, so
 * a test can point it at a fixture tree.
 */
export function findLeaks({ collections = COLLECTIONS, dist = distDir, showDrafts = false } = {}) {
  const failures = [];
  let draftCount = 0;

  for (const { dir, segment } of collections) {
    const draftSlugs = draftSlugsIn(dir);
    draftCount += draftSlugs.length;

    for (const slug of draftSlugs) {
      // The rendered page is expected to exist under SHOW_DRAFTS — that's the
      // whole point of the flag. Never skippable in a plain production build.
      if (!showDrafts) {
        const pagePath = `${dist}${segment}/${slug}/index.html`;
        if (existsSync(pagePath)) {
          failures.push(`${slug}: page rendered at dist/${segment}/${slug}/index.html`);
        }
      }

      const reference = referenceRe(segment, slug);
      for (const file of FEED_FILES) {
        const filePath = dist + file;
        if (!existsSync(filePath)) continue;
        if (reference.test(readFileSync(filePath, 'utf-8'))) {
          failures.push(`${slug}: referenced in dist/${file}`);
        }
      }
    }
  }

  return { failures, draftCount };
}

export function main() {
  const showDrafts = process.env.SHOW_DRAFTS === 'true';

  if (showDrafts) {
    console.warn(
      '\n⚠️  assert-no-drafts: SHOW_DRAFTS=true — this build renders draft pages and is NOT a production artifact. Do not deploy dist/ from this build.\n'
    );
  }

  const { failures, draftCount } = findLeaks({ showDrafts });

  if (draftCount === 0) {
    console.log('assert-no-drafts: no draft entries in writing or changelog — nothing to check.');
    return 0;
  }

  if (failures.length > 0) {
    console.error('assert-no-drafts: draft entry/entries leaked into the build:\n');
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error('\nA draft must never reach RSS, the sitemap, or llms.txt — in any environment.');
    return 1;
  }

  console.log(
    showDrafts
      ? `assert-no-drafts: ${draftCount} draft entry/entries correctly absent from RSS/sitemap/llms.txt (page render skipped — SHOW_DRAFTS=true).`
      : `assert-no-drafts: ${draftCount} draft entry/entries correctly absent from dist/.`
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
