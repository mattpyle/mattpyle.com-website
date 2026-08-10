import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// config.ts resolves SITE_DIR from the environment at import time, so the
// fixture root has to be set before the module graph loads.
process.env.STEWARD_SITE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

const { checkFrontmatter } = await import('../../src/activities/frontmatter.js');

test('clean fixture produces no findings', async () => {
  const result = await checkFrontmatter('posts/known-good.md');
  assert.deepEqual(result.findings, [], 'known-good.md should be silent');
  assert.equal(result.verdict, 'pass');
  assert.equal(result.pass, 'frontmatter');
});

test('known-bad fixture catches every defect class', async () => {
  const result = await checkFrontmatter('posts/known-bad.md');
  const messages = result.findings.map((f) => f.message);
  const has = (needle: string) =>
    messages.some((m) => m.toLowerCase().includes(needle.toLowerCase()));

  assert.equal(result.verdict, 'block');
  assert.ok(has('Missing `description`'), 'missing description');
  assert.ok(has('over the ~60-char SERP limit'), 'over-long title');
  assert.ok(has('earlier than `date`'), 'updated before date');
  assert.ok(has('No `tags`'), 'empty tags');
  assert.ok(has('Body contains an `# h1`'), 'h1 in body');
  assert.ok(has('empty alt text'), 'image without alt');
  assert.ok(has('not a relative `src/assets/` reference'), 'image outside src/assets');
});

test('severities follow the spec table', async () => {
  const result = await checkFrontmatter('posts/known-bad.md');
  const sev = (needle: string) =>
    result.findings.find((f) => f.message.includes(needle))?.severity;

  assert.equal(sev('Missing `description`'), 'block');
  assert.equal(sev('Body contains an `# h1`'), 'block');
  assert.equal(sev('empty alt text'), 'block');
  assert.equal(sev('earlier than `date`'), 'block');
  assert.equal(sev('No `tags`'), 'flag');
  assert.equal(sev('SERP limit'), 'flag');
  assert.equal(sev('not a relative `src/assets/` reference'), 'flag');
});

test('finding IDs are stable and unique within the pass', async () => {
  const result = await checkFrontmatter('posts/known-bad.md');
  const ids = result.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
  assert.ok(ids.every((id) => id.startsWith('frontmatter-')));
});

test('findings carry line numbers pointing into the real file', async () => {
  const result = await checkFrontmatter('posts/known-bad.md');
  const h1 = result.findings.find((f) => f.message.includes('# h1'));
  // The h1 is on line 9 of the fixture, counting the frontmatter block.
  assert.equal(h1?.line, 9);
});

// ---------------------------------------------------------------------------
// Collection awareness.
//
// The two schemas are genuinely different (see the RULES table in
// frontmatter.ts). The failure these guard against is the writing rules being
// applied to a changelog entry, which would report a missing `description` on
// every single entry — a field the changelog schema does not have.
// ---------------------------------------------------------------------------

test('a clean changelog entry produces no findings', async () => {
  const result = await checkFrontmatter('posts/changelog-good.md', 'changelog');
  assert.deepEqual(result.findings, [], 'changelog-good.md should be silent');
  assert.equal(result.verdict, 'pass');
});

test('changelog rules are applied, not the writing ones', async () => {
  const result = await checkFrontmatter('posts/changelog-bad.md', 'changelog');
  const messages = result.findings.map((f) => f.message);
  const has = (needle: string) =>
    messages.some((m) => m.toLowerCase().includes(needle.toLowerCase()));

  assert.equal(result.verdict, 'block');
  // `summary`, never `description` — the whole point of the per-collection table.
  assert.ok(has('`summary` is 6 chars'), 'summary length checked, under its own name');
  assert.ok(!has('`description`'), 'must not ask a changelog entry for a writing field');
  // Enums the writing collection has no concept of.
  assert.ok(has('`type` must be one of'), 'invalid type enum');
  assert.ok(has('`significance` must be one of'), 'invalid significance enum');
  // Required on changelog, optional on writing.
  assert.ok(has('Missing `updated`'), '`updated` is required by the changelog schema');
  // Shared structural rules still apply.
  assert.ok(has('Body contains an `# h1`'), 'h1 rule is collection-independent');
  assert.ok(has('No `tags`'), 'tags rule is collection-independent');
});

