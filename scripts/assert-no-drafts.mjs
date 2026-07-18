// Fails the build if any draft:true writing entry leaked into dist/ — the HTML
// page, RSS, the sitemap, or llms.txt/llms-full.txt.
//
// SHOW_DRAFTS=true is a local-only preview flag (see CLAUDE.md "Previewing a
// draft") that lets a draft's HTML page render in a real production build.
// That page check is the ONLY thing this script skips under SHOW_DRAFTS — RSS,
// the sitemap, and llms.txt/llms-full.txt are never allowed to reference a
// draft, in any environment, flag or no flag.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const showDrafts = process.env.SHOW_DRAFTS === 'true';

if (showDrafts) {
  console.warn(
    '\n⚠️  assert-no-drafts: SHOW_DRAFTS=true — this build renders draft pages and is NOT a production artifact. Do not deploy dist/ from this build.\n'
  );
}

const failures = [];
let draftCount = 0;

for (const { dir, segment } of COLLECTIONS) {
  const draftSlugs = readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .filter((file) => /^draft:\s*true\s*$/m.test(readFileSync(dir + file, 'utf-8')))
    .map((file) => file.replace(/\.md$/, ''));

  draftCount += draftSlugs.length;

  for (const slug of draftSlugs) {
    // The rendered page is expected to exist under SHOW_DRAFTS — that's the whole
    // point of the flag. Never skippable in a plain production build.
    if (!showDrafts) {
      const pagePath = `${distDir}${segment}/${slug}/index.html`;
      if (existsSync(pagePath)) {
        failures.push(`${slug}: page rendered at dist/${segment}/${slug}/index.html`);
      }
    }

    // Never skippable, in either flag state — a draft must never reach these feeds.
    const filesToScan = ['llms.txt', 'llms-full.txt', 'sitemap-0.xml', 'sitemap-index.xml', 'rss.xml'];
    for (const file of filesToScan) {
      const filePath = distDir + file;
      if (!existsSync(filePath)) continue;
      if (readFileSync(filePath, 'utf-8').includes(`/${segment}/${slug}`)) {
        failures.push(`${slug}: referenced in dist/${file}`);
      }
    }
  }
}

if (draftCount === 0) {
  console.log('assert-no-drafts: no draft entries in writing or changelog — nothing to check.');
  process.exit(0);
}

if (failures.length > 0) {
  console.error('assert-no-drafts: draft entry/entries leaked into the build:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\nA draft must never reach RSS, the sitemap, or llms.txt — in any environment.');
  process.exit(1);
}

console.log(
  showDrafts
    ? `assert-no-drafts: ${draftCount} draft entry/entries correctly absent from RSS/sitemap/llms.txt (page render skipped — SHOW_DRAFTS=true).`
    : `assert-no-drafts: ${draftCount} draft entry/entries correctly absent from dist/.`
);
