# CLAUDE.md: agents/steward

The rulebook for an agent changing Steward's code. It routes to the authoritative sources and states the rules they leave implicit. Where this file and a source disagree, the source wins; fix this file in the same change.

The repository rules in the root `CLAUDE.md` apply here too: the Steward workspace import rule, the worktree rule, and the Temporal rule. This file does not repeat them.

## What Steward is

Steward is the editorial agent and audit runner for mattpyle.com, a TypeScript application on Temporal. It reviews drafts, audits sites, sweeps the live site into the scorecard, and carries findings from a verdict to a verified fix. It is a sidecar: the site builds and serves without this directory, except the `/mcp` route, which imports the two entries in this package's `exports` map.

## Where the authoritative docs are

1. `agents/steward/README.md`: the workflows, the five task queues, the two workers, the publish leg, the CLI verbs, the Temporal connection switch and the exports entries. Read it first and restate nothing from it here.
2. The docblocks at the top of each file in `src/workflows/`. They hold the versioning history and the reason each input field and signal exists. Read the whole docblock of a workflow before changing it.
3. The docblocks in `tests/workflows/replay.test.ts`. Each fixture's comment says which history it is, which `patched` marker it guards, and the probe that proved it can fail.
4. The operator's docs, the design and the build log are kept outside this repository. Ask Matt when a decision here needs them.

## Where things run

1. Temporal Cloud when `TEMPORAL_API_KEY` is set, the local dev server when it is empty. `resolveTemporalConnection` in `src/config.ts` decides for both the CLI and the workers.
2. The hosted worker is `src/worker-hosted.ts`, built by `agents/steward/Dockerfile` and run as a Railway container. It serves `steward-audit`, `steward-audit-fast` and `steward-findings`. `src/hosted-registry.ts` holds each queue's activity map, workflow-bundle flag and concurrency cap, and the entry point builds its workers from it.
3. The local worker is `src/worker.ts`, started by `steward up` beside the working copy. It serves `steward-light` and `steward-heavy`, and `steward-audit` and `steward-audit-fast` only against the local dev server, where no hosted worker exists.
4. `steward-findings` has the hosted worker alone. `tests/lib/hosted-worker-registry.test.ts` builds the real registry and pins the hosted queue list and each queue's activities; its local-worker test pins the local list.
5. The fixer is `claude-code-action`, run by `.github/workflows/claude.yml` on an issue that `openFixIssue` opens. The custom fixer (`fixFindingWorkflow`, `src/activities/fixer.ts`, `src/lib/fixer.ts`) is frozen: it exists so that older lifecycle runs replay.

## Determinism rules

A workflow can sit parked on a signal for weeks, and every code change replays against its history. Each rule below names the file that enforces or demonstrates it.

1. A decision that changes which commands a workflow issues rides in the workflow input or a signal payload, never in `config.ts` or the environment. Config is read fresh at replay and rewrites the past. This is design rule 10; see `ReviewPostInput` in `src/workflows/review-post.ts` and "What rides where" in `src/workflows/finding.ts`.
2. A decision made after the workflow has parked rides on the signal that resumes it, because the input is already fixed. The `approve` signal's `publish` flag in `src/workflows/review-post.ts` is the worked case.
3. A new optional input field reads as `=== true`, never `?? <config default>`. An absent field means a history recorded before the field existed, and that history took the old branch. See `enableTellCitations` and `enableEprimeAlternatives` in `src/workflows/review-post.ts`.
4. A change that adds, removes or reorders a command on a path an open run can replay goes behind `wf.patched('<marker>')`. The marker is an exported constant, and the docblock says which histories lack it. See `ACTION_ADAPTER_PATCH`, `AUTO_FIX_PATCH` and `VERIFIER_HOSTED_PATCH` in `src/workflows/finding.ts`, and `BLOCKLESS_CONFIRM_PATCH` in `src/workflows/verify-finding.ts`.
5. A change that issues no new command on a replayed history needs no marker. Prove it with a fixture, and say why in the docblock. `src/workflows/reconcile-findings.ts` ("Replay": the old list shape reads as runs of unknown step) and the `note` field in `src/workflows/scorecard-audit.ts` are the two patterns.
6. Put the marker in the workflow whose commands changed. A child's new command is guarded in the child; the parent's replay is unchanged. `verifyFindingWorkflow` carries `verify-blockless-confirm` and `findingWorkflow` carries nothing for it.
7. A new activity in `reviewPost`'s `Promise.all` fan-out goes at the end of the array, behind an input flag. The array order is the replay contract; the comments at the fan-out in `src/workflows/review-post.ts` say why.
8. A later stage of work starts a new execution with a later `stopAfter`, so no open run replays through code it never ran. See `FindingStopAfter` in `src/workflows/finding.ts` and the docblock of `src/workflows/fix-finding.ts`.
9. Workflow files import nothing that touches `node:` or `process.env`, so they never import `config.ts`. Queue names are duplicated as constants, as in `src/workflows/finding.ts` and `src/workflows/verify-finding.ts`.
10. `new Date()` inside a workflow is the workflow clock, and replay-safe. `wf.now()` does not exist in the TypeScript SDK. See `workflowNow` in `src/workflows/review-post.ts`.
11. A workflow that starts long-lived workflows starts them through an activity and the worker's client, not as children. A child with no execution timeout inherits its parent's. See "Started through an activity" in `src/workflows/reconcile-findings.ts`.
12. A replay fixture does not catch a task-queue change: the SDK matches a child start on its workflow ID and type only. The `finding-verify-child-heavy.bin` docblock in `tests/workflows/replay.test.ts` records the probe.

