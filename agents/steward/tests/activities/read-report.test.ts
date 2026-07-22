import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readArchivedReport } from '../../src/lib/read-report.js';
import { resolveArchivePath } from '../../src/config.js';
import type { ReviewStateResult } from '../../src/lib/report.js';

// Design rule 11. Three incidents in this project have had the same shape: a
// report reader that returns null on any error, turning a path bug into a
// content-free success. These tests pin the distinction the fix rests on —
// "no report yet" is null, "recorded but unreadable" throws.

const SLUG = 'read-report-test';
const REL = `agents/steward/reviews/writing/${SLUG}/report.json`;
const LEGACY_REL = `agents/steward/reviews/${SLUG}/report.json`;

function state(reportPath?: string): ReviewStateResult {
  return { state: 'awaiting_verdict', reportPath } as ReviewStateResult;
}

async function writeArchive(rel: string, body: string) {
  const abs = resolveArchivePath(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
  return abs;
}

const REPORT = JSON.stringify({
  slug: SLUG,
  collection: 'writing',
  mode: 'gate',
  contentSha256: 'a'.repeat(64),
  passes: [],
  patches: [],
});

test.after(async () => {
  for (const rel of [REL, LEGACY_REL]) {
    await fs.rm(path.dirname(resolveArchivePath(rel)), { recursive: true, force: true });
  }
});

test('no report archived yet is a legitimate null, not an error', async () => {
  assert.equal(await readArchivedReport(state(undefined)), null);
});

test('an archived report at the recorded path is parsed', async () => {
  await writeArchive(REL, REPORT);
  const report = await readArchivedReport(state(REL));
  assert.equal(report?.slug, SLUG);
  assert.equal(report?.mode, 'gate');
});

test('a pre-migration path still resolves via the writing/ fallback', async () => {
  // The live `hello-world` review is exactly this: parked before the archive
  // migration, with the old path immutably baked into its history.
  await writeArchive(REL, REPORT);
  await fs.rm(path.dirname(resolveArchivePath(LEGACY_REL)), { recursive: true, force: true });

  const report = await readArchivedReport(state(LEGACY_REL));
  assert.equal(report?.slug, SLUG, 'the legacy path falls back to the migrated location');
});

test('a recorded report that does not exist throws, naming every path tried', async () => {
  const missing = 'agents/steward/reviews/writing/no-such-review/report.json';
  await assert.rejects(
    () => readArchivedReport(state(missing)),
    (err: Error) => {
      assert.match(err.message, /no file was found/);
      assert.match(err.message, /no-such-review/, 'the attempted path is in the message');
      return true;
    },
  );
});

test('the legacy fallback failing reports BOTH attempted paths', async () => {
  await fs.rm(path.dirname(resolveArchivePath(REL)), { recursive: true, force: true });
  await assert.rejects(
    () => readArchivedReport(state(LEGACY_REL)),
    (err: Error) => {
      assert.match(err.message, /reviews[\\/]read-report-test/, 'the recorded path');
      assert.match(err.message, /reviews[\\/]writing[\\/]read-report-test/, 'the migrated path');
      return true;
    },
  );
});

test('a report that exists but is malformed throws rather than rendering empty', async () => {
  const abs = await writeArchive(REL, '{ truncated wri');
  await assert.rejects(
    () => readArchivedReport(state(REL)),
    (err: Error) => {
      assert.match(err.message, /not valid JSON/);
      assert.ok(err.message.includes(abs), 'the offending file is named');
      return true;
    },
  );
});
