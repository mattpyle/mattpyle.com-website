/**
 * Default-deny for real credentials in the test suite. Loaded by `npm test` via
 * `--import`, so it runs in every test process before any test file.
 *
 * It is the second of two callers. `config.ts` runs the same guard before it reads `.env`,
 * so a run without this `--import` is covered too (the 2026-11-06 incident: a targeted run
 * without the flag archived a fixture record to the live repository). This import still
 * covers a test file that never loads `config.ts`. The list of variables and the reasons
 * are in `src/lib/test-credential-guard.ts`.
 *
 * ## The incident this exists because of (2026-08-14)
 *
 * `archiveScorecardRun` was rewritten from a local `writeFile` to a GitHub API
 * call. Its test file still called the activity directly, because when the
 * activity was filesystem-backed there was nothing to isolate it from — the
 * test pointed `STEWARD_REVIEWS_DIR` at a temp directory and that was the whole
 * of its sandboxing. Running the suite in between those two edits pointed the
 * new network-backed activity at the real repository with the real
 * GitHub credential out of `agents/steward/.env`, and it did exactly what it was
 * told: created `steward/scorecard-archive` on the live repo, committed
 * fourteen fixture records to it (`first-day`, `twice-2`, `racy`, …) and opened
 * a pull request.
 *
 * Nothing was lost — the branch was junk from birth and `master` never saw it —
 * but a test suite that can write to a production repository is a loaded gun,
 * and "remember to update the test in the same commit as the activity" is not a
 * safeguard. This is.
 *
 * ## How it works
 *
 * The token provider in `lib/github.ts` throws a non-retryable `AuthError` when
 * `STEWARD_GITHUB_APP_ID` or `STEWARD_GITHUB_APP_PRIVATE_KEY` is absent, so
 * removing the credential converts an accidental live call into a loud,
 * immediate test failure that names the cause. The guard sets each variable to
 * the empty string, and `config.ts` leaves the same variables out of its `.env`
 * read in a test process, so `.env` cannot put the real values back.
 *
 * A test that genuinely exercises the GitHub path opts back in by installing
 * the fake (`helpers/fake-github.ts`), which sets its own app credential and
 * replaces `fetch`. Opt-in is the right direction for this: the failure mode of
 * forgetting to fake is now a failed test rather than a commit on the real
 * repository.
 *
 * `ANTHROPIC_API_KEY` gets the same treatment, for the same reason one step
 * removed: the editorial pass is mocked everywhere today, but a future
 * activity rewritten the way the archive was would spend real money instead of
 * opening a real PR, and that failure is quieter.
 */

import { guardTestCredentials } from '../../src/lib/test-credential-guard.js';

// `--import` also runs this in the runner's own process, where `--test` is in `execArgv`.
guardTestCredentials();