Before changing workflow code:

1. List what is open. `steward inbox` shows parked reviews; `steward finding list` shows open finding runs. Each one replays the new code.
2. Add a replay fixture recorded from the pre-change code for any path an open run takes, in `tests/fixtures/histories/`, and a test for it in `tests/workflows/replay.test.ts`.
3. Prove the fixture can fail: inject `wf.sleep('1 second')` before the changed command, or delete the new `patched()` guard, and watch it fail with `TMPRL1100`. Revert, re-run green, and record the probe in the fixture's docblock.
4. Expect a red replay test when you change a command sequence on purpose. It is the change telling you what it would strand, not a broken test.

## Activities and workers

1. An activity a `steward-findings` workflow schedules must be registered by name in the `steward-findings` map in `src/hosted-registry.ts`. Adding one there claims it needs nothing local: no drafts, no checkout, no local login. `tests/lib/hosted-worker-registry.test.ts` checks the verifier's list against that map.
2. An activity that can launch Chromium joins `BROWSER_ACTIVITY_TYPES` in `src/lib/recycle-policy.ts`. A worker that has run none of them never recycles, so a missing name leaves its memory held.

## The test suite

Run it with `npm test -w @mattpyle/steward`. Typecheck Steward with `npx tsc --noEmit -p agents/steward` and the site with `npm run check`. CI runs both as `check:steward` and `test:steward` in the `Steward tests & tsc` job of `.github/workflows/ci.yml`.

1. A bare `npx tsc --noEmit` at the repository root crashes inside TypeScript. The root `tsconfig.json` excludes only `dist`, so it compiles dependency JavaScript. The crash is not your branch.
2. The workflow suites get a time-skipping test server from `createTestEnv` in `tests/helpers/test-env.ts`. Its binary is downloaded once per user, about 57 MB, into a per-user cache; `STEWARD_TEST_SERVER_DIR` overrides the path. A suite that waits on no timer can take a real dev server from `createLocalEnv` instead, as `tests/workflows/finding-retest.test.ts` does: the test server refused a workflow task that cancelled an activity after an Update (STW-593). Its binary, about 128 MB, is cached the same way; `STEWARD_DEV_SERVER_DIR` overrides the path.
3. The time-skipping client's `result()` unlocks time. A run idle at a signal wait then jumps past the test server's ten-year execution timeout and reads `TIMED_OUT`. Use a plain `Client` on `env.connection`, as the header of `tests/workflows/reconcile-findings.test.ts` explains.
4. A workflow test file starts a server per test (`beforeEach`, `afterEach`) and awaits at most one result per test through the time-skipping client.
   Why: an earlier test's timer can fire as a finishing test's worker shuts down, strand its task and hold the server's time lock, which stalls every later wait. See `tests/workflows/fix-dispatch.test.ts`.
