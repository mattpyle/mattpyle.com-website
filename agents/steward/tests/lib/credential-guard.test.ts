import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archiveScorecardRun } from '../../src/activities/scorecard.js';
import { installationToken } from '../../src/lib/github.js';

/**
 * The regression test for the 2026-08-14 incident: a suite run between
 * rewriting `archiveScorecardRun` onto the GitHub API and rewriting its test
 * committed fourteen fixture records to the real repository and opened a real
 * pull request.
 *
 * The fix is `guardTestCredentials` in `src/lib/test-credential-guard.ts`. `config.ts`
 * runs it before it reads `.env`, and `helpers/no-real-credentials.ts` runs it from the
 * `--import` in `npm test`. This file must pass with and without that `--import`: on
 * 2026-11-06 a targeted run without it wrote a fixture record to the live repository.
 *
 * Deliberately asserting on the *observable behaviour* an un-faked activity
 * gets, not on the two `STEWARD_GITHUB_APP_*` variables directly. What matters is not that a
 * variable is empty; it is that a network-backed activity called without its
 * fake fails loudly before it can reach GitHub.
 */

test('the suite runs with no real GitHub credential', async () => {
  await assert.rejects(
    () => installationToken(),
    /STEWARD_GITHUB_APP_ID and STEWARD_GITHUB_APP_PRIVATE_KEY are not set/,
    'a real GitHub App credential is visible to the test suite: guardTestCredentials did not run before config.ts read .env',
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
    /STEWARD_GITHUB_APP_ID and STEWARD_GITHUB_APP_PRIVATE_KEY are not set/,
    'archiveScorecardRun reached the network without a fake installed',
  );
});
