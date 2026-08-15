import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archiveScorecardRun } from '../../src/activities/scorecard.js';
import { githubToken } from '../../src/lib/github.js';

/**
 * The regression test for the 2026-08-14 incident: a suite run between
 * rewriting `archiveScorecardRun` onto the GitHub API and rewriting its test
 * committed fourteen fixture records to the real repository and opened a real
 * pull request.
 *
 * `helpers/no-real-credentials.ts` is the fix, loaded by `npm test` via
 * `--import`. This is what stops the fix from being silently removed — by an
 * edit to the `test` script, by a future runner that does not use it, or by
 * someone "cleaning up" an import that looks unused because nothing references
 * it by name.
 *
 * Deliberately asserting on the *observable behaviour* an un-faked activity
 * gets, not on `process.env.GITHUB_TOKEN` directly. What matters is not that a
 * variable is empty; it is that a network-backed activity called without its
 * fake fails loudly before it can reach GitHub.
 */

test('the suite runs with no real GitHub credential', () => {
  assert.throws(
    () => githubToken(),
    /GITHUB_TOKEN is not set/,
    'a real GITHUB_TOKEN is visible to the test suite — helpers/no-real-credentials.ts is not loaded',
  );
});

test('a GitHub-backed activity called without its fake fails instead of reaching GitHub', async () => {
  // This is the exact call that created `steward/scorecard-archive` and PR #122
  // on the live repository. It must now be a fast, loud failure.
  await assert.rejects(
    () =>
      archiveScorecardRun({
        id: 'guard-check',
        iso: '2026-08-14',
        scope: '1 live page',
        tools: [],
        entry: 'Manual · intentional',
        commentary: 'Held.',
        metrics: [],
        perPage: [],
        decision: 'no-op',
        reason: 'guard check',
      }),
    /GITHUB_TOKEN is not set/,
    'archiveScorecardRun reached the network without a fake installed',
  );
});
