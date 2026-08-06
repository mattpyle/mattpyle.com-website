/**
 * The Agent Skills discovery index, and the one rule that generates it.
 *
 * Implements the Agent Skills Discovery RFC v0.2.0 (published 2026-01-17, updated 2026-03-12),
 * github.com/cloudflare/agent-skills-discovery-rfc at commit 1bd11679, read 2026-08-04. The
 * version is pinned here and in docs/work/agent-skills-index.md for the same reason the DNS-AID
 * draft number is pinned in agents.md: when the spec moves, the delta should be a diff against a
 * named version rather than an archaeology problem.
 *
 * ## One rule, no registry
 *
 * A skill is a markdown file in src/data/skills/. Its filename is its name, its frontmatter
 * supplies the description, and its URL is derived. Publishing a second skill is adding a file;
 * there is no list to update in three places and no way for the list to disagree with the disk.
 *
 * ## Why the body is normalised to LF
 *
 * The digest must equal the SHA-256 of the bytes an agent actually downloads. This repo has no
 * .gitattributes and core.autocrlf is on, so the same skill file is CRLF in a Windows working
 * tree and LF in CI and on the deployed build. Hashing the file as read would produce a digest
 * that is correct on whichever machine ran the generator and wrong everywhere else, and the
 * failure would only show up as a verification error inside somebody else's agent. Normalising
 * once, here, and serving that same normalised string from the route is what makes the digest a
 * property of the content rather than of the checkout.
 *
 * Build-time only. Nothing here reaches the browser: the index and the SKILL.md routes both
 * prerender, and the validator and generator run in npm scripts.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The opaque schema identifier for the version implemented here. RFC section "Versioning". */
export const SKILLS_SCHEMA_URI = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

/** Where publishers MUST put the index, per the RFC's "URI Structure". */
export const SKILLS_INDEX_PATH = '/.well-known/agent-skills/index.json';

/** Source of truth for every published skill. One markdown file per skill, named for the skill. */
export const SKILLS_DIR = fileURLToPath(new URL('../data/skills/', import.meta.url));

/**
 * The Agent Skills naming rules, transcribed from the RFC's "URI Structure": 1-64 characters,
 * lowercase alphanumeric and hyphens, no leading, trailing, or consecutive hyphens. The alternation
 * expresses all three hyphen rules at once, so there is nothing to keep in sync with a length check
 * beyond the bound below.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Max description length, per the Agent Skills spec as cited by the RFC's index field table. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** @param {string} name */
export function isValidSkillName(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 64 && SKILL_NAME_PATTERN.test(name);
}

/** The URL an agent fetches a skill-md artifact from. Conventional shape, per "URL Resolution". */
export function skillUrlFor(name) {
  return `/.well-known/agent-skills/${name}/SKILL.md`;
}

/**
 * The exact bytes served for a skill, as a string: BOM stripped, CRLF folded to LF, trailing
 * newline guaranteed. See the file header for why this is not optional.
 *
 * @param {string} source Raw file contents.
 */
export function normaliseSkillBody(source) {
  const body = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return body.endsWith('\n') ? body : `${body}\n`;
}

/**
 * `sha256:{hex}`, 64 lowercase hex characters, over the UTF-8 bytes of `body`. RFC section
 * "Integrity and Verification".
 *
 * @param {string} body
 */
