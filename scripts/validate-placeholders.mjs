/**
 * Preflight: no published writing or changelog entry still holds a scaffold placeholder.
 *
 * `npm run new-post` seeds a draft with a placeholder description and a reminder comment, both
 * marked `REPLACE:`. Unreplaced, the description becomes the index card and the meta description
 * and the comment is served in the page's HTML. This fails the build first, with the file and the
 * line.
 *
 * In `prebuild` and not `predev`: a draft holds the placeholders by design and is exempt here in
 * every environment, and an author who has just flipped `draft` off should still get a dev server.
 *
 * Changelog has no scaffold today. It is covered because it is the other draft-capable
 * collection and the marker means the same thing there. Logic and tests:
 * scripts/lib/placeholders.mjs, tests/placeholders.test.mjs.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPublishedPlaceholders } from './lib/placeholders.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const failures = findPublishedPlaceholders({
  root,
  directories: ['writing', 'changelog'].map((name) => join(root, 'src', 'content', name)),
});

if (failures.length > 0) {
  console.error('validate-placeholders: a published entry still holds a scaffold placeholder:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\n  A draft may hold them. A published entry would show them on the page.');
  process.exit(1);
}

console.log('validate-placeholders: no published writing or changelog entry holds a scaffold placeholder.');
