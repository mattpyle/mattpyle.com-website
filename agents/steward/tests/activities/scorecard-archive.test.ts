import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// `reviews/` is a committed dataset (spec §11). Tests that archive must never
// write into the real one — test artifacts in it are contamination, not
// clutter. Set before importing config, same as snapshot-archive.test.ts.
const tmpReviews = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-scorecard-'));
process.env.STEWARD_REVIEWS_DIR = tmpReviews;

const { archiveScorecardRun } = await import('../../src/activities/scorecard.js');
const { SCORECARD_ARCHIVE_DIR } = await import('../../src/config.js');
import type { ScorecardArchiveRecord } from '../../src/activities/scorecard.js';

/**
 * The archive is the append-only audit trail (spec §5.2) and is the only place
 * per-page detail survives — the public run-log never carries it. It was not
 * actually append-only: a second run on an already-archived day overwrote
 * `<iso>.json` outright. These are the tests for that.
 */

function record(overrides: Partial<ScorecardArchiveRecord> = {}): ScorecardArchiveRecord {
  return {
    id: '2026-07-25',
    iso: '2026-07-25',
    timestamp: '2026-07-25T09:00:00-07:00',
    scope: '19 live pages',
    tools: ['Lighthouse 13.4', 'axe-core 4.12'],
    entry: 'Manual · intentional',
    commentary: 'All 19 pages passed all four public metrics.',
    metrics: [],
    perPage: [{ url: 'https://www.mattpyle.com/', scores: { performance: 100 }, axeViolations: 0 }],
    decision: 'no-op',
    reason: 'unchanged',
    ...overrides,
  };
}

async function readArchive(id: string) {
  const raw = await fs.readFile(path.join(SCORECARD_ARCHIVE_DIR, `${id}.json`), 'utf8');
  return JSON.parse(raw) as ScorecardArchiveRecord;
}

test('the first run of a day archives under its own id', async () => {
  const result = await archiveScorecardRun(record({ id: 'first-day' }));
  assert.equal(result.archiveId, 'first-day');
  assert.match(result.archivePath, /_scorecard\/first-day\.json$/);
  assert.equal((await readArchive('first-day')).archiveId, 'first-day');
});

test('a second run the same day does not overwrite the first', async () => {
  const one = await archiveScorecardRun(record({ id: 'twice', reason: 'the first run' }));
  const two = await archiveScorecardRun(record({ id: 'twice', reason: 'the second run' }));

  assert.equal(one.archiveId, 'twice');
  assert.equal(two.archiveId, 'twice-2');

  // The point of the whole fix: the first run's record still says what it said.
  assert.equal((await readArchive('twice')).reason, 'the first run');
  assert.equal((await readArchive('twice-2')).reason, 'the second run');
});

test('a third and fourth run keep counting up rather than colliding', async () => {
  const ids = [];
  for (let n = 0; n < 4; n++) {
    ids.push((await archiveScorecardRun(record({ id: 'many', reason: `run ${n}` }))).archiveId);
  }
  assert.deepEqual(ids, ['many', 'many-2', 'many-3', 'many-4']);
  for (let n = 0; n < 4; n++) {
    assert.equal((await readArchive(ids[n])).reason, `run ${n}`);
  }
});

test('concurrent runs claiming the same day each get their own file', async () => {
  // The `access` check and the write are not one operation, so the exclusive
  // `wx` flag is what actually makes claiming a name safe. Firing them together
  // is the only way to exercise that retry.
  const results = await Promise.all(
    [0, 1, 2, 3].map((n) => archiveScorecardRun(record({ id: 'racy', reason: `racer ${n}` }))),
  );
  const archiveIds = results.map((r) => r.archiveId).sort();
  assert.equal(new Set(archiveIds).size, 4, `expected 4 distinct ids, got ${archiveIds.join(', ')}`);

  const reasons = new Set<string>();
  for (const id of archiveIds) reasons.add((await readArchive(id)).reason);
  assert.equal(reasons.size, 4, 'every racer\'s record should have survived intact');
});

test('the run-log id is preserved when the archive id has to differ', async () => {
  // A published run's `id` is its run-log identity and must not be rewritten to
  // match a suffixed filename — that link is how an archived record is tied
  // back to the public Scorecard.
  await archiveScorecardRun(record({ id: 'published-day' }));
  const second = await archiveScorecardRun(
    record({ id: 'published-day', decision: 'open-pr', prUrl: 'https://github.com/o/r/pull/1' }),
  );

  assert.equal(second.archiveId, 'published-day-2');
  const stored = await readArchive('published-day-2');
  assert.equal(stored.id, 'published-day');
  assert.equal(stored.archiveId, 'published-day-2');
  assert.equal(stored.prUrl, 'https://github.com/o/r/pull/1');
});

test('latest.json always mirrors the most recently archived run', async () => {
  await archiveScorecardRun(record({ id: 'latest-check', reason: 'older' }));
  await archiveScorecardRun(record({ id: 'latest-check', reason: 'newer' }));

  const latest = JSON.parse(
    await fs.readFile(path.join(SCORECARD_ARCHIVE_DIR, 'latest.json'), 'utf8'),
  ) as ScorecardArchiveRecord;
  assert.equal(latest.reason, 'newer');
  assert.equal(latest.archiveId, 'latest-check-2');
});
