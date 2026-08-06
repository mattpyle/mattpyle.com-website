import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_DESCRIPTION_LENGTH,
  SKILLS_INDEX_PATH,
  SKILLS_SCHEMA_URI,
  buildSkillsIndex,
  digestOf,
  firstSentence,
  formatSkillsIndexLines,
  isValidSkillName,
  normaliseSkillBody,
  parseSkillFrontmatter,
  readSkills,
  skillUrlFor,
} from '../src/lib/agent-skills.mjs';
import { readSchema, validateSkillsIndex } from '../scripts/validate-agent-skills-index.mjs';

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/data/agent-skills-index.json', import.meta.url)), 'utf8')
);
const schema = readSchema();

test('the committed index matches what the generator produces', () => {
  // Same contract as the A2A digest: the file is committed so a reviewer sees the digest change in
  // the diff, which is worth nothing unless the two cannot drift. Edit a skill, forget to re-run
  // prebuild, and this fails rather than shipping an index that fails verification in the field.
  assert.deepEqual(committed, buildSkillsIndex());
});

test('the index is a v0.2.0 document listing at least one skill', () => {
  assert.equal(committed.$schema, SKILLS_SCHEMA_URI);
  assert.equal(SKILLS_INDEX_PATH, '/.well-known/agent-skills/index.json');
  assert.ok(committed.skills.length >= 1);
  assert.deepEqual(Object.keys(committed), ['$schema', 'skills']);
});

test('every entry carries exactly the five required fields', () => {
  for (const skill of committed.skills) {
    assert.deepEqual(Object.keys(skill), ['name', 'type', 'description', 'url', 'digest']);
    assert.equal(skill.type, 'skill-md');
    assert.equal(skill.url, skillUrlFor(skill.name));
    assert.match(skill.digest, /^sha256:[0-9a-f]{64}$/);
    assert.ok([...skill.description].length <= MAX_DESCRIPTION_LENGTH);
  }
});

test('each digest is the SHA-256 of the skill body, computed independently', () => {
  // Recomputed here with plain node:crypto rather than through digestOf, so a bug in digestOf
  // cannot make the generator and its own test agree with each other and with nothing else.
  const bodies = new Map(readSkills().map((skill) => [skill.name, skill.body]));
  for (const skill of committed.skills) {
    const body = bodies.get(skill.name);
    assert.ok(body, `no source body for ${skill.name}`);
    assert.equal(skill.digest, `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`);
  }
});

test('the index description is the skill file frontmatter description', () => {
  // The RFC says SHOULD; this site treats it as MUST, because the index description is the only
  // thing an agent reads before deciding whether to spend a request on the artifact.
  for (const skill of readSkills()) {
    const entry = committed.skills.find((candidate) => candidate.name === skill.name);
    assert.ok(entry, `${skill.name} is on disk but missing from the index`);
    assert.equal(entry.description, skill.description);
  }
  assert.equal(committed.skills.length, readSkills().length);
});

