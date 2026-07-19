import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('the over-long title advice does not name a field the schema lacks', async () => {
  const result = await checkFrontmatter('posts/changelog-bad.md', 'changelog');
  const titleFinding = result.findings.find((f) => f.message.includes('SERP limit'));
  assert.ok(titleFinding, 'the over-long title is still flagged');
  // Telling a changelog author to add `seoTitle` would be advice for a field
  // that does not exist, and following it would fail the build.
  assert.ok(
    !titleFinding.message.includes('seoTitle'),
    'must not suggest an override the changelog schema would reject',
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
