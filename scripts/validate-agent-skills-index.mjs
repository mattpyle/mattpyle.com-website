/**
 * Validate the Agent Skills discovery index, against the RFC and against what actually built.
 *
 * Runs in the `build` chain after `astro build`, and that ordering is the point. The failure this
 * guards is not "the JSON is malformed" — a generator wrote it, so it will not be. It is "the
 * digest describes a file that is no longer what deploys", which only the built output can settle.
 * So every digest here is recomputed from the bytes sitting in the output roots, not from the
 * source the generator read.
 *
 * The failure mode matters because of who sees it. RFC section "Integrity and Verification" tells
 * clients they MUST verify the digest and MUST NOT use unverified content, so a stale digest does
 * not degrade gracefully: it presents to a stranger's agent as tampered content and the skill is
 * refused outright. Nothing about the site would look broken from here.
 *
 * ## Spec provenance
 *
 * Agent Skills Discovery RFC v0.2.0 (published 2026-01-17, updated 2026-03-12),
 * github.com/cloudflare/agent-skills-discovery-rfc at commit 1bd11679, read 2026-08-04.
 * scripts/lib/agent-skills-index.schema.json is the RFC's field tables transcribed into JSON
 * Schema; see that file's $comment for why it is a transcription rather than a vendored copy.
 *
 * ## What the schema cannot say
 *
 * Everything below the schema check: that the URL resolves to a file that actually built, in every
 * output root; that the file is non-empty and is a real SKILL.md; that its frontmatter agrees with
 * the index entry that pointed at it; and that its SHA-256 is the digest the index promised.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './lib/json-schema.mjs';
import {
  MAX_DESCRIPTION_LENGTH,
  SKILLS_INDEX_PATH,
  SKILLS_SCHEMA_URI,
  digestOf,
  isValidSkillName,
  normaliseSkillBody,
  parseSkillFrontmatter,
  skillUrlFor,
} from '../src/lib/agent-skills.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_PATH = join(root, 'scripts', 'lib', 'agent-skills-index.schema.json');

// Both roots, same reason as emit-markdown-siblings.mjs: dist/client is what the local audit
// serves, .vercel/output/static is what deploys, and a file present in one and missing from the
// other is exactly the bug that ships.
const OUTPUT_ROOTS = [join(root, 'dist', 'client'), join(root, '.vercel', 'output', 'static')].filter(
  (dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }
);

export function readSchema(path = SCHEMA_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The path a URL from the index maps to inside an output root. */
function outputPathFor(outputRoot, url) {
  return join(outputRoot, ...url.slice(1).split('/'));
}

/**
 * Schema conformance plus every check a schema cannot make.
 *
 * @param {object} index The parsed index document.
 * @param {object} schema
 * @param {string[]} outputRoots Built output directories to verify artifacts in.
 * @returns {string[]} Human-readable errors; empty means valid.
 */
