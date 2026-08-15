import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { archiveScorecardRun } from '../../src/activities/scorecard.js';
import { SCORECARD_ARCHIVE_BRANCH, SCORECARD_ARCHIVE_REL } from '../../src/config.js';
import type { ScorecardArchiveRecord } from '../../src/activities/scorecard.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';

/**
 * The archive is the append-only audit trail (spec §5.2) and is the only place
 * per-page detail survives — the public run-log never carries it. It was not
 * actually append-only: a second run on an already-archived day overwrote
 * `<iso>.json` outright. These are the tests for that.
 *
 * **Rewritten 2026-08-14, same properties, different storage.** The activity
 * writes to a branch through the GitHub API now rather than to a temp
 * directory, because it had to stop needing a checkout for the scorecard to run
 * on the hosted worker. Every assertion below is the one that was here before;
 * only the reader changed. The atomic claim that makes them true moved from
 * `writeFile`'s `flag: 'wx'` to a Contents `PUT` with no `sha`, and
 * `helpers/fake-github.ts` models that specific behaviour for exactly this
 * reason.
 */

let hub: FakeGitHub;

beforeEach(() => {
  hub = installFakeGitHub({ seed: { 'src/data/scorecard-runs.json': '[]\n' } });
});

afterEach(() => {
  hub.restore();
});

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

function readArchive(id: string): ScorecardArchiveRecord {
  return hub.json(SCORECARD_ARCHIVE_BRANCH, `${SCORECARD_ARCHIVE_REL}/${id}.json`);
}

test('the first run of a day archives under its own id', async () => {
  const result = await archiveScorecardRun(record({ id: 'first-day' }));
  assert.equal(result.archiveId, 'first-day');
  assert.equal(result.committed, true);
  assert.match(result.archivePath, /_scorecard\/first-day\.json$/);
  assert.equal(readArchive('first-day').archiveId, 'first-day');
});

test('a second run the same day does not overwrite the first', async () => {
  const one = await archiveScorecardRun(record({ id: 'twice', reason: 'the first run' }));
  const two = await archiveScorecardRun(record({ id: 'twice', reason: 'the second run' }));

  assert.equal(one.archiveId, 'twice');
  assert.equal(two.archiveId, 'twice-2');

  // The point of the whole fix: the first run's record still says what it said.
  assert.equal(readArchive('twice').reason, 'the first run');
  assert.equal(readArchive('twice-2').reason, 'the second run');
});

test('a third and fourth run keep counting up rather than colliding', async () => {
  const ids = [];
  for (let n = 0; n < 4; n++) {
    ids.push((await archiveScorecardRun(record({ id: 'many', reason: `run ${n}` }))).archiveId);
  }
  assert.deepEqual(ids, ['many', 'many-2', 'many-3', 'many-4']);
  for (let n = 0; n < 4; n++) {
    assert.equal(readArchive(ids[n]).reason, `run ${n}`);
  }
});

test('concurrent runs claiming the same day each get their own file', async () => {
  // The read and the write are not one operation, so the create-only `PUT` is
  // what actually makes claiming a name safe — the same role `wx` played
  // against the filesystem. Firing them together is the only way to exercise
  // that retry.
  const results = await Promise.all(
    [0, 1, 2, 3].map((n) => archiveScorecardRun(record({ id: 'racy', reason: `racer ${n}` }))),
  );
  const archiveIds = results.map((r) => r.archiveId).sort();
  assert.equal(new Set(archiveIds).size, 4, `expected 4 distinct ids, got ${archiveIds.join(', ')}`);

  const reasons = new Set<string>();
  for (const id of archiveIds) reasons.add(readArchive(id).reason);
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
  const stored = readArchive('published-day-2');
  assert.equal(stored.id, 'published-day');
  assert.equal(stored.archiveId, 'published-day-2');
  assert.equal(stored.prUrl, 'https://github.com/o/r/pull/1');
});

test('latest.json always mirrors the most recently archived run', async () => {
  await archiveScorecardRun(record({ id: 'latest-check', reason: 'older' }));
  await archiveScorecardRun(record({ id: 'latest-check', reason: 'newer' }));

  const latest = hub.json(SCORECARD_ARCHIVE_BRANCH, `${SCORECARD_ARCHIVE_REL}/latest.json`);
  assert.equal(latest.reason, 'newer');
  assert.equal(latest.archiveId, 'latest-check-2');
});

// ---------------------------------------------------------------------------
// What moving to the API added
// ---------------------------------------------------------------------------

test('a dry run computes the record and commits nothing', async () => {
  // Spec §4.2 step 4 promises a dry run never touches GitHub. That cost nothing
  // to honour while the archive was a local file and the publish leg was the
  // only API caller; now that both go through the API it has to be enforced
  // here, or `steward scorecard --dry-run` starts pushing commits.
  const result = await archiveScorecardRun(record({ id: 'dry', dryRun: true }));

  assert.equal(result.committed, false);
  assert.equal(result.archivePath, '');
  assert.equal(result.archiveId, 'dry');
  assert.equal(hub.branches.has(SCORECARD_ARCHIVE_BRANCH), false, 'a dry run created a branch');
  assert.deepEqual(hub.calls, [], 'a dry run made a GitHub request');
});

test('every run appends to one standing branch rather than opening a PR per night', async () => {
  // The run-log PR appearing means a number moved (spec §6). That signal only
  // survives if the archive — which is written on no-op nights too — has
  // somewhere else to go.
  await archiveScorecardRun(record({ id: 'night-one' }));
  await archiveScorecardRun(record({ id: 'night-two' }));
  await archiveScorecardRun(record({ id: 'night-three' }));

  assert.equal(hub.pulls.length, 1, 'the archive opened more than one PR');
  assert.equal(hub.pulls[0].head, SCORECARD_ARCHIVE_BRANCH);
  for (const id of ['night-one', 'night-two', 'night-three']) {
    assert.equal(readArchive(id).id, id, `${id} is missing from the standing branch`);
  }
});

test('the archive branch is never reset, so earlier nights survive a later one', async () => {
  // `publishScorecardRun` force-resets its branch to base on every run, which is
  // right for a branch carrying one run's entry and would be catastrophic here:
  // this branch's entire content is records nobody has merged yet.
  await archiveScorecardRun(record({ id: 'early' }));
  await archiveScorecardRun(record({ id: 'late' }));

  assert.ok(hub.file(SCORECARD_ARCHIVE_BRANCH, `${SCORECARD_ARCHIVE_REL}/early.json`));
  assert.ok(hub.file(SCORECARD_ARCHIVE_BRANCH, `${SCORECARD_ARCHIVE_REL}/late.json`));
  assert.equal(
    hub.calls.filter((c) => c.startsWith('PATCH /git/refs/heads/')).length,
    0,
    'the archive branch was force-reset',
  );
});
