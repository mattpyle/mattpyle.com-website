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
