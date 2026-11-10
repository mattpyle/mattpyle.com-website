/**
 * Default-deny for real credentials in the test suite. Loaded by `npm test` via
 * `--import`, so it runs in every test process before any test file and before
 * `config.ts` gets a chance to read `.env`.
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
 * immediate test failure that names the cause. Setting it to the empty
 * string rather than deleting it is deliberate: `config.ts`'s `loadDotEnv`
 * skips any key that is already **defined**, so an empty value is what stops
 * `.env` from putting the real values back a moment later. `delete` would leave
 * it undefined and `.env` would win.
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

process.env.STEWARD_GITHUB_APP_ID = '';
process.env.STEWARD_GITHUB_APP_PRIVATE_KEY = '';
process.env.STEWARD_GITHUB_APP_INSTALLATION_ID = '';
process.env.ANTHROPIC_API_KEY = '';
// The preview bypass secret: a test that wants one sets its own.
process.env.VERCEL_AUTOMATION_BYPASS_SECRET = '';
// The Web Bot Auth signing key: every test that signs builds a throwaway key at run time, so the
// real one in `.env` must never sign a test request against a mock server.
process.env.STEWARD_WEB_BOT_AUTH_KEY = '';
// The alerting base URL: every run-health signal posts to it, healthy or not, so a suite
// run beside a real `.env` must not reach the live checks. A test that wants one sets its own.
process.env.STEWARD_HEALTHCHECK_BASE = '';
// The Temporal API keys. Since PR 640 a `.env` line may hold a 1Password reference, and a
// reference that reaches `config.ts` stops every test that loads it ("Refusing to start").
// An empty value is defined, so `.env` cannot put the reference back. The suite never connects
// to Temporal Cloud: the workflow suites use the time-skipping server.
process.env.TEMPORAL_API_KEY = '';
process.env.TEMPORAL_METRICS_API_KEY = '';
process.env.TEMPORAL_READ_ONLY_API_KEY = '';