test('the over-long title advice names the override the schema actually has', async () => {
  const result = await checkFrontmatter('posts/changelog-bad.md', 'changelog');
  const titleFinding = result.findings.find((f) => f.message.includes('SERP limit'));
  assert.ok(titleFinding, 'the over-long title is still flagged');
  // `changelog` gained `seoTitle`/`seoDescription` on 2026-08-07, so this advice
  // is now actionable. Before that the schema had no override and naming one
  // would have sent the author to a field the build rejects — which is why this
  // test exists at all. If the fields ever leave the schema, flip it back.
  assert.ok(
    titleFinding.message.includes('seoTitle'),
    'the override the changelog schema accepts should be named by name',
  );
});

// ---------------------------------------------------------------------------
// SERP lengths measure the string that actually renders.
//
// Two holes this closes. `Layout.astro:63` renders `${seoTitle ?? title} — Matt
// Pyle`, so a 60-char title Steward passed reached the SERP at 72 — the check
// measured a string the site never emits. And the mere presence of an override
// used to suppress the finding without measuring the override, so the fix the
// finding recommended turned the check off rather than satisfying it.
// ---------------------------------------------------------------------------

const SERP_FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'posts',
);

/**
 * Writes a throwaway post with the given frontmatter and checks it in **audit**
 * mode — the mode that skips the draft rule and the git-state note, so a
 * generated, untracked fixture produces SERP findings and nothing else.
 */
