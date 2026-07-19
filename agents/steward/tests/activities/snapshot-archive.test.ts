import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
process.env.STEWARD_SITE_DIR = fixtures;

const { snapshotDraft, currentContentHash, sha256 } = await import('../../src/activities/snapshot.js');
const { archiveReport } = await import('../../src/activities/archive.js');
const { REVIEWS_DIR } = await import('../../src/config.js');
import type { ReviewReport } from '../../src/lib/report.js';

// snapshotDraft resolves `src/content/writing/<slug>.md`, so the fixture root
// mirrors that shape rather than the flat `posts/` layout the other tests use.
const writingDir = path.join(fixtures, 'src', 'content', 'writing');

test('snapshotDraft pins the file bytes and parses frontmatter', async () => {
  await fs.mkdir(writingDir, { recursive: true });
  const body = '---\ntitle: "t"\ndraft: true\n---\n\n## hello\n';
  await fs.writeFile(path.join(writingDir, 'tmp-snap.md'), body, 'utf8');

  const snap = await snapshotDraft('tmp-snap');
  assert.equal(snap.slug, 'tmp-snap');
  assert.equal(snap.file, 'src/content/writing/tmp-snap.md');
  assert.equal(snap.frontmatter.draft, true);
  assert.equal(snap.contentSha256, sha256(Buffer.from(body, 'utf8')));
  assert.match(snap.body, /## hello/);

  await fs.rm(path.join(writingDir, 'tmp-snap.md'));
});

test('a whitespace-only edit changes the pin', async () => {
  await fs.mkdir(writingDir, { recursive: true });
  const p = path.join(writingDir, 'tmp-ws.md');
  await fs.writeFile(p, '---\ntitle: "t"\ndraft: true\n---\n\nbody\n', 'utf8');
  const before = await currentContentHash('tmp-ws');
  await fs.writeFile(p, '---\ntitle: "t"\ndraft: true\n---\n\nbody \n', 'utf8');
  const after = await currentContentHash('tmp-ws');
  assert.notEqual(before, after, 'the pin is over raw bytes, not parsed content');
  await fs.rm(p);
});

test('a missing post fails with the available draft slugs listed', async () => {
  await assert.rejects(
    () => snapshotDraft('does-not-exist'),
    (err: Error) => {
      assert.match(err.message, /src\/content\/writing\/does-not-exist\.md/);
      assert.match(err.message, /Available draft slugs/);
      return true;
    },
  );
});

test('currentContentHash returns null for a missing file', async () => {
  assert.equal(await currentContentHash('does-not-exist'), null);
});

function report(sha: string): ReviewReport {
  return {
    schemaVersion: 1,
    slug: 'archive-test',
    file: 'src/content/writing/archive-test.md',
    contentSha256: sha,
    reviewedAt: new Date().toISOString(),
    workflowId: 'wf',
    runId: 'run',
    passes: [],
    patches: [],
    overall: 'pass',
    summary: 'PASS — no findings.',
    human: {},
    publish: {},
  };
}

test('archiveReport writes a hash-keyed file and a latest.json copy', async () => {
  const sha = 'b'.repeat(64);
  const result = await archiveReport(report(sha));

  const dir = path.join(REVIEWS_DIR, 'archive-test');
  const hashed = path.join(dir, `${sha.slice(0, 12)}.json`);
  const latest = path.join(dir, 'latest.json');

  assert.equal(JSON.parse(await fs.readFile(hashed, 'utf8')).contentSha256, sha);
  // Windows: a real copy, never a symlink (design rule 8).
  assert.equal((await fs.lstat(latest)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(hashed, 'utf8'), await fs.readFile(latest, 'utf8'));
  assert.equal(result.reportPath, `agents/steward/reviews/archive-test/${sha.slice(0, 12)}.json`);

  await fs.rm(dir, { recursive: true, force: true });
});

test('archiveReport refuses a report that violates the schema', async () => {
  const bad = { ...report('c'.repeat(64)), overall: 'catastrophe' } as unknown as ReviewReport;
  await assert.rejects(() => archiveReport(bad));
  await fs.rm(path.join(REVIEWS_DIR, 'archive-test'), { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(path.join(fixtures, 'src'), { recursive: true, force: true });
  await fs.rm(path.join(os.tmpdir(), 'steward-noop'), { recursive: true, force: true });
});
