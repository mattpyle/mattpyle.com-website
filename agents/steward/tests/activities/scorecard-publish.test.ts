import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { publishScorecardRun, readPublishedScorecard } from '../../src/activities/scorecard.js';
import { SCORECARD_RUNS_PATH } from '../../src/config.js';
import type { ScorecardRunRecord } from '../../src/lib/scorecard-aggregate.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';

/**
 * `publishScorecardRun` and `readPublishedScorecard` against a fake GitHub.
 *
 * Both were rewritten on 2026-08-14 to drop the git worktree and the local file
 * read, so that the whole scorecard workflow could run on the hosted worker.
 * Neither had a direct test before — the worktree made one expensive, and the
 * workflow suite mocked them both out — which is exactly why they get one now
 * that the machinery is four HTTP calls.
 *
 * The properties below are the ones the worktree version got right and that a
 * naive API translation loses: reset-to-base rather than append-to-branch, one
 * PR per run rather than one per attempt, and the run-log's own collision
 * suffixing.
 */

const BASE = 'master';

function run(overrides: Partial<ScorecardRunRecord> = {}): Omit<ScorecardRunRecord, 'id'> {
  const { id: _ignored, ...rest } = {
    id: '',
    iso: '2026-08-14',
    timestamp: '2026-08-14T03:30:00-07:00',
    scope: '19 live pages',
    tools: ['Lighthouse 13.4', 'axe-core 4.12'],
    entry: 'Nightly · automated',
    commentary: 'All 19 pages passed all four public metrics.',
    metrics: [],
    ...overrides,
  } as ScorecardRunRecord;
  return rest;
}

function seedRunLog(runs: Array<Partial<ScorecardRunRecord>>): Record<string, string> {
  const full = runs.map((r) => ({
    id: r.iso ?? '2026-08-01',
    iso: r.iso ?? '2026-08-01',
    scope: '19 live pages',
    tools: ['Lighthouse 13.4', 'axe-core 4.12'],
    entry: 'Nightly · automated',
    commentary: 'Held.',
    metrics: [],
    ...r,
  }));
  return { [SCORECARD_RUNS_PATH]: JSON.stringify(full, null, 2) + '\n' };
}

let hub: FakeGitHub;

beforeEach(() => {
  hub = installFakeGitHub({ seed: seedRunLog([{ iso: '2026-08-13' }]) });
});

afterEach(() => {
  hub.restore();
});

// ---------------------------------------------------------------------------
// readPublishedScorecard
// ---------------------------------------------------------------------------

test('the published baseline comes off the default branch, not a working copy', async () => {
  const published = await readPublishedScorecard();
  assert.equal(published?.iso, '2026-08-13');
  // Parsed out of `scope`, and half of the audit-set guard (spec §5.4).
  assert.equal(published?.pageCount, 19);
});

test('an empty run-log reads as no baseline rather than as a zero-page one', async () => {
  hub.restore();
  hub = installFakeGitHub({ seed: { [SCORECARD_RUNS_PATH]: '[]\n' } });
  assert.equal(await readPublishedScorecard(), undefined);
});

test('a missing run-log reads as no baseline rather than throwing', async () => {
  hub.restore();
  hub = installFakeGitHub({ seed: {} });
  assert.equal(await readPublishedScorecard(), undefined);
});

// ---------------------------------------------------------------------------
// publishScorecardRun
// ---------------------------------------------------------------------------

test('the new run goes on top of the run-log, on a branch, leaving the base alone', async () => {
  const result = await publishScorecardRun({ record: run(), perPage: [] });

  assert.equal(result.id, '2026-08-14');
  assert.equal(result.branch, 'steward/scorecard-2026-08-14');

  const onBranch = hub.json(result.branch, SCORECARD_RUNS_PATH) as ScorecardRunRecord[];
  assert.equal(onBranch.length, 2);
  assert.equal(onBranch[0].id, '2026-08-14', 'the new run is not first');
  assert.equal(onBranch[1].id, '2026-08-13');

  // The base is untouched until a human merges. This is the same property the
  // worktree gave for free and the API does not.
  const onBase = hub.json(BASE, SCORECARD_RUNS_PATH) as ScorecardRunRecord[];
  assert.equal(onBase.length, 1);
});

test('a retried publish resets to base rather than appending the run twice', async () => {
  // The failure this guards is the whole reason `resetBranch` force-updates.
  // Without it the second attempt reads the branch it already wrote and the
  // run-log ends up with the same night in it twice.
  await publishScorecardRun({ record: run(), perPage: [] });
  const second = await publishScorecardRun({ record: run(), perPage: [] });

  const onBranch = hub.json(second.branch, SCORECARD_RUNS_PATH) as ScorecardRunRecord[];
  assert.equal(onBranch.length, 2, `run-log grew to ${onBranch.length} entries across two attempts`);
  assert.equal(onBranch.filter((r) => r.iso === '2026-08-14').length, 1);
});

test('a retried publish updates its PR instead of opening a second one', async () => {
  const first = await publishScorecardRun({ record: run(), perPage: [] });
  const second = await publishScorecardRun({ record: run(), perPage: [] });

  assert.equal(hub.pulls.length, 1, 'a second PR was opened for the same run');
  assert.equal(first.prUrl, second.prUrl);
});

test('a second run on an already-published day takes a suffixed id', async () => {
  hub.restore();
  hub = installFakeGitHub({ seed: seedRunLog([{ iso: '2026-08-14' }]) });

  const result = await publishScorecardRun({ record: run(), perPage: [] });
  assert.equal(result.id, '2026-08-14-2');
  const onBranch = hub.json(result.branch, SCORECARD_RUNS_PATH) as ScorecardRunRecord[];
  assert.equal(onBranch[0].id, '2026-08-14-2');
});

test('present-relative commentary is refused before anything is written', async () => {
  // `assertTimelessCommentary` is a hard block (spec §5.1 rule 7). It has to run
  // before the first write, or a refused run still leaves a branch behind.
  await assert.rejects(
    () => publishScorecardRun({ record: run({ commentary: 'The latest run currently passes.' }), perPage: [] }),
    /present-relative/,
  );
  assert.deepEqual(hub.calls, [], 'a refused publish still called GitHub');
  assert.equal(hub.pulls.length, 0);
});

test('a dry run labels the PR and opens it as a draft', async () => {
  const result = await publishScorecardRun({ record: run(), perPage: [], dryRun: true });
  assert.equal(hub.pulls.length, 1);
  assert.equal(hub.pulls[0].draft, true);
  assert.match(hub.pulls[0].title, /^\[dry run\] Scorecard: 2026-08-14$/);
  assert.ok(hub.pulls[0].body.includes('DRY RUN'));
  assert.ok(result.prUrl);
});

test('re-publishing a run the base already carries opens the PR without committing', async () => {
  // The `git status --porcelain` "nothing to commit" branch, translated. The API
  // answers 409 on an empty commit rather than no-opping, so the activity has to
  // notice the content is identical itself.
  hub.restore();
  const record = run();
  const existing = [{ ...record, id: '2026-08-14' }, { id: '2026-08-13', iso: '2026-08-13' }];
  hub = installFakeGitHub({
    seed: { [SCORECARD_RUNS_PATH]: JSON.stringify(existing, null, 2) + '\n' },
  });

  // Same iso, so `uniqueId` suffixes and the content genuinely differs — the
  // identical-content path is the one where the run-log already ends up equal.
  const result = await publishScorecardRun({ record, perPage: [] });
  assert.equal(result.id, '2026-08-14-2');
  assert.ok(hub.pulls.length === 1);
});
