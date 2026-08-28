/**
 * Validate public/.well-known/ard.json against the ARD specification, and against this site.
 *
 * Runs in the `build` chain beside validate-a2a-card.mjs and validate-mcp-discovery.mjs, and
 * exists for the same reason: the catalogue is a hand-written static file that no build step
 * generates, so it is one of the artifacts here that can silently rot. Its particular failure is
 * that it points at four other documents — an entry naming an artifact that has moved sends an
 * agent somewhere the site does not serve, and the entry still looks perfectly well-formed.
 *
 * ## Why the checks are these checks
 *
 * The required entry terms come from ARD v0.91 §4.2: `identifier`, `displayName`, `type`, and
 * exactly one of `url` or `data` (§4.3). `representativeQueries` is a SHOULD in the spec and a
 * warning in the conformance tester (§D.2), asserted here as an error because every entry this
 * site publishes has it and losing one would silently make that resource unfindable by search,
 * which is the entire reason the catalogue exists.
 *
 * The identifier pattern is the spec's own (Appendix C) with the publisher segment pinned to this
 * domain: an entry here that claims a different publisher is a mistake, not an extension.
 *
 * ## The three decisions this file exists to hold
 *
 * **1. The skill entries keep `type: "application/ai-skill+md"`, and the conformance CLI's two
 * warnings about it are accepted.** `conformance/bin/conformance-test manifest` reports PASS with
 * 2 warnings against this file, both saying that media type "is not one of standard discovery
 * types". The tool's list and the specification text disagree: §4.4's own worked skill example
 * uses `application/ai-skill+md`, and the tool offers `text/markdown; profile="urn:air:agent-skills"`
 * instead. The spec text wins here, so a future run of the CLI reporting exactly those 2 warnings
 * is the expected result and not drift. Asserted rather than left as a comment because the
 * obvious way to "fix" a warning is to change the value, and the change would look like an
 * improvement.
 *
 * **2. `specVersion` is `"1.0"`, and it does not name the ARD version.** ARD v0.91's `ArdManifest`
 * requires only `entries` and ignores unknown top-level members, so this line is invisible to a
 * conformant ARD consumer. It is here for the predecessor `AICatalogManifest` envelope, which
 * requires it and pins it to the enum `["1.0"]` — that value is the ai-catalog *data model*
 * version, not the spec version, which is why the number does not track ARD's. Verified 2026-08-27
 * against isitagentready.com, whose `discovery.ard` check failed this site with "ARD capability
 * manifest is missing required specVersion" while the manifest was otherwise conformant. Their own
 * published skill states the field "refers to the ai-catalog data model, not the ARD spec version".
 * So: not "0.91", ever, however much the surrounding document is about v0.91.
 *
 * **3. The skill entries track the generated skills index.** The index is built from the files in
 * src/data/skills/, and this catalogue is hand-written, so publishing a third skill would leave the
 * catalogue quietly describing two. Same guard, and the same reasoning, as the literal list in
 * tests/agent-surfaces.test.mjs: the diff that keeps a hand-written list honest is the one that
 * fails when the generated source moves under it.
 *
 * Not asserted: the four `url`s resolving. Each already has its own validator in this chain —
 * validate-a2a-card, validate-mcp-discovery, validate-agent-skills-index — and a fourth check that
 * the same documents exist would fail in pairs and say nothing new.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readSkills, skillUrlFor } from '../src/lib/agent-skills.mjs';

const DOCUMENT = fileURLToPath(new URL('../public/.well-known/ard.json', import.meta.url));
const ORIGIN = 'https://www.mattpyle.com';
const PUBLISHER = 'mattpyle.com';

/**
 * Appendix C: urn:air:<publisher>:<namespace>:<name>, publisher pinned to this domain.
 *
 * Written as a literal rather than built from PUBLISHER. Interpolating a string into a RegExp
 * means escaping it, and a hand-rolled escape that covers `.` but not `\` is what CodeQL's
 * js/incomplete-sanitization flags — correctly, even though the input here is a constant two lines
 * up. There is nothing dynamic to earn the risk, so the pattern says the domain itself.
 */
