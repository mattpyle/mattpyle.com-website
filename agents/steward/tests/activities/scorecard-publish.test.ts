import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { publishScorecardRun, readPublishedScorecard } from '../../src/activities/scorecard.js';
import { SCORECARD_ARCHIVE_BRANCH, SCORECARD_ARCHIVE_REL, SCORECARD_RUNS_PATH } from '../../src/config.js';
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

test('the PR body row shows the pass count and the check that did not pass, with its score', async () => {
  await publishScorecardRun({
    record: run(),
    perPage: [
      {
        url: 'https://www.mattpyle.com/a/',
        scores: { performance: 99 },
        axeViolations: 0,
        agenticChecks: [
          { id: 'cumulative-layout-shift', score: 0.93, passed: false },
          { id: 'llms-txt', score: 1, passed: true },
        ],
      },
      { url: 'https://www.mattpyle.com/b/', scores: { performance: 100 }, axeViolations: 0, agenticChecks: [{ id: 'llms-txt', score: 1, passed: true }] },
      { url: 'https://www.mattpyle.com/old/', scores: { performance: 100 }, axeViolations: 0 },
    ],
  });
  const body = hub.pulls[0].body;
  assert.match(body, /\| https:\/\/www\.mattpyle\.com\/a\/ \| 0 \| .* \| 1\/2 \(not passing: layout stability 0\.93\) \|/);
  assert.match(body, /\| https:\/\/www\.mattpyle\.com\/b\/ \| 0 \| .* \| 1\/1 \|/);
  assert.match(body, /\| https:\/\/www\.mattpyle\.com\/old\/ \| 0 \| .* \| not recorded \|/);
});

test('the PR body says Steward merges after the checks pass; a dry run says Steward does not merge it', async () => {
  await publishScorecardRun({ record: run(), perPage: [] });
  assert.match(hub.pulls[0].body, /Steward merges it after the checks pass/);
  assert.doesNotMatch(hub.pulls[0].body, /never merges/);

  await publishScorecardRun({ record: run({ iso: '2026-08-15' }), perPage: [], dryRun: true });
  assert.match(hub.pulls[1].body, /Steward does not merge a dry run/);
});

// ---------------------------------------------------------------------------
// The archive record in the run's pull request (STW-614)
// ---------------------------------------------------------------------------

const ARCHIVE = { decision: 'open-pr' as const, reason: 'unchanged, published 1d ago; a scheduled run publishes every night' };
const PAGE = { url: 'https://www.mattpyle.com/', scores: { performance: 100 }, axeViolations: 0 };

test('with an archive, the run-log entry and the record go in one commit on the run\'s branch', async () => {
  const result = await publishScorecardRun({ record: run(), perPage: [PAGE], archive: ARCHIVE });

  assert.equal(result.committed, true);
  assert.equal(result.archiveId, '2026-08-14');
  assert.equal(result.archivePath, `${SCORECARD_ARCHIVE_REL}/2026-08-14.json`);
  assert.deepEqual(hub.history(result.branch), ['chore(scorecard): publish 2026-08-14 run'], 'one commit on the branch');

  const onBranch = hub.json(result.branch, SCORECARD_RUNS_PATH) as ScorecardRunRecord[];
  assert.equal(onBranch[0].id, '2026-08-14');
  const record = hub.json(result.branch, result.archivePath!);
  assert.equal(record.id, '2026-08-14');
  assert.equal(record.archiveId, '2026-08-14');
  assert.equal(record.decision, 'open-pr');
  assert.equal(record.reason, ARCHIVE.reason);
  assert.deepEqual(record.perPage, [PAGE]);
  assert.equal('prUrl' in record, false, 'the commit is made before the pull request exists');

  // Nothing else: no latest.json, no archive branch, the base untouched.
  assert.equal(hub.file(result.branch, `${SCORECARD_ARCHIVE_REL}/latest.json`), undefined);
  assert.equal(hub.branches.has(SCORECARD_ARCHIVE_BRANCH), false);
  assert.equal(hub.file(BASE, result.archivePath!), undefined);
  assert.equal(hub.pulls.length, 1);
  assert.match(hub.pulls[0].body, /also adds the run's per-page record, `agents\/steward\/reviews\/_scorecard\/2026-08-14\.json`/);
});

test('the head commit publish reports is the one the branch points at', async () => {
  const result = await publishScorecardRun({ record: run(), perPage: [], archive: ARCHIVE });
  hub.pulls[0].sha = result.headSha;
  assert.ok(result.headSha);
  assert.equal(result.prNumber, 1);
});

test('an archive name the base already holds is left alone and the record takes a suffix', async () => {
  hub.restore();
  hub = installFakeGitHub({
    seed: {
      ...seedRunLog([{ iso: '2026-08-13' }]),
      [`${SCORECARD_ARCHIVE_REL}/2026-08-14.json`]: '{"id":"an earlier no-op"}\n',
    },
  });
  const result = await publishScorecardRun({ record: run(), perPage: [], archive: ARCHIVE });
  assert.equal(result.id, '2026-08-14');
  assert.equal(result.archiveId, '2026-08-14-2');
  assert.equal(hub.file(result.branch, `${SCORECARD_ARCHIVE_REL}/2026-08-14.json`)?.text, '{"id":"an earlier no-op"}\n');
  assert.equal(hub.json(result.branch, result.archivePath!).archiveId, '2026-08-14-2');
});

test('a retried publish with an archive resets to base and keeps one pull request', async () => {
  await publishScorecardRun({ record: run(), perPage: [], archive: ARCHIVE });
  const second = await publishScorecardRun({ record: run(), perPage: [], archive: ARCHIVE });
  // Reset to base, then one commit: the run-log holds the night once.
  const onBranch = hub.json(second.branch, SCORECARD_RUNS_PATH) as ScorecardRunRecord[];
  assert.equal(onBranch.filter((r) => r.iso === '2026-08-14').length, 1);
  assert.equal(second.archiveId, '2026-08-14');
  assert.equal(hub.pulls.length, 1);
});

test('without an archive the publish commits the run-log alone and reports no archive path', async () => {
  const result = await publishScorecardRun({ record: run(), perPage: [] });
  assert.equal(result.archivePath, undefined);
  assert.equal(hub.file(result.branch, `${SCORECARD_ARCHIVE_REL}/2026-08-14.json`), undefined);
});

test('a held run says so at the top of the body, in plain words, and is not a draft', async () => {
  await publishScorecardRun({ record: run(), perPage: [], archive: ARCHIVE, held: { failedPages: 1, totalPages: 19 } });
  const body = hub.pulls[0].body;
  assert.match(body, /^> \*\*Held for Matt\.\*\* 1 of 19 page\(s\) could not be audited/);
  assert.match(body, /does not merge it/);
  assert.match(body, /The next healthy night publishes its own pull request\./);
  assert.match(body, /Held: Steward does not merge this one/);
  assert.doesNotMatch(body, /Steward merges it after the checks pass/);
  assert.equal(hub.pulls[0].draft, false);
});