test('the skill body is a usable SKILL.md, not just a file that exists', () => {
  for (const skill of readSkills()) {
    assert.match(skill.body, /^---\n/, `${skill.name} does not open with frontmatter`);
    assert.match(skill.body, /\n# \S/, `${skill.name} has no top-level heading`);
    assert.ok(skill.body.length > 500, `${skill.name} is too short to teach anything`);
    // Level 2 of the RFC's progressive disclosure table recommends staying under ~5k tokens. No
    // tokeniser here, so this is a generous byte proxy: it catches a skill that has quietly become
    // a document dump without pretending to be a precise budget.
    assert.ok(skill.body.length < 40_000, `${skill.name} is over the progressive-disclosure budget`);
  }
});

test('the site-tour skill states that the experimental surfaces can be withdrawn', () => {
  // A skill that presents the A2A endpoint and the WebMCP tools as stable infrastructure would be
  // teaching agents something this site cannot promise. Named rather than taken positionally: this
  // is a claim about the skill that tours this site, not about whichever file sorts first.
  const skill = readSkills().find((candidate) => candidate.name === 'using-mattpyle-com');
  assert.ok(skill, 'using-mattpyle-com is missing');
  assert.match(skill.body, /withdrawn/i);
});

test('an implementation-pattern skill is portable, naming no site and no history', () => {
  // These teach a pattern to an agent working on somebody else's site. That reader has none of this
  // repo's context, and instructions do not carry citations, so a reference to this site, a PR
  // number or a date is a leak rather than provenance. Provenance lives on the card and in the PR.
  for (const skill of readSkills().filter((candidate) => candidate.name.startsWith('implement-'))) {
    const body = `${skill.body}\n${skill.description}`;
    assert.doesNotMatch(body, /mattpyle/i, `${skill.name} names this site`);
    assert.doesNotMatch(body, /\bPR #?\d+/i, `${skill.name} cites a pull request`);
    assert.doesNotMatch(body, /\b20\d{2}-\d{2}-\d{2}\b/, `${skill.name} carries a date`);
  }
});

test('the naming rules reject every shape the spec forbids', () => {
  for (const name of ['using-mattpyle-com', 'a', 'a1', '0-9']) {
    assert.equal(isValidSkillName(name), true, name);
  }
  for (const name of ['-leading', 'trailing-', 'double--hyphen', 'Upper', 'has space', 'under_score', '', 'a'.repeat(65)]) {
    assert.equal(isValidSkillName(name), false, name);
  }
});

test('normalisation makes the digest a property of the content, not of the checkout', () => {
  // The reason this exists: core.autocrlf is on with no .gitattributes, so the same skill file is
  // CRLF in a Windows working tree and LF in CI. Without this, the committed digest would be
  // correct only on the machine that generated it.
  assert.equal(digestOf(normaliseSkillBody('a\r\nb\r\n')), digestOf(normaliseSkillBody('a\nb\n')));
  assert.equal(normaliseSkillBody('no trailing newline'), 'no trailing newline\n');
  assert.equal(normaliseSkillBody('\uFEFFwith bom\n'), 'with bom\n');
});

test('the frontmatter reader refuses the shapes it cannot represent', () => {
  const cases = [
    ['no frontmatter at all\n', /must open with YAML frontmatter/],
    ['---\nname: a\n---\n', /missing required key "description"/],
    ['---\ndescription: a\n---\n', /missing required key "name"/],
    ['---\nname: a\nbroken\n---\n', /not a "key: value" pair/],
  ];
  for (const [source, expected] of cases) {
    assert.throws(() => parseSkillFrontmatter(source, 'fixture'), expected, source);
  }
});

test('the validator accepts the committed index against real artifacts', () => {
  // Artifacts are stubbed from the source bodies rather than read from dist/, so this suite stays
  // runnable without a build; scripts/validate-agent-skills-index.mjs does the real output-root
  // check inside the build chain, where the built bytes exist.
  assert.deepEqual(validateSkillsIndex(committed, schema, []), []);
});

test('digest verification is the build chain\'s job; version drift is caught anywhere', () => {
  // Stated plainly because it is a real limit of this suite: with no output roots there are no
  // bytes to hash, so a stale digest passes here by design and is caught by
  // scripts/validate-agent-skills-index.mjs against dist/. Asserted rather than left implicit so
  // nobody reads a green run of this file as proof the digest was checked.
  const stale = {
    ...committed,
    skills: committed.skills.map((skill) => ({ ...skill, digest: `sha256:${'0'.repeat(64)}` })),
  };
  assert.deepEqual(validateSkillsIndex(stale, schema, []), []);

  assert.deepEqual(
    validateSkillsIndex({ ...committed, $schema: 'https://example.com/other.json' }, schema, []),
    [
      '/$schema: "https://example.com/other.json" is not one of https://schemas.agentskills.io/discovery/0.2.0/schema.json',
      `$schema: this build implements ${SKILLS_SCHEMA_URI}, index claims "https://example.com/other.json"`,
    ]
  );
});

test('the validator rejects malformed and hand-written entries', () => {
  const withEntry = (overrides) => ({
    ...committed,
    skills: [{ ...committed.skills[0], ...overrides }],
  });

  assert.deepEqual(validateSkillsIndex({ $schema: SKILLS_SCHEMA_URI, skills: [] }, schema, []), [
    '/skills: required array is empty',
    'skills: an index that lists nothing is worse than no index at all',
  ]);

  assert.ok(
    validateSkillsIndex(withEntry({ name: 'Bad--Name' }), schema, []).some((error) =>
      error.includes('is not a valid Agent Skills name')
    )
  );
  assert.ok(
    validateSkillsIndex(withEntry({ type: 'archive' }), schema, []).some((error) =>
      error.includes('only "skill-md" is published by this site')
    )
  );
  assert.ok(
    validateSkillsIndex(withEntry({ url: 'https://cdn.example.com/SKILL.md' }), schema, []).some((error) =>
      error.includes('.url: expected /.well-known/agent-skills/')
    )
  );
  assert.ok(
    validateSkillsIndex(withEntry({ digest: 'sha256:NOTHEX' }), schema, []).some((error) =>
      error.includes('does not match')
    )
  );
  // An unknown field is a transcription mistake or a spec change; either way it should stop here.
  assert.ok(
    validateSkillsIndex(withEntry({ version: '1.0.0' }), schema, []).some((error) =>
      error.includes('not allowed by this schema')
    )
  );
});

test('a duplicate skill name is caught', () => {
  const doubled = { ...committed, skills: [committed.skills[0], committed.skills[0]] };
  assert.ok(
    validateSkillsIndex(doubled, schema, []).some((error) => error.includes('is listed more than once'))
  );
});

// --- llms.txt enumeration -----------------------------------------------------------------
//
// llms.txt used to name the single published skill in prose, which is a sentence that goes stale
// the day a second skill lands. These guard the replacement: the line is built from the committed
// index, and the route holds no skill name of its own.

const llmsRoute = readFileSync(
  fileURLToPath(new URL('../src/pages/llms.txt.ts', import.meta.url)),
  'utf8'
);

test('the llms.txt skills lines enumerate every committed skill', () => {
  const base = 'https://www.example.com';
  const lines = formatSkillsIndexLines(base, committed.skills);

  assert.equal(lines.length, committed.skills.length + 1);
  assert.match(lines[0], new RegExp(`\(${base}${SKILLS_INDEX_PATH}\)`));
  assert.ok(
    lines[0].includes(`lists ${committed.skills.length} skill${committed.skills.length === 1 ? '' : 's'}`),
    `index line does not state the skill count: ${lines[0]}`
  );

  committed.skills.forEach((skill, i) => {
    const line = lines[i + 1];
    assert.ok(line.startsWith('  - '), `skill line is not nested under the index line: ${line}`);
    assert.ok(line.includes(`[${skill.name}](${base}${skill.url})`), `skill line does not link ${skill.name}`);
    assert.ok(skill.description.startsWith(firstSentence(skill.description)));
  });
});

test('llms.txt names no skill of its own', () => {
  // The point of enumerating: publishing skill three is adding a file, with no edit here.
  for (const skill of committed.skills) {
    assert.ok(
      !llmsRoute.includes(skill.name),
      `llms.txt.ts hard-codes the skill name "${skill.name}"; it should enumerate from the index`
    );
  }
});