export function validateSkillsIndex(index, schema, outputRoots) {
  const errors = validate(index, schema, schema, '', []);

  // A schema-level enum already pins this; repeated here because it is the one field whose
  // wrongness invalidates every other check in this file rather than just failing one of them.
  if (index.$schema !== SKILLS_SCHEMA_URI) {
    errors.push(`$schema: this build implements ${SKILLS_SCHEMA_URI}, index claims ${JSON.stringify(index.$schema)}`);
  }

  const skills = Array.isArray(index.skills) ? index.skills : [];
  if (skills.length === 0) {
    errors.push('skills: an index that lists nothing is worse than no index at all');
  }

  const seen = new Set();
  for (const [position, skill] of skills.entries()) {
    const where = `skills[${position}]`;
    const name = typeof skill?.name === 'string' ? skill.name : '';

    if (!isValidSkillName(name)) {
      errors.push(`${where}.name: ${JSON.stringify(skill?.name)} is not a valid Agent Skills name`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${where}.name: "${name}" is listed more than once`);
      continue;
    }
    seen.add(name);

    // Narrower than the spec on purpose. `archive` is a legitimate type, but nothing here builds a
    // tarball, so an entry claiming one could only have been hand-written — and a hand-written
    // entry with a hand-written digest is the failure this whole card exists to prevent.
    if (skill.type !== 'skill-md') {
      errors.push(`${where}.type: only "skill-md" is published by this site, found ${JSON.stringify(skill.type)}`);
      continue;
    }

    // Path-absolute, per the RFC's "URL Resolution". The site could serve an artifact from
    // anywhere, but a URL this validator cannot resolve to a built file is a URL it cannot verify.
    const expectedUrl = skillUrlFor(name);
    if (skill.url !== expectedUrl) {
      errors.push(`${where}.url: expected ${expectedUrl}, got ${JSON.stringify(skill.url)}`);
      continue;
    }

    for (const outputRoot of outputRoots) {
      const label = outputRoot.slice(root.length).replace(/\\/g, '/');
      const file = outputPathFor(outputRoot, skill.url);

      if (!existsSync(file)) {
        errors.push(`${where}: ${skill.url} did not build — nothing at ${label}${skill.url}`);
        continue;
      }

      const raw = readFileSync(file, 'utf8');
      if (raw.trim() === '') {
        errors.push(`${where}: ${skill.url} built empty in ${label}`);
        continue;
      }

      // The digest covers the bytes on disk exactly as served, so this reads the built file rather
      // than re-normalising it. normaliseSkillBody is applied only for the frontmatter comparison
      // below, where a CRLF checkout would otherwise produce a spurious mismatch.
      const actualDigest = digestOf(raw);
      if (actualDigest !== skill.digest) {
        errors.push(
          `${where}.digest: ${label}${skill.url} hashes to ${actualDigest}, index claims ${skill.digest}`
        );
      }

      let frontmatter;
      try {
        frontmatter = parseSkillFrontmatter(normaliseSkillBody(raw), `${label}${skill.url}`);
      } catch (error) {
        errors.push(`${where}: ${error.message}`);
        continue;
      }

      if (frontmatter.name !== name) {
        errors.push(`${where}: the artifact's frontmatter name is "${frontmatter.name}", the index calls it "${name}"`);
      }
      // "SHOULD match the description field in the skill's SKILL.md frontmatter." Enforced as a
      // MUST here: the index description is what an agent decides on before fetching anything, so
      // a drift between the two is a promise the artifact does not keep.
      if (frontmatter.description !== skill.description) {
        errors.push(`${where}.description: does not match the artifact's frontmatter description`);
      }
    }

    if (typeof skill.description === 'string' && [...skill.description].length > MAX_DESCRIPTION_LENGTH) {
      errors.push(`${where}.description: over the ${MAX_DESCRIPTION_LENGTH} character limit`);
    }
  }

  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (OUTPUT_ROOTS.length === 0) {
    console.error('validate-agent-skills-index: no build output found — run `astro build` first.');
    process.exit(1);
  }

  const failures = [];
  const indexes = [];

  for (const outputRoot of OUTPUT_ROOTS) {
    const label = outputRoot.slice(root.length).replace(/\\/g, '/');
    const file = outputPathFor(outputRoot, SKILLS_INDEX_PATH);
    if (!existsSync(file)) {
      failures.push(`${SKILLS_INDEX_PATH} did not build — nothing at ${label}${SKILLS_INDEX_PATH}`);
      continue;
    }
    try {
      indexes.push(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      failures.push(`${label}${SKILLS_INDEX_PATH}: not parseable JSON — ${error.message}`);
    }
  }

  if (indexes.length > 0) {
    failures.push(...validateSkillsIndex(indexes[0], readSchema(), OUTPUT_ROOTS));
    // Both roots must serve the same document; the adapter's copy step is the thing being trusted.
    for (const other of indexes.slice(1)) {
      if (JSON.stringify(other) !== JSON.stringify(indexes[0])) {
        failures.push('the two output roots hold different indexes');
      }
    }
  }

  if (failures.length > 0) {
    console.error('Agent Skills index validation failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  const count = indexes[0].skills.length;
  console.log(
    `[agent-skills] ${SKILLS_INDEX_PATH} conforms to RFC v0.2.0; ` +
      `${count} skill${count === 1 ? '' : 's'} verified against the built artifacts in ${OUTPUT_ROOTS.length} output root(s)`
  );
}