async function serpFindings(name: string, extra: Record<string, string>): Promise<string[]> {
  const file = path.join(SERP_FIXTURES, `${name}.md`);
  const frontmatter = Object.entries({
    date: '2026-07-18',
    description: '"A description well inside every bound this pass checks, so only the title can fail."',
    tags: '["testing"]',
    ...extra,
  })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  await fs.writeFile(file, `---\n${frontmatter}\n---\n\n## Body\n\nNothing here.\n`, 'utf8');
  try {
    const result = await checkFrontmatter(`posts/${name}.md`, 'writing', 'audit');
    return result.findings.map((f) => f.message);
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

const overLimit = (messages: string[]) => messages.filter((m) => m.includes('SERP limit'));

test('a bare title over budget is flagged, with the rendered length and the real budget', async () => {
  // 63 chars, so it fails on its own and would have failed before this change
  // too — the regression guard for the case that already worked.
  const title = 'A title that is comfortably over sixty characters all by itself';
  assert.equal(title.length, 63);

  const flagged = overLimit(await serpFindings('serp-bare-long', { title: `"${title}"` }));
  assert.equal(flagged.length, 1, JSON.stringify(flagged));
  assert.match(flagged[0], /`title` is 63 chars \+ the 12-char ` — Matt Pyle` suffix = 75 rendered/);
  // The number the author has to hit, not the one the constant is named after.
  assert.match(flagged[0], /48 chars or fewer/);
  assert.match(flagged[0], /seoTitle/);
});

test('a title that only fails once the suffix is counted is flagged', async () => {
  // 54 chars: comfortably under the bare 60-char limit the check used to apply,
  // and 66 as rendered. This is the entire 12-character blind spot, in one case.
  const title = 'A title under sixty bare, and over sixty once rendered';
  assert.equal(title.length, 54);

  const flagged = overLimit(await serpFindings('serp-suffix-only', { title: `"${title}"` }));
  assert.equal(flagged.length, 1, JSON.stringify(flagged));
  assert.match(flagged[0], /`title` is 54 chars \+ the 12-char ` — Matt Pyle` suffix = 66 rendered/);
});

test('a short override satisfies the check instead of suppressing it', async () => {
  const flagged = overLimit(
    await serpFindings('serp-short-override', {
      title: '"A title that is comfortably over sixty characters all by itself"',
      seoTitle: '"A short enough override"',
    }),
  );
  assert.deepEqual(flagged, [], 'the override is the string that renders, and it fits');
});

test('a long override is flagged, rather than being accepted for existing', async () => {
  // The hole with teeth: adding an override is exactly what the finding told the
  // author to do, and before this it turned the check off whatever it contained.
  const flagged = overLimit(
    await serpFindings('serp-long-override', {
      title: '"A short title"',
      seoTitle: '"An override that is itself far too long to fit inside a search result"',
    }),
  );
  assert.equal(flagged.length, 1, JSON.stringify(flagged));
  assert.match(flagged[0], /`seoTitle` is 69 chars/);
  assert.match(flagged[0], /reaches `<title>`/);
  // It must not tell the author to add the field they already have.
  assert.doesNotMatch(flagged[0], /Add a/);
});

test('a long seoDescription is flagged, and a short one clears an over-long description', async () => {
  const longDek = `"${'d'.repeat(200)}"`;

  const suppressed = overLimit(
    await serpFindings('serp-dek-override-short', {
      title: '"A short title"',
      description: longDek,
      seoDescription: `"${'s'.repeat(140)}"`,
    }),
  );
  assert.deepEqual(suppressed, [], 'a 140-char override is what reaches the meta description');

  const flagged = overLimit(
    await serpFindings('serp-dek-override-long', {
      title: '"A short title"',
      description: longDek,
      seoDescription: `"${'s'.repeat(190)}"`,
    }),
  );
  assert.equal(flagged.length, 1, JSON.stringify(flagged));
  assert.match(flagged[0], /`seoDescription` is 190 chars/);
});

test('an empty override is a block, not a silently shorter title', async () => {
  // `seoTitle: ""` does not render as a short title. It renders as ` — Matt
  // Pyle`, with the post's name gone entirely.
  const messages = await serpFindings('serp-empty-override', {
    title: '"A short title"',
    seoTitle: '""',
  });
  assert.ok(
    messages.some((m) => m.includes('`seoTitle` is empty')),
    JSON.stringify(messages),
  );
});

// ---------------------------------------------------------------------------
// The uncommitted-draft note (design rule 9: a deterministically checkable
// condition gets promoted into mechanical code).
//
// Drafts staying out of git is the documented normal here, and publish works
// fine either way — Steward reads the bytes off disk and commits them in its own
// worktree. What the author cannot see coming is the leftover twin afterwards,
// so this is a note about the routine, not a warning about a mistake. It carries
// `pass` severity for that reason: it must not move the pass's verdict, and it
// must not read as something to fix.
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const UNTRACKED = path.join(FIXTURES, 'posts', 'untracked-draft.md');

after(async () => {
  await fs.rm(UNTRACKED, { force: true }).catch(() => {});
});

test('an untracked draft gets an informational note naming `steward cleanup`', async () => {
  await fs.copyFile(path.join(FIXTURES, 'posts', 'known-good.md'), UNTRACKED);

  const result = await checkFrontmatter('posts/untracked-draft.md');
  const note = result.findings.find((f) => f.message.includes('steward cleanup'));

  assert.ok(note, `expected a cleanup note, got: ${JSON.stringify(result.findings)}`);
  assert.equal(note.severity, 'pass', 'informational — it must not warn');
  assert.equal(result.verdict, 'pass', 'the note must not move the pass verdict');
  assert.match(note.message, /untracked/i);
  assert.match(note.message, /steward cleanup untracked-draft/);
  // The tone test: it says publish works, because it does.
  assert.match(note.message, /publish/i);
});

test('a committed, unmodified draft gets no note', async () => {
  const result = await checkFrontmatter('posts/known-good.md');
  assert.deepEqual(result.findings, [], 'a tracked clean file has nothing to reconcile');
});

test('audit mode never notes it — published content has no twin to clean up', async () => {
  await fs.copyFile(path.join(FIXTURES, 'posts', 'known-good.md'), UNTRACKED);

  const audit = await checkFrontmatter('posts/untracked-draft.md', 'writing', 'audit');
  assert.equal(
    audit.findings.some((f) => f.message.includes('steward cleanup')),
    false,
  );
});

test('audit mode does not block published content for being published', async () => {
  // The fixture is `draft: false` — published, which is exactly what an audit
  // targets and exactly what the gate refuses.
  const gate = await checkFrontmatter('posts/changelog-bad.md', 'changelog', 'gate');
  const audit = await checkFrontmatter('posts/changelog-bad.md', 'changelog', 'audit');
  const firesDraftRule = (r: typeof gate) =>
    r.findings.some((f) => f.message.includes('draft: true'));

  assert.equal(firesDraftRule(gate), true, 'the gate still refuses published content');
  assert.equal(firesDraftRule(audit), false, 'an audit must not report its own premise as a defect');
  // Mode changes the draft rule and *only* the draft rule. If an audit quietly
  // suppressed other findings it would be a weaker check pretending to be the
  // same one.
  assert.equal(gate.findings.length, audit.findings.length + 1);
});
