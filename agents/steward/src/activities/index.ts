/**
 * Activity registry. One worker process registers both queues (spec §3), so the
 * same module is used for each — the split that matters is which *stub* the
 * workflow calls, not which functions exist where.
 *
 * Phase 1a implements the light set only. `vale`, `build-audit`, `editorial`,
 * `patches`, `publish`, and `verify-deploy` land in later phases.
 */
export { snapshotDraft, currentContentHash } from './snapshot.js';
export { runCspell } from './cspell.js';
export { checkFrontmatter } from './frontmatter.js';
export { synthesizeReport } from './synthesize.js';
export { archiveReport } from './archive.js';
