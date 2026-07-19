import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

/**
 * Zero-false-positive regression test (spec §8.2, build-log recommendation 6).
 *
 * `runCspell` emits `block` findings, and a block refuses approve. That makes a
 * stale project dictionary an active hazard rather than a nuisance: as posts
 * introduce new jargon, a dictionary that has quietly fallen behind starts
 * blocking publication of prose that is perfectly correct, and the author's
 * rational response is to stop trusting the check.
 *
 * So: every PUBLISHED post must produce exactly zero findings. Published, not
 * draft — drafts are works in progress and are allowed to be misspelled, and
 * the deliberately-typo-ridden `steward-smoke-test.md` fixture is a draft, so
 * this filter excludes it without needing to name it.
 *
 * When this fails, the fix is almost always to add the flagged term to
 * `agents/steward/cspell.config.yaml` — but read it first. A real typo in a
 * published post is exactly what this check is also capable of catching.
 */

// Deliberately NOT redirected to tests/fixtures: this test is about the real
// content tree. Each `node --test` file runs in its own process, so this does
// not collide with cspell.test.ts's fixture redirection.
const SITE_DIR = path.resolve(fileURLToPath(new URL('../../', import.meta.url)), '..', '..');
process.env.STEWARD_SITE_DIR = SITE_DIR;

const { runCspell } = await import('../../src/activities/cspell.js');

const WRITING_DIR = path.join(SITE_DIR, 'src', 'content', 'writing');

async function publishedPosts(): Promise<string[]> {
  const entries = await fs.readdir(WRITING_DIR);
  const published: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(WRITING_DIR, name), 'utf8');
    if (matter(raw).data.draft === true) continue;
    published.push(`src/content/writing/${name}`);
  }
  return published;
}

test('the Steward still flags the smoke-test fixture the SITE spellcheck ignores', async () => {
  // The root cspell.json has `ignorePaths` for this file so `npm run spellcheck`
  // stays clean. That ignore must not leak into the Steward's own config — if it
  // did, the fixture would silently stop being a fixture and the smoke test
  // would pass for the wrong reason. This asserts the two configs disagree, on
  // purpose.
  const result = await runCspell('src/content/writing/steward-smoke-test.md');
  assert.ok(
    result.findings.length > 0,
    'the Steward must still see the deliberate typos in the smoke-test fixture',
  );
  assert.equal(result.verdict, 'block');
});

test('every published post is spelling-clean (the dictionary has not gone stale)', async () => {
  const posts = await publishedPosts();
  assert.ok(posts.length > 0, `found no published posts under ${WRITING_DIR}`);

  const offenders: string[] = [];
  for (const file of posts) {
    const result = await runCspell(file);
    for (const f of result.findings) {
      offenders.push(`${f.file}:${f.line} ${f.message}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `cspell flagged published prose. Either the dictionary is stale (add the term to ` +
      `agents/steward/cspell.config.yaml) or these are real typos:\n  ${offenders.join('\n  ')}`,
  );
});