export function digestOf(body) {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/**
 * `name` and `description` out of a SKILL.md's YAML frontmatter.
 *
 * Deliberately not the general frontmatter reader in scripts/lib: a SKILL.md carries exactly two
 * scalar fields that the Agent Skills specification requires, this refuses everything else, and
 * keeping it here is what lets src/lib stay independent of the content pipeline. A skill that
 * needs richer frontmatter should change this on purpose.
 *
 * @param {string} body @param {string} where
 * @returns {{ name: string, description: string }}
 */
export function parseSkillFrontmatter(body, where) {
  const match = body.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`${where}: SKILL.md must open with YAML frontmatter`);

  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of match[1].split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(': ');
    if (separator === -1) {
      throw new Error(`${where}: frontmatter line is not a "key: value" pair: ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 2).trim();
    if (!value) throw new Error(`${where}: frontmatter key "${key}" has no value`);
    fields[key] = value;
  }

  for (const key of ['name', 'description']) {
    if (!fields[key]) throw new Error(`${where}: frontmatter is missing required key "${key}"`);
  }
  return { name: fields.name, description: fields.description };
}

/**
 * Every published skill, read off disk in filename order so the index is byte-stable across
 * machines and filesystems.
 *
 * The frontmatter `name` must equal the filename. Two spellings of a skill's identity is one
 * spelling too many: the filename decides the URL and the frontmatter is what an agent reads
 * after fetching, so a mismatch would mean the artifact disagrees with the index that sent you
 * to it. Checked here rather than in the validator so `npm run dev` fails on it too.
 *
 * @param {string} [dir]
 * @returns {{ name: string, type: 'skill-md', description: string, url: string, digest: string, body: string, file: string }[]}
 */
export function readSkills(dir = SKILLS_DIR) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const slug = file.slice(0, -'.md'.length);
      const where = `src/data/skills/${file}`;
      const body = normaliseSkillBody(readFileSync(`${dir}${file}`, 'utf8'));
      const { name, description } = parseSkillFrontmatter(body, where);

      if (name !== slug) {
        throw new Error(`${where}: frontmatter name "${name}" does not match the filename "${slug}"`);
      }
      if (!isValidSkillName(name)) {
        throw new Error(`${where}: "${name}" is not a valid Agent Skills name (1-64 chars, lowercase alphanumeric and single hyphens)`);
      }
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        throw new Error(`${where}: description is ${description.length} characters, over the ${MAX_DESCRIPTION_LENGTH} limit`);
      }

      return {
        name,
        // Every skill here is a single SKILL.md. An archive would need a build step to produce
        // the tarball and a digest over it; nothing published yet has supporting files.
        type: /** @type {'skill-md'} */ ('skill-md'),
        description,
        url: skillUrlFor(name),
        digest: digestOf(body),
        body,
        file,
      };
    });
}

/**
 * The first sentence of a skill description, used as its one-line gloss in llms.txt.
 *
 * Naive on purpose: the first period followed by whitespace or end of string. It survives the
 * shapes descriptions actually take here (`mattpyle.com`, `v0.2.0`, `text/markdown` all keep their
 * periods, because none is followed by a space) and would truncate early on an inline "e.g. ",
 * which is a reason not to write one in a description rather than a reason for a parser.
 *
 * @param {string} description
 */
export function firstSentence(description) {
  const match = description.match(/^[\s\S]*?\.(?=\s|$)/);
  return match ? match[0] : description;
}

/**
 * The llms.txt entry for the Agent Skills index: a line for the index itself, then one nested line
 * per skill, enumerated from the committed index.
 *
 * Enumerated rather than hand-written because llms.txt previously named the single skill in prose,
 * which is a sentence that goes stale the day a second skill lands. Publishing a skill is adding a
 * file in src/data/skills/; this keeps that true for llms.txt too.
 *
 * @param {string} base Origin with no trailing slash.
 * @param {{ name: string, description: string, url: string }[]} skills
 * @returns {string[]} Lines, ready to push.
 */
export function formatSkillsIndexLines(base, skills) {
  const count = skills.length;
  const lines = [
    `- [Agent Skills index](${base}${SKILLS_INDEX_PATH}): the Agent Skills Discovery RFC v0.2.0 index. It lists ${count} skill${count === 1 ? '' : 's'}, each with a sha256 digest of the artifact so a client can verify what it downloaded.`,
  ];
  for (const skill of skills) {
    lines.push(`  - [${skill.name}](${base}${skill.url}): ${firstSentence(skill.description)}`);
  }
  return lines;
}

/**
 * The index document, exactly as served.
 *
 * URLs are path-absolute rather than fully qualified, which the RFC's "URL Resolution" resolves
 * against the origin that served the index. That is the right choice here and the opposite of the
 * A2A Agent Card's: the card names a service endpoint, which a preview deployment must not claim
 * to be, while these URLs name artifacts alongside the index itself, so a preview should serve its
 * own copies and a production fetch should get production's.
 *
 * No `generated` timestamp, same reason as the A2A digest: the file is committed, and a wall-clock
 * field would make every build a diff while telling a reader nothing the digest does not.
 *
 * @param {string} [dir]
 */
export function buildSkillsIndex(dir = SKILLS_DIR) {
  return {
    $schema: SKILLS_SCHEMA_URI,
    skills: readSkills(dir).map(({ name, type, description, url, digest }) => ({
      name,
      type,
      description,
      url,
      digest,
    })),
  };
}