5. The suite runs four files at a time (`--test-concurrency=4` in `package.json`). The default starts up to 12 test servers at once on a large desktop. Each test has 60 seconds (`--test-timeout=60000`).
6. `tests/helpers/no-real-credentials.ts` blanks `STEWARD_GITHUB_APP_ID`, `STEWARD_GITHUB_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `TEMPORAL_API_KEY`, `TEMPORAL_METRICS_API_KEY` and `TEMPORAL_READ_ONLY_API_KEY` in every test process. A test that needs GitHub installs `tests/helpers/fake-github.ts`.
7. Build a fake secret at run time, never as a literal: the gitleaks job in `.github/workflows/security-scan.yml` scans full history. See the stand-in secret in `tests/lib/fixer.test.ts`.
8. `npm ci` leaves `agents/steward/scripts/steward.mjs` modified with a line-ending-only diff. Leave it out of the commit.
9. A targeted run while you work: from `agents/steward`, `node --import tsx --import ./tests/helpers/no-real-credentials.ts --test --test-concurrency=4 --test-timeout=60000 "tests/<folder>/**/*.test.ts"`, or a single file in place of the glob. Keep the credential-guard import: without it two tests in `tests/lib` fail. Run the full suite once before the push; CI runs it again on the PR.
10. A workflow test takes `workflowBundle: await workflowBundle()` from `tests/helpers/workflow-bundle.ts`, never `workflowsPath`: the helper compiles the workflows once per test process, where `workflowsPath` recompiles them on every `Worker.create` and replay. A test that bundles a stub file keeps its own `workflowsPath`.
11. The deep audit's network isolation has two guards. `tests/lib/agent-audit-deep-handoff.test.ts` runs every time and asserts that `defaultRunners` hands the proxy's flags to Lighthouse and axe. `tests/lib/agent-audit-deep-chrome.test.ts` launches a real Chrome and skips unless `STEWARD_CHROME_TESTS=1`. CI sets the flag on a pull request that touches `src/lib/agent-audit/`, `audit-engine.ts`, `chrome-probe.ts`, the Dockerfile, `agents/steward/package.json`, `package-lock.json` or `ci.yml`, on the runner's preinstalled Chrome. A push to `master` leaves it off. The header table in `ci.yml` is the list. Run it locally with Chrome installed: from `agents/steward`, `$env:STEWARD_CHROME_TESTS = '1'; node --import tsx --import ./tests/helpers/no-real-credentials.ts --test --test-timeout=600000 tests/lib/agent-audit-deep-chrome.test.ts`. It took 16 seconds on matt-pc; the test allows ten minutes.
12. `tests/console/browser.test.ts` drives the real console page in system Google Chrome through Playwright's `chrome` channel, with fake backends, and needs no browser download. The `ubuntu-latest` runner has Chrome. Without Chrome the test skips locally and fails when `CI` is set.
13. CI runs the tests whose imports reach a changed file, not the whole suite. `scripts/select-steward-tests.mjs` builds the import graph with TypeScript's program and prints the test files; the Steward job runs it after `npm ci` on the changed files that `scripts/route-changes.sh` passes on. A change confined to `src/console/` and `tests/console/`, assets included, skips the graph and runs `tests/console/**`. The full suite runs on every push to `master`, on a change to `tests/helpers/`, `tests/fixtures/`, `package.json`, the lockfile, a `tsconfig`, `ci.yml` or the routing scripts, and on a non-TypeScript file that no TypeScript folder owns. A change under `src/workflows/` adds `tests/workflows/replay.test.ts`. A change no test reaches runs the typecheck only, and the job log says so. The header of `ci.yml` has the table.
14. The graph follows runtime imports only. A test that names source by a string (`workflow-bundle.ts` bundles `src/workflows/index.ts`; the CLI tests spawn `src/cli.ts`; two tests read `worker.ts` as text) gets an edge from the string. A test that lists a whole source directory goes in `DIRECTORY_READERS` in the script, and `tests/select-steward-tests.test.mjs` fails until it does. A new test that loads source in a way neither covers needs the same entry.
15. Run the same selection for the files you changed, from the repository root: `git diff --name-only origin/master | node scripts/select-steward-tests.mjs` prints the test files, or the glob when the full suite is due. Add `git ls-files --others --exclude-standard` output for new files. In PowerShell, run the list from `agents/steward` with the flags from item 9: `$tests = (git diff --name-only origin/master | node ../../scripts/select-steward-tests.mjs) -split ' '`, then `node --import tsx --import ./tests/helpers/no-real-credentials.ts --test --test-concurrency=4 --test-timeout=60000 $tests`. The reasons print on standard error.

## Running the CLI

Run a verb from the repository root with `npm run steward -w @mattpyle/steward -- <verb>`. `steward <verb> --help` prints its real options. When a command fails silently, run `npx tsx src/cli.ts <verb>` from `agents/steward` instead: the npm and shim wrappers can swallow the CLI's own error.

The `steward finding` verbs reach Temporal through the client and need no local worker. A `reviewPost` run advances only while `steward up` is running.

## Secrets

Never read `agents/steward/.env`, not even masked: a masked read still leaks comment lines and multi-line values. To learn whether a value is set, ask code for a boolean, such as `IS_TEMPORAL_CLOUD` from `src/config.ts`, or ask Matt. The variable names are in `.env.example`.
