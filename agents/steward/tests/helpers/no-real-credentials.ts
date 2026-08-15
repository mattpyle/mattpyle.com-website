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
 * `GITHUB_TOKEN` out of `agents/steward/.env`, and it did exactly what it was
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
 * `githubToken()` throws a non-retryable `AuthError` when `GITHUB_TOKEN` is
 * absent, so removing the credential converts an accidental live call into a
 * loud, immediate test failure that names the cause. Setting it to the empty
 * string rather than deleting it is deliberate: `config.ts`'s `loadDotEnv`
 * skips any key that is already **defined**, so an empty value is what stops
 * `.env` from putting the real token back a moment later. `delete` would leave
 * it undefined and `.env` would win.
 *
 * A test that genuinely exercises the GitHub path opts back in by installing
 * the fake (`helpers/fake-github.ts`), which sets its own token and replaces
 * `fetch`. Opt-in is the right direction for this: the failure mode of
 * forgetting to fake is now a failed test rather than a commit on the real
 * repository.
 *
 * `ANTHROPIC_API_KEY` gets the same treatment, for the same reason one step
 * removed: the editorial pass is mocked everywhere today, but a future
 * activity rewritten the way the archive was would spend real money instead of
 * opening a real PR, and that failure is quieter.
 */

process.env.GITHUB_TOKEN = '';
process.env.ANTHROPIC_API_KEY = '';