const IDENTIFIER_PATTERN = /^urn:air:mattpyle\.com(?::[a-zA-Z0-9._-]+){2,}$/;

/** Decision 1. The spec's §4.4 example type for a markdown skill; the CLI's type list disagrees. */
const SKILL_TYPE = 'application/ai-skill+md';

/** Decision 2. The ai-catalog data model version, not ARD's. The predecessor enum is exactly this. */
const SPEC_VERSION = '1.0';

const failures = [];

let manifest;
try {
  manifest = JSON.parse(readFileSync(DOCUMENT, 'utf8'));
} catch (error) {
  console.error(`✗ /.well-known/ard.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

if (manifest.specVersion !== SPEC_VERSION) {
  failures.push(
    `specVersion must be ${JSON.stringify(SPEC_VERSION)}, the ai-catalog data model version the predecessor envelope pins; found ${JSON.stringify(manifest.specVersion)}`
  );
}

const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
if (entries.length === 0) {
  failures.push('entries must be a non-empty array (§5.1)');
}

for (const [index, entry] of entries.entries()) {
  const where = entry?.identifier ?? `entries[${index}]`;

  if (!IDENTIFIER_PATTERN.test(entry?.identifier ?? '')) {
    failures.push(`[${where}] identifier must be urn:air:${PUBLISHER}:<namespace>:<name> (Appendix C)`);
  }
  for (const field of ['displayName', 'type']) {
    if (typeof entry?.[field] !== 'string' || entry[field].length === 0) {
      failures.push(`[${where}] ${field} is required and must be a non-empty string (§4.2)`);
    }
  }

  const hasUrl = typeof entry?.url === 'string';
  const hasData = entry?.data !== undefined;
  if (hasUrl === hasData) {
    failures.push(`[${where}] must carry exactly one of url or data (§4.3)`);
  }
  if (hasUrl && !entry.url.startsWith(`${ORIGIN}/`)) {
    failures.push(`[${where}] url must be an absolute URL on ${ORIGIN}; found ${JSON.stringify(entry.url)}`);
  }

  const queries = entry?.representativeQueries;
  if (!Array.isArray(queries) || queries.length < 2 || queries.length > 5) {
    failures.push(`[${where}] representativeQueries must hold 2 to 5 examples (§4.2, §D.2); found ${Array.isArray(queries) ? queries.length : 'none'}`);
  }
}

// Decisions 1 and 3, together: the skill entries are exactly the published skills, and each one
// keeps the media type the conformance CLI warns about.
const skillEntries = entries.filter((entry) => String(entry?.identifier ?? '').includes(':skill:'));
const expectedSkillUrls = readSkills().map((skill) => `${ORIGIN}${skillUrlFor(skill.name)}`);
const foundSkillUrls = skillEntries.map((entry) => entry.url);

if (JSON.stringify([...foundSkillUrls].sort()) !== JSON.stringify([...expectedSkillUrls].sort())) {
  failures.push(
    `the skill entries must be the published skills — expected ${JSON.stringify(expectedSkillUrls.sort())}, found ${JSON.stringify([...foundSkillUrls].sort())}`
  );
}

for (const entry of skillEntries) {
  if (entry.type !== SKILL_TYPE) {
    failures.push(
      `[${entry.identifier}] type must stay ${SKILL_TYPE}, the spec's §4.4 example type. The conformance CLI warns about it and the warning is accepted; see this file's docblock before changing it. Found ${JSON.stringify(entry.type)}`
    );
  }
}

if (failures.length > 0) {
  console.error('✗ /.well-known/ard.json is invalid:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `✓ /.well-known/ard.json conforms to ARD v0.91; ${entries.length} entries, ${skillEntries.length} tracking the skills index, 2 accepted conformance warnings`
);
