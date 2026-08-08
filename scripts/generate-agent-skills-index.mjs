/**
 * Compile the Agent Skills discovery index into src/data/agent-skills-index.json.
 *
 * Runs in `prebuild` (and `predev`) beside generate-a2a-digest.mjs, and the Astro route at
 * src/pages/.well-known/agent-skills/index.json.ts serves the result verbatim. Same posture as the
 * A2A digest, for the same two reasons: what deploys is exactly what a reviewer read, and the file
 * is small enough that a diff on it is a useful review signal rather than noise.
 *
 * The digest in here is the thing this exists to keep honest. A hand-maintained SHA-256 is wrong
 * the first time somebody edits a skill and fixes a typo, and the symptom lands in a stranger's
 * agent as "content failed verification, refusing to load" rather than anywhere Matt would see it.
 * Three things keep it true: this generator recomputes it from the skill file, tests/agent-skills
 * .test.mjs fails when the committed file drifts from a fresh run, and scripts/validate-agent-
 * skills-index.mjs re-derives it from the actual built output before the build is allowed to pass.
 *
 * All the interesting logic is in src/lib/agent-skills.mjs, shared with the routes so the served
 * bytes and the hashed bytes cannot come from different code paths.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSkillsIndex } from '../src/lib/agent-skills.mjs';

export const INDEX_PATH = fileURLToPath(
  new URL('../src/data/agent-skills-index.json', import.meta.url)
);

/** Write the index, returning true when the bytes on disk changed. */
export function writeSkillsIndex(path = INDEX_PATH) {
  const next = `${JSON.stringify(buildSkillsIndex(), null, 2)}\n`;
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // First run.
  }
  if (current === next) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, 'utf8');
  return true;
}

// The build targets Node 24, so import.meta.main is available; this spelling is kept because it
// also works under any older Node someone runs the script with by hand.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const changed = writeSkillsIndex();
  console.log(`[agent-skills] ${changed ? 'wrote' : 'unchanged'} src/data/agent-skills-index.json`);
}
