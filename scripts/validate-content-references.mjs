/**
 * Preflight: every relative asset path in content frontmatter resolves, exactly.
 *
 * Astro already fails on an unresolvable `hero`, and that is correct — what this adds is the
 * address, not the failure. Reproduced 2026-08-09 with a deliberate typo in
 * `src/content/changelog/astro-rebuild.md`, `npm run build` reports:
 *
 *   [ImageNotFound] Could not find requested image `../../assets/tech-stak.png`. Does it exist?
 *     Location: node_modules/astro/dist/content/vite-plugin-content-assets.js:42:19
 *
 * The bad value, then a stack inside node_modules. Nothing says which entry wrote it, and one bad
 * entry fails the whole collection, so every page 500s at once. `npm run dev` does carry the entry
 * — percent-encoded inside a code frame of the generated `.astro/content-assets.mjs`
 * (`?importer=src%2Fcontent%2Fchangelog%2Fastro-rebuild.md`) — but only in the browser overlay;
 * the terminal prints the same message the build does.
 *
 * So this runs first, in `prebuild` and `predev`, and names the file, the field, the value, and
 * where it looked. It also checks the spelling of every path segment against what is on disk:
 * Matt's machine is Windows and the site builds on Linux, so `../../assets/Tech-Stack.png` is a
 * local success and a Vercel failure, which is the same bug with a worse place to find it.
 *
 * Generic rather than a list of field names, so a new image-shaped field is covered the day it is
 * added rather than the day someone remembers this file. Logic and tests:
 * scripts/lib/content-references.mjs, tests/content-references.test.mjs.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrokenContentReferences } from './lib/content-references.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const failures = findBrokenContentReferences({ root, contentRoot: join(root, 'src', 'content') });

if (failures.length > 0) {
  console.error('validate-content-references: a content entry references a file that is not there:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  console.error('  Fix the path in the frontmatter above. Astro fails on this too, but reports the');
  console.error('  bad value without saying which entry wrote it.');
  process.exit(1);
}

console.log('validate-content-references: every relative frontmatter path resolves, with the casing on disk.');
