import { test } from 'node:test';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import proto from '@temporalio/proto';
import { workflowBundle } from '../helpers/workflow-bundle.js';

/**
 * Replay regression test (temporal-developer skill, testing.md § Replay Testing).
 *
 * This is the tripwire for Steward's normal operating condition: reviews
 * park on `wf.condition` for as long as the human takes, so at almost any given
 * moment there is a workflow sitting mid-wait whose history was written by an
 * older version of `reviewPost`. If a code change alters the sequence of
 * commands the workflow issues, those parked reviews fail to replay with a
 * non-determinism error and cannot be resumed — a signal the human already sent
 * is stranded.
 *
 * ## The fixture (re-exported for Phase 1b)
 *
 * The Phase 1a fixture was **deliberately retired**, not lost. Phase 1b added
 * `runVale` and `editorialPass` to the fan-out, which changes the command
 * sequence, so the old history stopped replaying exactly as the hardening
 * session predicted it would:
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'checkFrontmatter' does not match activity type of activity command 'runVale'
 * ```
 *
 * That break is a legitimate versioning finding, not a regression: adding
 * activities to a parallel fan-out is not a replay-safe change, and nothing in
 * production was parked on the old shape. The old fixture
 * is not kept alongside this one — a guard for a history shape no live workflow
 * has is a decoration.
 *
 * The current fixture is a real Phase 1b execution (113 events) covering the
 * full cycle: fan-out → `applyPatches` → `applyPatchesActivity` → `rereview` →
 * a second full fan-out → `approve --force` → completion. It is a strictly
 * better guard than the Phase 1a run, because it exercises both fan-outs, the
 * patch activity, and all three signal handlers.
 *
 * ## This test was verified to be able to fail
 *
 * A green replay test that cannot go red is worthless. A `wf.sleep('1 second')`
 * was temporarily injected before the first activity and this test failed with
 * `[TMPRL1100] ... Timer machine does not handle this event`, then the probe was
 * reverted and the test re-run green. Do this again for any new fixture; it
 * takes two minutes and it is the difference between a guard and a decoration.
 *
 * `runReplayHistory` throws on a determinism mismatch, so no assertion is
 * needed — reaching the end of the test is the pass condition.
 */

/**
 * ## Phase 1c: the expected break that did not happen
 *
 * Adding `buildAndAuditDraft` to the fan-out was budgeted as a third consecutive
 * fixture re-export — by the rule above, a new activity in a parallel fan-out is
 * not replay-safe and the 1b history should have died with TMPRL1100.
 *
 * **It replayed clean.** The reason is that the build audit is gated on
 * `input.skipBuildAudit`, and the 1b history recorded `skipBuildAudit: true`.
 * Replaying it takes the same branch it took originally, emits the same four
 * activity commands, and matches. Had the gate been read from `config.ts`
 * instead — the obvious place to put a phase flag — the flipped constant would
 * have sent an old history down the new branch and broken every parked review.
 *
 * The transferable rule: **a feature flag that changes a workflow's command
 * sequence belongs in the workflow input, not in configuration.** Input is in
 * the history, so a replay reproduces the decision that was actually made;
 * config is read fresh at replay time and rewrites history's past.
 *
 * The 1b fixture is therefore *kept*, not retired — it still guards the richer
 * signal/patch/rereview cycle. The 1c fixture below is added alongside it
 * because 1b covers a path where the build audit is skipped, and nothing would
 * otherwise guard the fan-out shape Steward now takes by default.
 */

/**
 * ## Coverage matrix: what each workflow's fixtures replay, and what none does
 *
 * One row per workflow in `src/workflows/`. A fixture guards only the commands
 * it holds, so a change to a branch in the last column replays green against
 * every fixture here and strands an open run that took it. Measured on
 * 2026-11-07 by listing the commands each history records. A change to one of
 * those branches needs its own fixture, recorded before the change
 * (`agents/steward/CLAUDE.md`, "Before changing workflow code").
 *
 * | Workflow | Fixtures | Branches no fixture covers |
 * | --- | --- | --- |
 * | `reviewPost` | `phase1b-smoke-test.json`, `phase1c-build-audit.json`, `review-post-publish-verify.bin` | Audit mode. A reject. A refused approve (blocking findings, stale hash). A publish failure parked at `awaiting_verdict`. A red PR check, and ten exhausted verifications, both parked at `publishing`. The repeat approve that resumes. The optional fan-out additions (`tellCitations`, `eprimeAlternativesPass`, the ai-tells pass). |
 * | `auditSiteWorkflow` | `stage3-audit-site-fanout.json` | The fast tier (`auditSiteFast`). A deep audit with a skipped page (robots, the shared budget, a blocked target) or a browser failure. |
 * | `scorecardAuditWorkflow` | `scorecard-dry-run.json`, `scorecard-performance-recheck-pre.bin`, `scorecard-mixed-lighthouse-pre.bin`, `scorecard-publish-pre-merge.bin`, `scorecard-nightly-merged-pre.bin`, `scorecard-nightly-noop-pre.bin`, `scorecard-unhealthy-merged-pre.bin` | A merge refusal and the second, failing ping. The Performance re-check's extra `auditLiveUrl` calls and the mixed-Lighthouse refusal on current code (both fixtures predate their markers). A run that throws, and the audit-set guard. |
 * | `findingWorkflow` | `finding-verdict-cli.json`, `finding-verdict-file.json`, `finding-child-fix-returned.bin`, `finding-opportunity-auto-fix-attempt.bin`, `finding-pr-closed-before-dispatch.bin`, `finding-pr-closed-before-preview-test.bin`, `finding-preview-passed-before-retest.bin`, `finding-pushed-retest-pre.bin`, `finding-verify-child-heavy.bin`, `finding-verify-unverifiable.bin`, `finding-approved-before-verdict-measure.bin`, `finding-parked-before-verdict-update.bin`, `finding-waits-for-person-parked-pre.bin`, `finding-settings-at-use.bin`, `finding-parked-with-issue-pre.bin`, `finding-parked-issue-reread.bin`, `finding-reopened-pre.bin`, `finding-verify-failed-pre.bin`, `finding-merge-timeout-pre.bin`, `finding-deploy-timeout-pre.bin`, `finding-park-resume-resolved.bin`, `finding-park-request-fix.bin`, `finding-merge-rewait.bin`, `finding-watch-stop-pre.bin`, `finding-watching.bin`, `finding-watch-resolved.bin`, `finding-watch-measure-now.bin`, `finding-watch-rejected.bin`, `finding-watch-reject-loses.bin`, `finding-watch-decided.bin`, `finding-watch-bound.bin`, `finding-watch-look.bin`, `finding-writes-exhausted-pre.bin`, `finding-verdict-write-failed-pre.bin`, `finding-verdict-parked.bin`, `finding-settings-parked.bin`, `finding-pr-bound-parked-pre.bin`, `finding-pr-bound-reopen.bin` | On the settings-at-use path: the `closed` ending of a run with no issue, the one-day rest after an attempt that failed before any issue, run to its end, a held run. The measurement at the verdict itself (a measured result, the resolve without a fix, the moved finding held at `waiting-fix`). A fix attempt the dispatcher holds: the `slot-grant` wait, the re-request after `SLOT_RESEND`, the release signal. A preview test that fails or goes unmeasured, and the retest itself (a `pushed` merge wait, the `retest` Update). A verdict by the `record-verdict` Update: `finding-verdict-update.test.ts` compares its history with a Signal's, and no fixture replays one. The conflict close and re-cut. On the STW-653 paths: the deploy re-wait, a park at `merge`, `returned` or `deploy`, and a `closed` ending after the PR. Stage 4: the `stopped` ending of a watch, and a rejection written when the watch answers `stopped`. STW-689: a park at `settings` in the lifecycle, a replacing verdict at `verdict`, the `closed` ending of a moved verdict write, and a call issued again at its bound (`finding-failure-parks.test.ts`). |
 * | `fixFindingWorkflow` (frozen) | `fix-finding-pr.bin`, `fix-finding-preview.bin` | The diff review (`reviewFixDiff`) on current code. A refusal (`FindingNotFixable`). A finding with no checks. |
 * | `verifyFindingWorkflow` | `verify-finding-blockless.bin`, `verify-finding-checks-pre-heartbeat.bin`, `verify-finding-slow-phase.bin` | The checks path ending reopened. The slow phase of the blockless read and of the write. The blockless confirm by deploy (`readProductionDeploy`). The refusals (`FindingNotVerifiable`, `FixNotMerged`, `FixNotLive`). |
 * | `fixDispatchWorkflow` | `fix-dispatch-grant-after-release.bin` | The hourly sweep (`runningWorkflowIds`). A grant whose signal fails. A re-sent request for a held ticket. The idle close. The continue-as-new rollover is a test in `fix-dispatch.test.ts`, not a replay. |
 * | `recheckFindingsWorkflow` | `recheck-findings-pre-heartbeat.bin`, `recheck-findings-watch-pre.bin`, `recheck-findings-watching.bin` | A recheck that throws (`reportRunHealth` before the rethrow). A site with no approved finding. On a watch site, a `skipped` row (the same commands as `no run`). |
 *
 * `tests/lib/finding-report.test.ts` also reads `finding-resolved-action.bin`.
 * It reports on that history and does not replay it.
 */

const historyPath = fileURLToPath(
  new URL('../fixtures/histories/phase1b-smoke-test.json', import.meta.url),
);
const buildAuditHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/phase1c-build-audit.json', import.meta.url),
);
const auditSiteHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/stage3-audit-site-fanout.json', import.meta.url),
);
const scorecardHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/scorecard-dry-run.json', import.meta.url),
);

test(
  'the Phase 1b smoke-test history still replays against current workflow code',
  { timeout: 120_000 },
  async () => {
    const history = JSON.parse(await fs.readFile(historyPath, 'utf8'));

    await Worker.runReplayHistory(
      { workflowBundle: await workflowBundle() },
      history,
      'steward-review-phase1b-live-fixture',
    );
  },
);

test(
  'the Phase 1c history — the first run with the build audit in the fan-out — replays',
  { timeout: 120_000 },
  async () => {
    // A real audited execution of `hello-world`: the five-way fan-out including
    // `buildAndAuditDraft` on the heavy queue, through to `awaiting_verdict`.
    // Verified able to fail — see the note above.
    const history = JSON.parse(await fs.readFile(buildAuditHistoryPath, 'utf8'));

    await Worker.runReplayHistory(
      { workflowBundle: await workflowBundle() },
      history,
      'steward-review-hello-world',
    );
  },
);

/**
 * ## `auditSiteWorkflow`: the stage-1 fixture was retired, deliberately
 *
 * The stage-1 fixture was a deep audit run as **one** `auditSiteDeep` activity.
 * Stage 3 replaced that with a fan-out — `auditSiteFetchChecks`, one
 * `auditRenderedPage` per sampled page, then `assembleDeepAudit` — which is the
 * canonical unsafe change: a history whose first activity command was
 * `auditSiteDeep` cannot replay against code that now schedules
 * `auditSiteFetchChecks`, and it duly failed with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'auditSiteDeep' does not match activity type of activity command
 * 'auditSiteFetchChecks'
 * ```
 *
 * That break was accepted rather than patched around. `auditSiteWorkflow` never
 * parks: it runs for seconds to a few minutes and nothing about it waits on a
 * human, so the window in which an open execution could be stranded is the
 * length of one audit. The pre-flight for the change confirmed the window was
 * empty — no running audits in either namespace — and `patched()` would have
 * bought a permanent branch in the workflow to protect a history that no live
 * execution had. The old fixture is not kept alongside this one for the same
 * reason the Phase 1a fixture was not: a guard for a history shape nothing can
 * produce any more is a decoration.
 *
 * The fixture below is a real fan-out execution against `https://www.mattpyle.com`
 * on 2026-08-14, on the Temporal Cloud namespace: 35 events, the fetch pass,
 * three per-page activities, and assembly, all on `steward-audit`, through to
 * completion with the canonical result document in the history. It is a strictly
 * better guard than the stage-1 run, because it pins the whole fan-out order
 * rather than a single activity.
 *
 * **Verified able to fail** by the docblock's rule, on this fixture rather than
 * on trust. A `wf.sleep('1 second')` injected before `auditSiteFetchChecks`, the
 * workflow's first activity, produced
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 5, ActivityTaskScheduled)
 * ```
 *
 * and failed this test alone, leaving the other three green. The probe was
 * reverted and all four fixtures re-run green.
 */
test(
  'the stage-3 fan-out audit history replays against current workflow code',
  { timeout: 120_000 },
  async () => {
    const history = JSON.parse(await fs.readFile(auditSiteHistoryPath, 'utf8'));

    await Worker.runReplayHistory(
      { workflowBundle: await workflowBundle() },
      history,
      'steward-audit-www.mattpyle.com-deep-fanout1',
    );
  },
);

/**
 * ## `scorecardAuditWorkflow`: manufactured, not waited for
 *
 * Until this fixture existed, "the replay fixtures are untouched" was
 * *vacuously* true for the scorecard — there was nothing for a change to it to
 * break. That mattered more than it sounds: it is the workflow most likely to
 * grow input fields next, and it already grew one (`note`, PR #108) whose
 * replay safety was reasoned about by hand rather than measured.
 *
 * Unlike the publish leg, this history did not have to be waited for. A
 * `steward scorecard --dry-run` produces a *complete* execution — the flag skips
 * step 4's publish and makes step 5's archive log instead of commit — so the
 * whole command sequence is exercised without touching GitHub. The fixture is a
 * real run against `https://www.mattpyle.com` on 2026-08-19, workflow ID
 * `steward-scorecard-2026-08-20T04-31-04-076Z` on the Temporal Cloud namespace:
 * 167 events, `resolveAuditUrls` → `readPublishedScorecard` → 23 serial
 * `auditLiveUrl` activities → `resolveRunStamp` → `archiveScorecardRun`, through
 * to completion.
 *
 * **What it does not guard, deliberately.** A dry run takes the `publishMode ===
 * 'pr'` branch's false arm, so `publishScorecardRun` appears nowhere in this
 * history and a change to the publish leg replays clean against it. It is also
 * a *manual* run, so the `triggeredBy === 'schedule'` arms — the credential
 * check and the nightly health signal — are absent for the same reason. Both
 * gaps are the price of a fixture that can be manufactured at all, and both are
 * the shape the workflow's own docblocks say those branches take. What this
 * fixture does pin is the part every run shares: the step order, the fan-out,
 * and the fact that the fan-out is serial.
 *
 * **Verified able to fail** by the rule at the top of this file, on this fixture
 * rather than on trust. A `wf.sleep('1 second')` injected before step 0's
 * `resolveAuditUrls` produced
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 5, ActivityTaskScheduled)
 * ```
 *
 * and the other three fixtures stayed green, which is the second half of the
 * evidence: the probe broke exactly the history it should have.
 *
 * The probe was reverted and all four fixtures re-run green.
 *
 * **It also guards `scorecard-run-shape-recovery`.** The fixture is a healthy
 * manual run that ended at the archive leg, so it is the history the healthy
 * `run-shape` ping would strand. Probe: with the `wf.patched(RUN_SHAPE_RECOVERY_PATCH)`
 * guard removed, so the ping is issued unconditionally, this replay failed with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity machine does not handle this event:
 * HistoryEvent(id: 167, WorkflowExecutionCompleted)
 * ```
 *
 * The guard was restored and the replay re-run green.
 */
test(
  'the scorecard dry-run history replays against current workflow code',
  { timeout: 120_000 },
  async () => {
    const history = JSON.parse(await fs.readFile(scorecardHistoryPath, 'utf8'));

    await Worker.runReplayHistory(
      { workflowBundle: await workflowBundle() },
      history,
      'steward-scorecard-2026-08-20T04-31-04-076Z',
    );
  },
);

/**
 * ## `findingWorkflow`: two `'verdict'` histories, from before the lifecycle
 *
 * The lifecycle (fixer-merge-and-verify) taught `findingWorkflow` a second stop
 * point, `'resolved'`. Executions started before it carry `stopAfter:
 * 'verdict'`, and one was still open on the Temporal Cloud namespace when the
 * change was built, so the `'verdict'` path must issue exactly the commands it
 * always did. Both fixtures are real executions exported from the Cloud
 * namespace on 2026-10-13:
 *
 * - `finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard`: a CLI
 *   approve, so the verdict signal then `writeFindingVerdict`. 15 events.
 * - `finding/mattpyle-com/direction-no-dark-mode--sitewide`: a file-source
 *   reject from the reconciler, so the signal and no activity. 9 events.
 *
 * **Verified able to fail**: a `wf.sleep('1 second')` injected after the
 * verdict condition failed both with a nondeterminism error. The probe was
 * reverted and both re-run green.
 *
 * They are also the proof that the `discord` verdict source carries no marker:
 * the source decides whether `writeFindingVerdict` is scheduled, and these are
 * the two values a history recorded before it can hold. The CLI one must still
 * schedule the write and the file one must still schedule nothing.
 */
const findingCliHistoryPath = fileURLToPath(new URL('../fixtures/histories/finding-verdict-cli.json', import.meta.url));
const findingFileHistoryPath = fileURLToPath(new URL('../fixtures/histories/finding-verdict-file.json', import.meta.url));

test('a verdict-only finding history with a CLI approve replays against current workflow code', { timeout: 120_000 }, async () => {
  const history = JSON.parse(await fs.readFile(findingCliHistoryPath, 'utf8'));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});

test('a verdict-only finding history with a file reject replays against current workflow code', { timeout: 120_000 }, async () => {
  const history = JSON.parse(await fs.readFile(findingFileHistoryPath, 'utf8'));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/direction-no-dark-mode--sitewide',
  );
});

/**
 * A fix child as `fixFindingWorkflow` ran it before the `verify` block's two
 * tests: read, generate, run, open, write, and no `patched` marker. New code
 * must take the same five steps on replay, which is what the
 * `fixer-preview-verify` patch is for. A probe that deleted the `patched()`
 * guard made this replay fail with a nondeterminism error (2026-10-13).
 *
 * Recorded from the pre-change code against the time-skipping server, with the
 * fix suite's mocked activities, so it holds no real finding text. Stored as the
 * protobuf binary because the SDK's `historyToJSON` throws on this server's
 * payloads ("toProto3JSON: don't know how to convert value json/plain").
 */
const fixFindingHistoryPath = fileURLToPath(new URL('../fixtures/histories/fix-finding-pr.bin', import.meta.url));

test('a fix child recorded before the preview test replays down its five steps', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(fixFindingHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'fix/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});

/**
 * A fix child as `fixFindingWorkflow` ran it with the `verify` block's two
 * tests and before the diff review: the `fixer-preview-verify` marker and no
 * `fixer-diff-review` one. New code must open the PR straight after the fixer
 * on replay, which is what the `fixer-diff-review` patch is for.
 *
 * Recorded from the pre-change code (85b2e3d) the same way as the fixture
 * above, with the checks suite's mocked activities on its passing path.
 */
const fixFindingPreviewHistoryPath = fileURLToPath(new URL('../fixtures/histories/fix-finding-preview.bin', import.meta.url));

test('a fix child recorded before the diff review replays without it', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(fixFindingPreviewHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'fix/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});

/**
 * A lifecycle run as `findingWorkflow` ran it before the issue path: approved,
 * one `fix`, a `fixFindingWorkflow` child that opened a PR, the PR closed
 * unmerged, and the run parked back at `waiting-fix`. New code must replay
 * that attempt as a child, which is what the `fixer-action-adapter` patch is
 * for, and must not read `auto_fix` on a run already past its verdict, which
 * is the `fixer-auto-fix` patch.
 *
 * Recorded from the pre-change code (2a9ae4d) against the time-skipping
 * server, with mocked activities and the stub child, so it holds no real
 * finding text.
 */
const findingChildHistoryPath = fileURLToPath(new URL('../fixtures/histories/finding-child-fix-returned.bin', import.meta.url));

test('a lifecycle run whose first fix was a child replays that attempt as a child', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingChildHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});

/**
 * A lifecycle run as `findingWorkflow` ran it before the hosted verifier:
 * approved with `auto_fix`, the issue, the PR, the merge and the deploy, then
 * `verifyFindingWorkflow` started on `steward-heavy` and resolved. New code
 * must replay that start on `steward-heavy`, which is what the
 * `verifier-hosted` patch is for.
 *
 * Two probes (2026-10-15). A timer injected before the child start made this
 * replay fail with `[TMPRL1100] Timer machine does not handle this event`, so
 * the fixture guards the command sequence up to and through the verify start.
 * Deleting the `patched()` guard, so the child always starts on
 * `steward-findings`, replayed green: the SDK matches a child start on its
 * workflow ID and type, not its task queue. The marker keeps the history
 * honest about where each verify ran; the replay does not depend on it.
 *
 * Recorded from the pre-change code (76b1680) the same way as the fixture
 * above.
 *
 * It is also the fixture behind the waits' retry-policy change (2026-10-22):
 * its merge and deploy waits were scheduled with `AuthError` in
 * `nonRetryableErrorTypes`, and the list no longer names it. The history
 * replays green without a marker because the SDK matches an activity on its
 * type and does not compare retry attributes, as the workflow docblock says.
 */
const findingVerifyHeavyHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/finding-verify-child-heavy.bin', import.meta.url),
);

test('a lifecycle run that started its verify child on steward-heavy replays that start', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingVerifyHeavyHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});

/**
 * Two histories from before design decision 30, when a finding with no
 * `verify` block ended its verify `unverifiable` and nothing was written.
 *
 * - `verify-finding-blockless.bin`: the verify alone, read, PR, block, done.
 *   New code reads production and writes on a blockless finding, so this
 *   replays only because the `verify-blockless-confirm` patch sends a history
 *   without its marker down the old ending.
 * - `finding-verify-unverifiable.bin`: a lifecycle run through the merge, the
 *   deploy and that child, ending `unverifiable`. The parent's commands did not
 *   change; it pins that the old ending is still a result the run accepts.
 *
 * Probe (2026-10-16): deleting the `patched()` guard in `verifyFindingWorkflow`
 * made the verify fixture fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity machine does not handle this
 * event: HistoryEvent(id: 23, WorkflowExecutionCompleted)
 * ```
 *
 * and left the lifecycle fixture green. The guard was restored and both re-run
 * green.
 *
 * Recorded from the pre-change code (448be2b) against the time-skipping
 * server with mocked activities, as the fixtures above.
 */
const verifyBlocklessHistoryPath = fileURLToPath(new URL('../fixtures/histories/verify-finding-blockless.bin', import.meta.url));
const findingUnverifiableHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/finding-verify-unverifiable.bin', import.meta.url),
);

test('a blockless verify recorded before decision 30 replays to its unverifiable ending', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(verifyBlocklessHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'verify/mattpyle-com/content-perfect-score-labelled-fail--scorecard/2026-10-13T041233Z',
  );
});

test('a lifecycle run whose child ended unverifiable still replays to that ending', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingUnverifiableHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});

/**
 * An approved opportunity on an `auto_fix` site as `findingWorkflow` ran it
 * before `waitsForPerson`: the file verdict, `readSiteAutoFix` answering true,
 * the automatic `openFixIssue` refused by the gate with `FindingNotFixable`, and
 * the run parked at `waiting-fix` with `fixAttempts` 1. 24 events. This is the
 * shape of the two opportunity runs the 2026-10-23 reconcile approved. New code
 * must replay that attempt, which it does because the input carries no
 * `waitsForPerson` and the workflow reads the field as `=== true`: no marker.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at 0b28c29) against
 * the time-skipping server with mocked activities, so it holds no real finding
 * text.
 *
 * Probe (2026-10-23): replacing `input.waitsForPerson === true` in `lifecycle`
 * with `input.waitsForPerson !== false`, so an absent field parks the run,
 * made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 * for change fixer-action-adapter, but there is no corresponding change command!
 * ```
 *
 * The verify-heavy fixture above, which also made its automatic attempt, failed
 * the same way; the other 11 replays stayed green. The `=== true` read was
 * restored and all 13 re-run green.
 */
const findingOpportunityAttemptHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/finding-opportunity-auto-fix-attempt.bin', import.meta.url),
);

test('an opportunity that made its automatic fix attempt before waitsForPerson replays that attempt', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingOpportunityAttemptHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/opportunity-park-example--steward',
  );
});

/**
 * Two scorecard histories from before the 2026-10-29 markers. Both are manual
 * `publishMode: 'pr'` runs, so the publish leg is in the history and a guard
 * that skips it would show. Neither is a real run: each was recorded against
 * the time-skipping server with mocked activities, so it holds no real page
 * data. Stored as protobuf binary for the reason the fix-child fixtures give.
 * Each was recorded from a separate `git archive` of its commit, so current
 * code never ran the recording.
 *
 * - `scorecard-performance-recheck-pre.bin`, from `8853333` (before PR 464).
 *   Two pages, Performance 87 and 100, one Lighthouse version. The workflow
 *   went from the fan-out to `resolveRunStamp`. Current code re-measures the
 *   87 page, so it replays only because `scorecard-performance-recheck` sends
 *   a history without the marker down the old path. 55 events.
 * - `scorecard-mixed-lighthouse-pre.bin`, from `6a416c5` (before PR 465). Two
 *   pages at Performance 100 with Lighthouse 13.5.0 and 13.4.0. The workflow
 *   went on to `publishScorecardRun`. Current code refuses a mixed run, so it
 *   replays only because `scorecard-mixed-lighthouse-refusal` keeps the old
 *   history on the publish path. 55 events.
 *
 * `scorecard-dry-run.json` holds neither shape and replays green with or
 * without either guard (probe, 2026-10-29), which is why these two exist.
 *
 * Probes (2026-10-29), each with that marker's `wf.patched()` call removed:
 *
 * - Performance re-check: the performance fixture failed with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'resolveRunStamp' does not match activity type of activity command
 * 'auditLiveUrl'
 * ```
 *
 * - Mixed refusal: the mixed fixture failed with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'publishScorecardRun' does not match activity type of activity command
 * 'archiveScorecardRun'
 * ```
 *
 * Each probe failed its own fixture alone: the other 14 replays stayed green,
 * `scorecard-dry-run.json` included. Both guards were restored and all 15
 * re-ran green.
 */
const scorecardPerformanceHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/scorecard-performance-recheck-pre.bin', import.meta.url),
);
const scorecardMixedHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/scorecard-mixed-lighthouse-pre.bin', import.meta.url),
);

test('a scorecard run recorded before the Performance re-check replays without it', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(scorecardPerformanceHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'steward-scorecard-fixture-perf',
  );
});

test('a scorecard run recorded before the mixed-Lighthouse refusal replays down its publish leg', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(scorecardMixedHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'steward-scorecard-fixture-mixed',
  );
});

/**
 * ## `scorecard-publish-pre-merge.bin`: a publishing run from before the merge leg
 *
 * A manual run that decided `open-pr`, called `publishScorecardRun` (a result of
 * branch, URL and id, with no pull request number, head commit or `committed`),
 * archived, sent the healthy `run-shape` ping and completed. 49 events.
 *
 * Recorded 2026-11-09 from `origin/master` at 3289ca4, the code before the merge
 * leg, against the time-skipping server with mocked activities, so it holds no
 * real run. It is the history an in-flight publishing run would carry across the
 * deploy. New code must replay it to the same end: no merge command after the
 * ping.
 *
 * **Probes.** A `wf.sleep('1 second')` injected after the archive,
 * standing in for an unguarded wait, failed it with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 35, ActivityTaskScheduled)
 * ```
 *
 * Deleting the `wf.patched(SCORECARD_AUTO_MERGE_PATCH)` guard did not fail it,
 * and this fixture cannot prove that marker. Its publish result lacks the pull
 * request number and head commit, so the leg has nothing to start from whether or
 * not the marker is read. The new result fields keep an old history out of the
 * leg; the marker records the change for histories recorded after it. Both
 * probes were reverted and the replay re-run green.
 */
const scorecardPublishHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/scorecard-publish-pre-merge.bin', import.meta.url),
);

test('a scorecard run that published before the merge leg replays with no merge after it', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(scorecardPublishHistoryPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'steward-scorecard-fixture-publish',
  );
});

/**
 * A lifecycle run as `findingWorkflow` ran it before the fix dispatcher: CLI
 * approve, one `fix`, the issue, the PR, the PR closed unmerged, the return
 * written, and the run parked back at `waiting-fix` with `fixAttempts` 1. 55
 * events. This is the shape an approved run is in while a person decides on a
 * closed PR. New code asks `dispatch/<site>` for a slot before the issue, so
 * this replays only because the `fix-dispatch` patch sends an attempt without
 * its marker straight to `openFixIssue`, with the one-argument merge wait and
 * no release.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at d8ddc8a) against
 * the time-skipping server with mocked activities, so it holds no real finding
 * text.
 *
 * Probe (2026-10-30): replacing `wf.patched(FIX_DISPATCH_PATCH)` with `true`,
 * so every attempt asks for a slot, made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 * for change fixer-action-adapter, but there is no corresponding change command!
 * ```
 *
 * The four older lifecycle fixtures above failed too (`finding-child-fix-returned.bin`
 * on its child start, the other three on the same marker); the 11 replays of
 * other workflows stayed green. The guard was restored and all 16 re-ran green.
 */
const findingPrClosedBeforeDispatchPath = fileURLToPath(
  new URL('../fixtures/histories/finding-pr-closed-before-dispatch.bin', import.meta.url),
);

test('a lifecycle run whose PR closed before the dispatcher replays that attempt without a slot', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingPrClosedBeforeDispatchPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});

/**
 * A lifecycle run as `findingWorkflow` ran it before the preview test: file
 * approve, one `fix`, the issue, the PR, the PR closed unmerged, the return
 * written, and the run parked back at `waiting-fix` with `fixAttempts` 1. 57
 * events. New code reads the finding's checks and waits for the PR's preview
 * right after the PR is known, so this replays only because the
 * `fix-preview-test` patch sends an attempt without its marker straight to the
 * merge wait.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at 3b47ac8, a
 * `git archive` of it) against the time-skipping server with mocked
 * activities, so it holds no real finding text.
 *
 * Probe (2026-10-31): replacing `wf.patched(PREVIEW_TEST_PATCH)` with `true`
 * made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'awaitFixPrMerge' does not match activity type of activity command 'readFinding'
 * ```
 *
 * The three older lifecycle fixtures that reach the merge wait on the issue path
 * (`finding-verify-child-heavy.bin`, `finding-verify-unverifiable.bin` and
 * `finding-pr-closed-before-dispatch.bin`) failed the same way; the other 13
 * replays stayed green. The guard was restored and all 17 re-ran green.
 */
const findingPrClosedBeforePreviewTestPath = fileURLToPath(
  new URL('../fixtures/histories/finding-pr-closed-before-preview-test.bin', import.meta.url),
);

test('a lifecycle run whose PR closed before the preview test replays that attempt without it', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingPrClosedBeforePreviewTestPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/content-post-describes-removed-filter-pills--writing-accessibility-and-ai',
  );
});

/**
 * A lifecycle run as `findingWorkflow` ran it before the retest (STW-587): file
 * approve, one `fix`, a slot the activity granted, the issue, the PR, the
 * preview test with one check that passed, the merge wait, the PR closed
 * unmerged, the return written, and the run parked back at `waiting-fix` with
 * `fixAttempts` 1. 89 events. It is the shape of the one lifecycle run open
 * when this shipped: a passed preview test, then the merge wait.
 *
 * New code races that merge wait against the `retest` Update in a cancellation
 * scope and passes `retestAfter` to the poll. Neither issues a command, so this
 * replays with no `patched` marker (determinism rule 5); the new commands start
 * only after a `pushed` result or an accepted Update, which no earlier history
 * holds. The docblock of `findingWorkflow`, "The retest", says why.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at 32b0410, the
 * worktree before its first edit) against the time-skipping server with mocked
 * activities, so it holds no real finding text.
 *
 * Probe (2026-11-10): injecting `await wf.sleep('1 second')` before the poll in
 * `mergeOrRetest` made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 78, ActivityTaskScheduled)
 * ```
 *
 * It was the only failure: no other fixture holds a preview test that found
 * checks, so no other one reaches the new merge wait. The sleep was removed and
 * all 24 replays re-ran green.
 */
const findingPreviewPassedBeforeRetestPath = fileURLToPath(
  new URL('../fixtures/histories/finding-preview-passed-before-retest.bin', import.meta.url),
);

test('a lifecycle run that passed its preview test before the retest replays its merge wait unchanged', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingPreviewPassedBeforeRetestPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/agent-readiness-retest-fixture--webmcp-index-json',
  );
});

/**
 * A lifecycle run with a pushed retest, as `findingWorkflow` ran it before the
 * fix log entry step (STW-710): approve, the fix signal, the issue, the PR, a
 * preview test with one check that failed (PR made a draft), a merge wait that
 * returned `pushed`, a retest that passed (draft cleared), a second merge wait,
 * the PR closed unmerged, the return written, and the run parked back at
 * `waiting-fix` with `fixAttempts` 1. 152 events.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at e9902e0, the
 * worktree before its first edit) against a local dev server with the mocked
 * activities of `finding-retest.test.ts`, so it holds no real finding text.
 * The worker and client identity is `fixture`, and every failure's stack trace
 * was cleared before the history was written: replay compares neither, and a
 * trace names the recording machine's paths.
 *
 * New code writes the fix log entry after a test that passed, behind
 * `fix-log-entry` (`FIX_LOG_ENTRY_PATCH` in `src/workflows/finding.ts`). This
 * history has no marker there, so its passing retest goes straight to the
 * second merge wait, as recorded.
 *
 * Probe (2026-11-27): deleting the `wf.patched(FIX_LOG_ENTRY_PATCH)` guard made
 * this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'awaitFixPrMerge' does not match activity type of activity command
 * 'draftFixLogEntry'
 * ```
 *
 * 13 of the 59 replays failed the same way: every fixture with a preview test
 * that passed, or a finding with no checks on the issue path. The guard was put
 * back and all 59 re-ran green.
 */
const findingPushedRetestPrePath = fileURLToPath(
  new URL('../fixtures/histories/finding-pushed-retest-pre.bin', import.meta.url),
);

test('a lifecycle run with a pushed retest, recorded before the fix log entry step, replays', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingPushedRetestPrePath));
  await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, 'finding/mattpyle-com/pushed-retest-fixture');
});

/**
 * A lifecycle run as `findingWorkflow` ran it before the measurement at the
 * verdict (STW-589): CLI approve and its write, the `fixer-auto-fix` marker
 * and `readSiteAutoFix` (on), a slot the activity granted, the issue, the PR,
 * a preview test with one check that failed, the merge wait, the PR closed
 * unmerged, the return written, and the run parked at `waiting-fix` with
 * `fixAttempts` 1. 94 events.
 *
 * New code measures the finding's checks on production right after the
 * verdict write, before `readSiteAutoFix`, so this replays only because
 * `verdict-measure` sends a history without the marker straight to the
 * auto-fix read. No run was past its verdict when this shipped; every
 * `resolved` run waiting for a verdict takes the new path live.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at cd966e0, the
 * worktree before its first edit) against the time-skipping server with mocked
 * activities, so it holds no real finding text.
 *
 * Probe (2026-11-11): replacing `wf.patched(VERDICT_MEASURE_PATCH)` with
 * `true` made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 * for change fixer-auto-fix, but there is no corresponding change command!
 * ```
 *
 * Seven other lifecycle fixtures failed the same way (the frozen-child one on
 * its `StartChildWorkflowExecutionInitiated` event): every history that took
 * an approved verdict reaches the guard. The guard was restored and all 25
 * replays re-ran green.
 */
const findingApprovedBeforeVerdictMeasurePath = fileURLToPath(
  new URL('../fixtures/histories/finding-approved-before-verdict-measure.bin', import.meta.url),
);

test('a lifecycle run approved before the measurement at the verdict replays straight to its auto-fix read', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingApprovedBeforeVerdictMeasurePath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/agent-readiness-verdict-measure-fixture--llms-txt',
  );
});

/**
 * A lifecycle run as `findingWorkflow` ran it before the `record-verdict`
 * Update (STW-636): parked at the verdict wait in a workflow task of its own,
 * a malformed `verdict` Signal dropped, parked again, a CLI approve by Signal
 * and its write, the measurement at the verdict (unmeasured), the auto-fix
 * read (off), and parked at `waiting-fix`. 61 events.
 *
 * New code adds the Update's handler, a try/catch around the write, and a
 * `wf.condition(wf.allHandlersFinished)` after it. None issues a command, so
 * the change carries no marker, and a run parked at the verdict wait takes an
 * Update from the first worker that has the handler. This fixture holds both
 * sides of the wait: the park before the verdict and the commands after it.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at 73fcdb1, the
 * worktree before its first edit) against the time-skipping server with mocked
 * activities, so it holds no real finding text.
 *
 * Probe (2026-11-20): replacing the new `await wf.condition(wf.allHandlersFinished)`
 * with `await wf.sleep('1 second')` made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 * for change verdict-measure, but there is no corresponding change command!
 * ```
 *
 * Ten other `findingWorkflow` fixtures failed with it, every one that takes a
 * verdict: the two verdict-only histories on their `WorkflowExecutionCompleted`
 * event, the lifecycle ones on their next marker or child start. The other 18
 * replays passed. The wait was restored and all 29 replays re-ran green.
 */
const findingParkedBeforeVerdictUpdatePath = fileURLToPath(
  new URL('../fixtures/histories/finding-parked-before-verdict-update.bin', import.meta.url),
);

test('a lifecycle run parked and approved before the verdict Update replays with the handler added', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingParkedBeforeVerdictUpdatePath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/agent-readiness-verdict-update-fixture--llms-txt',
  );
});

/**
 * A lifecycle run as `findingWorkflow` ran it before settings were read at use
 * (STW-645), started with `waitsForPerson: true` for an opportunity: a file
 * approval, the measurement at the verdict (no checks), the `fixer-auto-fix`
 * marker and `readSiteAutoFix` (on), and the run parked at `waiting-fix` in a
 * workflow task that issued no command, because the input said so. Then a
 * `fix` signal from the reconciler, the `fix-dispatch` marker, a slot the
 * activity granted, the `fixer-action-adapter` marker, `openFixIssue` refused
 * by the gate, and the run parked again with `fixAttempts` 1. 65 events. It is
 * the shape of a run the 2026-10-23 to 2026-11-07 starts left parked for an
 * hour after its verdict.
 *
 * New code reads `readFindingSettings` right after an approved verdict and
 * never reads `waitsForPerson`, so this replays only because
 * `settings-at-use` sends a history without the marker down the path it took:
 * the measure marker, the flag read, and the park from the input. The signal
 * after the park is what gives an early command something to collide with.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at 7275b56, the
 * worktree before its first edit). The steps, as a script run once from
 * `agents/steward` with `node --import tsx --import ./tests/helpers/no-real-credentials.ts`:
 *
 * 1. `createTestEnv()`, a plain `Client` on its connection, and one worker on
 *    `steward-findings` with `workflowBundle()` and six mocked activities:
 *    `readFinding` (a two-line stand-in file), `readVerifyBlock` (no block),
 *    `writeFindingVerdictMeasure` (no commit), `readSiteAutoFix` (true),
 *    `requestFixSlot` (`{ paths: [], dispatched: false }`) and `openFixIssue`
 *    (a non-retryable `FindingNotFixable`).
 * 2. Start `findingWorkflow` as the ID below with `stopAfter: 'resolved'`, the
 *    handoff path, the branch, the origin and `waitsForPerson: true`.
 * 3. Wait for `waiting-verdict`; signal `verdict` (approved, source `file`).
 * 4. Wait for `waiting-fix` with `waitsForPerson` true and `fixAttempts` 0,
 *    then half a second more, so the park closes its workflow task.
 * 5. Signal `fix` (source `reconcile`); wait for `waiting-fix` with
 *    `fixAttempts` 1 and a `lastFixError`.
 * 6. `fetchHistory()`, written with `History.encode(...).finish()`. It holds
 *    no real finding text.
 *
 * Probes (2026-11-21), each reverted and re-run green:
 *
 * 1. Replacing `wf.patched(SETTINGS_AT_USE_PATCH)` with `true`, so a replayed
 *    approval reads its settings, made this replay fail with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 *    for change verdict-measure, but there is no corresponding change command!
 *    ```
 *
 *    Ten other `findingWorkflow` fixtures failed with it, every one that takes
 *    an approved verdict: `finding-verdict-cli.json`, the approval that stops
 *    at the verdict, on its `WorkflowExecutionCompleted` event (`Activity
 *    machine does not handle this event`), the frozen-child one on its child
 *    start, and the lifecycle ones on their next marker. So that fixture is the
 *    guard that the read does not fire on a replayed verdict-stop history. The
 *    other 21 replays passed.
 * 2. Replacing `input.waitsForPerson === true && fixAttempts === 0` with
 *    `false` in the wait of a history without the marker, which is the rescue
 *    applied to a run already parked, made this replay alone fail with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 *    for change fix-dispatch, but there is no corresponding change command!
 *    ```
 *
 *    The other 31 replays passed: no other fixture has the field in its input.
 *    A run parked this way stays parked until a `fix` signal reaches it.
 */
const findingWaitsForPersonParkedPath = fileURLToPath(
  new URL('../fixtures/histories/finding-waits-for-person-parked-pre.bin', import.meta.url),
);

test('a lifecycle run parked by waitsForPerson before settings were read at use replays its park and its signalled attempt', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingWaitsForPersonParkedPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/opportunity-waits-for-person-fixture--steward',
  );
});

/**
 * A lifecycle run on the code that reads its settings at use (STW-645): a file
 * approval, the `settings-at-use` marker and `readFindingSettings` (the stop
 * point), the measurement at the verdict (no checks), `readFindingSettings`
 * again (the gate refuses), the park behind a one-day timer, the timer firing,
 * a third read (the gate accepts), a slot the activity granted, the issue, a
 * PR wait that fails, and the run parked at `waiting-fix` with its issue. 79
 * events. The input carries `waitsForPerson: true`, which this path never reads.
 *
 * No history from before this change can hold these commands, so this is not
 * a pre-change fixture: it was recorded from the changed code (the worktree on
 * 7275b56 with this change applied) and guards the next change to the path.
 * The steps are those of `finding-waits-for-person-parked-pre.bin` above, with
 * `readFindingSettings` mocked (a site that fixes findings, `auto_fix` on, an
 * opportunity, a refusal until the park is seen and none after), `openFixIssue`
 * opening an issue and `awaitFixPr` failing non-retryably, and one
 * `env.sleep('25 hours')` in place of the `fix` signal.
 *
 * Probes (2026-11-21), each reverted and re-run green:
 *
 * 1. A `wf.sleep('1 second')` injected before the `readFindingSettings` of the
 *    fix wait made this replay alone fail with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Timer machine does not handle this
 *    event: HistoryEvent(id: 41, ActivityTaskScheduled)
 *    ```
 *
 * 2. Replacing `wf.patched(SETTINGS_AT_USE_PATCH)` with `false` made this
 *    replay alone fail with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 *    for change settings-at-use, but there is no corresponding change command!
 *    ```
 *
 * The other 32 replays passed both times.
 */
const findingSettingsAtUsePath = fileURLToPath(
  new URL('../fixtures/histories/finding-settings-at-use.bin', import.meta.url),
);

test('a lifecycle run that read its settings at use replays its park, its daily re-read and its attempt', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingSettingsAtUsePath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/opportunity-settings-at-use-fixture--steward',
  );
});

/**
 * A lifecycle run that read its settings at use and parked at `waiting-fix`
 * with an issue, before such a run read its file again: a file approval, the
 * settings and the measurement, an attempt whose issue 101 got no PR, the park,
 * a `fix` signal, a second attempt whose issue 102 got no PR, and the park
 * again. 87 events.
 *
 * "Got no PR" here is the mocked `awaitFixPr` failing at once with a
 * non-retryable `NoPr` (`RETRY_STATE_NON_RETRYABLE_FAILURE`), not the wait
 * running out its 60 minutes. So this history never reaches the
 * `fixer-reopen` marker (STW-704), which is read only after a bound, and it
 * does not guard that path: `finding-pr-bound-parked-pre.bin` below does. Between the first park and the `fix` signal the history
 * holds no timer and no read. New code waits there behind a one-day timer and
 * reads the file, so this replays only because the `parked-issue-reread` patch
 * sends a history without the marker down the plain wait for `fix`.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at b262bd4, the
 * worktree before its first edit) against the time-skipping server with
 * mocked activities, so it holds no real finding text.
 *
 * Probes (2026-11-22), each reverted and re-run green:
 *
 * 1. A `wf.sleep('1 second')` injected before the plain wait for `fix` made
 *    this replay alone fail with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Timer machine does not handle this
 *    event: HistoryEvent(id: 67, ActivityTaskScheduled)
 *    ```
 *
 * 2. Deleting the `wf.patched(PARKED_ISSUE_REREAD_PATCH)` guard, so every park
 *    with an issue takes the daily read, left this replay green. The read's
 *    timer is started at the park and cancelled by the `fix` signal in the next
 *    workflow task, before any event of the history has to match it, and the
 *    replayer lets such a timer go. So this fixture guards the plain wait, and
 *    it does not prove the marker is needed for a park that ends with `fix`.
 *    The marker stays: the read adds a command at the park, and determinism
 *    rule 4 does not rest on what the replayer happens to let pass.
 *    `finding-parked-issue-reread.bin` below is the fixture that fails without
 *    the guard's other side.
 */
const findingParkedWithIssuePath = fileURLToPath(
  new URL('../fixtures/histories/finding-parked-with-issue-pre.bin', import.meta.url),
);

test('a lifecycle run parked with an issue before the daily read replays its plain wait for fix', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingParkedWithIssuePath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/defect-parked-with-issue-fixture--steward',
  );
});

/**
 * A lifecycle run parked at `waiting-fix` with an issue on the code that reads
 * its file there: the first attempt's issue got no PR, the park records the
 * `parked-issue-reread` marker and a one-day timer, the read finds the file
 * still approved, a second timer, a read that finds it `resolved`, and the run
 * ends `closed`. 87 events. Its first attempt's "no PR" is a non-retryable
 * `NoPr`, as in the fixture above, not a bound, so it does not reach the
 * `fixer-reopen` marker either (STW-704).
 *
 * No history from before this change can hold these commands, so this is not a
 * pre-change fixture: it was recorded from the changed code (the worktree on
 * b262bd4 with this change applied) and guards the next change to the path.
 * The steps are those of `finding-parked-with-issue-pre.bin` above, with one
 * `env.sleep('25 hours')` and a time-skipping `result()` in place of the `fix`
 * signal.
 *
 * Probes (2026-11-22), each reverted and re-run green:
 *
 * 1. Replacing `wf.patched(PARKED_ISSUE_REREAD_PATCH)` with `false` made this
 *    replay alone fail with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 *    for change parked-issue-reread, but there is no corresponding change command!
 *    ```
 *
 * 2. A `wf.sleep('1 second')` injected before the daily `readFindingSettings`
 *    made this replay alone fail with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Timer machine does not handle this
 *    event: HistoryEvent(id: 70, ActivityTaskScheduled)
 *    ```
 *
 * The other 36 replays passed both times.
 */
const findingParkedIssueRereadPath = fileURLToPath(
  new URL('../fixtures/histories/finding-parked-issue-reread.bin', import.meta.url),
);

test('a lifecycle run parked with an issue replays its daily read and its close', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingParkedIssueRereadPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/defect-parked-issue-reread-fixture--steward',
  );
});

/**
 * A lifecycle run whose PR wait ran out its 60 minutes before the look at the
 * bound existed (STW-704): an approval and a `fix`, the settings and the
 * measurement, issue 101, 60 minutes of `FixPrNotOpen` ending in
 * `ActivityTaskFailed` with `RETRY_STATE_TIMEOUT` (event 66), the park at
 * `waiting-fix` with the `parked-issue-reread` marker and its one-day timer, a
 * `fix`, issue 102 and its PR, and the rest of the lifecycle to the verify
 * child, and its `done`. 160 events. It is the first fixture to hold a real bound of the PR
 * wait: `finding-parked-with-issue-pre.bin` and
 * `finding-parked-issue-reread.bin` record a non-retryable `NoPr` there.
 *
 * New code looks for a PR at the bound (`findFixPr`) and opens the issue again
 * by itself. This replays only because the `fixer-reopen` patch sends a
 * history without the marker down the old catch to the park.
 *
 * Recorded from the pre-change `finding.ts` (origin/master at d68ba19, the
 * worktree before its first edit) against the time-skipping server with the
 * mocked activities of `finding-lifecycle.test.ts`: one `env.sleep('61
 * minutes')`, then a `fix`. It holds no real finding text. Every identity field
 * reads `steward-fixture` and the two stack traces are emptied, as they held
 * the recording machine's name and local paths.
 *
 * Probe (2026-11-26), reverted and re-run green: deleting the
 * `wf.patched(FIXER_REOPEN_PATCH)` guard, so every bound takes the look, made
 * this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 * for change parked-issue-reread, but there is no corresponding change command!
 * ```
 *
 * The code scheduled `findFixPr` where the history holds the park's marker.
 * `finding-pr-bound-reopen.bin` below failed too, for its own marker; the other
 * 56 replays passed.
 */
const findingPrBoundParkedPath = fileURLToPath(new URL('../fixtures/histories/finding-pr-bound-parked-pre.bin', import.meta.url));

test('a lifecycle run whose PR wait ran out before the look replays its park and a person\'s fix', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingPrBoundParkedPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/defect-pr-bound-parked-fixture--steward',
  );
});

/**
 * A lifecycle run past the `fixer-reopen` marker (STW-704): issue 101's PR
 * wait runs out, the marker and the look (`findFixPr`) find nothing, the
 * second attempt opens issue 102 with no `fix`, closing 101 with its reason,
 * and a PR from issue 101 opens during 102's wait and is taken. The rest of
 * the lifecycle runs to the verify child.
 *
 * No history from before this change can hold these commands, so this is not a
 * pre-change fixture: it was recorded from the changed code and guards the next
 * change to the path. The steps are the lifecycle test "a PR from the first
 * issue that opens during the second wait is the fix". 157 events. Every
 * identity field reads `steward-fixture` and the two stack traces are emptied,
 * as they held the recording machine's name and local paths.
 *
 * Probes (2026-11-26), each reverted and re-run green:
 *
 * 1. Deleting the `wf.patched(FIXER_REOPEN_PATCH)` guard made this replay fail
 *    with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered
 *    for change fixer-reopen, but there is no corresponding change command!
 *    ```
 *
 * 2. A `wf.sleep('1 second')` injected before the look made this replay alone
 *    fail with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Timer machine does not handle this
 *    event: HistoryEvent(id: 72, ActivityTaskScheduled)
 *    ```
 *
 *    The other 57 replays passed.
 */
const findingPrBoundReopenPath = fileURLToPath(new URL('../fixtures/histories/finding-pr-bound-reopen.bin', import.meta.url));

test('a lifecycle run replays its look at the PR bound, the issue opened again and a late PR from the first issue', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingPrBoundReopenPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/defect-pr-bound-reopen-fixture--steward',
  );
});

/**
 * A dispatcher run as `fixDispatchWorkflow` ran it on `master` at 4d4d4ee: two
 * findings that name `src/shared.ts`. The first request is granted at once. The
 * second waits behind it. The holder releases, the dispatcher grants the
 * waiter, and the waiter releases. 39 events, ending on the open idle timer.
 * `fixDispatchWorkflow` has no `patched` marker, so this is the guard for the
 * next change to its loop: any command added before, between or after the
 * request, grant and release steps strands a dispatcher that is open now.
 *
 * Recorded from current `master` (4d4d4ee), not a pre-change commit, because no
 * command changes here. It is the first fixture to hold the dispatcher at all.
 * The recording is the first test of `fix-dispatch.test.ts`, two real
 * `findingWorkflow` runs and the real dispatcher on one time-skipping server
 * with that file's mocked activities, read with `fetchHistory()` on
 * `dispatch/seq-site`. Stored as protobuf binary for the reason the fix-child
 * fixtures give. The finding keys are the test's, so it holds no real finding
 * text.
 *
 * Probe (2026-11-07): a `wf.sleep('1 second')` injected in `grant`, before the
 * `slot-grant` signal to the asking run, made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 6, SignalExternalWorkflowExecutionInitiated)
 * ```
 *
 * The other 21 replays stayed green. The sleep was removed and all 22 re-ran green.
 */
const dispatchGrantAfterReleasePath = fileURLToPath(
  new URL('../fixtures/histories/fix-dispatch-grant-after-release.bin', import.meta.url),
);

test('a dispatcher that granted a waiter after the holder released replays that grant', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(dispatchGrantAfterReleasePath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'dispatch/seq-site',
  );
});

/**
 * A review run as `reviewPost` ran it on `master` at 4d4d4ee, through the
 * publish leg: the five-way fan-out, `awaiting_verdict`, then `approve` with
 * `publish: true`, `publishPost`, a first `verifyDeploy` that fails, the PR
 * check read (`checkPrChecks`, pending), a 90-second timer, a second
 * `verifyDeploy` that passes, the final archive and completion. 95 events. The
 * `publish` flag rides on the signal (determinism rule 2), so the other review
 * fixtures, whose `approve` carries none, never reach `publishPost`.
 *
 * Recorded from current `master` (4d4d4ee) against the time-skipping server
 * with the mocked activities of `review-post.test.ts`, `verifyDeploy` failing
 * once, read with `fetchHistory()`. It holds no real post: the draft is that
 * suite's `fixture-post`. Stored as protobuf binary for the reason the fix-child
 * fixtures give.
 *
 * Probe (2026-11-07): a `wf.sleep('1 second')` injected before the
 * `publishPost` call made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 54, ActivityTaskScheduled)
 * ```
 *
 * The other 21 replays stayed green. The sleep was removed and all 22 re-ran green.
 */
const reviewPublishVerifyPath = fileURLToPath(
  new URL('../fixtures/histories/review-post-publish-verify.bin', import.meta.url),
);

test('a review approved with publish replays publishPost and the deploy verification', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(reviewPublishVerifyPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'wf-publish-fixture',
  );
});

/**
 * ## Three scorecard histories from before STW-614 (2026-11-15)
 *
 * Recorded from `origin/master` at f34f790, the code before the nightly publish,
 * the archive file in the run's pull request and the held unhealthy run. Each
 * ran against the time-skipping server with mocked activities, two pages, and
 * was read with `fetchHistory()`, so none holds a real run. Stored as protobuf
 * binary for the reason the fix-child fixtures give.
 *
 * - `scorecard-nightly-merged-pre.bin`: a scheduled run, healthy, Performance
 *   90 to 100. `checkActionUsage`, the fan-out, `publishScorecardRun`,
 *   `archiveScorecardRun`, the `nightly-scorecard` ping, the
 *   `scorecard-auto-merge` marker, two check reads a timer apart, and
 *   `mergeScorecardPr`. 84 events. It is the first committed history that passes
 *   through the merge leg and the first started as a scheduled run.
 * - `scorecard-nightly-noop-pre.bin`: a scheduled run, healthy and unchanged. It
 *   decided `no-op`, archived, pinged and completed, with no publish. 53 events.
 * - `scorecard-unhealthy-merged-pre.bin`: a manual run with one of two pages
 *   failed. It published, archived, sent a failing `run-shape` ping and then
 *   merged, which is what the code of that day did. 78 events.
 *
 * **Probes on the recording code (2026-11-15).** A `wf.sleep('1 second')`
 * injected at the head of `mergeRunLogPr` failed the first and third with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 61, ActivityTaskScheduled)
 * ```
 *
 * (event 55 in the third) and left the no-op history green. A `wf.sleep('1 second')` injected before
 * the `archiveScorecardRun` call failed all three; the no-op history with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 41, ActivityTaskScheduled)
 * ```
 *
 * Both sleeps were removed and every replay re-ran green.
 *
 * **Probes on the changed code (2026-11-15), one marker at a time**, each with
 * that marker's `wf.patched()` call replaced by `true`:
 *
 * - `scorecard-nightly-publish`: the no-op history failed, alone, with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'archiveScorecardRun' does not match activity type of activity command
 * 'publishScorecardRun'
 * ```
 *
 * - `scorecard-hold-unhealthy`: the unhealthy history failed, alone, with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered for
 * change scorecard-auto-merge, but there is no corresponding change command!
 * ```
 *
 * - `scorecard-archive-in-pr`: the nightly-merged and unhealthy histories
 *   failed with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'archiveScorecardRun' does not match activity type of activity command
 * 'reportRunHealth'
 * ```
 *
 *   and the three older publishing histories (`scorecard-publish-pre-merge.bin`,
 *   `scorecard-performance-recheck-pre.bin`, `scorecard-mixed-lighthouse-pre.bin`)
 *   failed with `Complete workflow machine does not handle this event:
 *   HistoryEvent(id: 35 or 41, ActivityTaskScheduled)`. The other 23 replays
 *   stayed green.
 *
 * Each guard was restored and all 28 replays re-ran green. The workflow reads
 * whether the archive rode in the pull request off the publish result's
 * `committed`, not off the new `archivePath` field, so that an old result
 * cannot stand in for the marker: an earlier draft read `archivePath`, and with
 * the guard deleted every history still passed.
 */
const scorecardNightlyMergedPath = fileURLToPath(
  new URL('../fixtures/histories/scorecard-nightly-merged-pre.bin', import.meta.url),
);
const scorecardNightlyNoopPath = fileURLToPath(
  new URL('../fixtures/histories/scorecard-nightly-noop-pre.bin', import.meta.url),
);
const scorecardUnhealthyMergedPath = fileURLToPath(
  new URL('../fixtures/histories/scorecard-unhealthy-merged-pre.bin', import.meta.url),
);

test('a scheduled scorecard run that archived separately and merged replays through the merge leg', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(scorecardNightlyMergedPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'steward-scorecard-fixture-nightly-merged',
  );
});

test('a scheduled scorecard run that was a no-op replays with no publish', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(scorecardNightlyNoopPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'steward-scorecard-fixture-nightly-noop',
  );
});

test('a scorecard run with a failed page that merged replays through the merge leg', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(scorecardUnhealthyMergedPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'steward-scorecard-fixture-unhealthy-merged',
  );
});

/**
 * Two histories from before `runFindingChecks` had a heartbeat timeout, when
 * its stubs in `verifyFindingWorkflow` and `recheckFindingsWorkflow` set a
 * start-to-close timeout alone.
 *
 * - `verify-finding-checks-pre-heartbeat.bin`: the verify's checks path, read,
 *   PR, block, `runFindingChecks`, `writeFindingVerification`, resolved. 35
 *   events.
 * - `recheck-findings-pre-heartbeat.bin`: one recheck of nine approved
 *   findings, five of them measured with `runFindingChecks`, one of those
 *   failing unmeasured. 131 events.
 *
 * Both replay with no `patched` marker. The new stubs add `heartbeatTimeout`
 * to the same `ScheduleActivityTask` command, at the same place in the same
 * order, and the replay does not compare an activity's timeouts with the
 * recorded ones: these two green replays are the evidence, as
 * `finding-verify-child-heavy.bin` is for retry attributes.
 *
 * Recorded from the pre-change code (origin/master at 73fcdb1, the worktree
 * before its first edit) against the time-skipping server with mocked
 * activities and a fake GitHub, so neither holds real finding text.
 *
 * Probe (2026-11-20): `await wf.sleep('1 second')` before
 * `checking.runFindingChecks` in each workflow made its fixture fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 23, ActivityTaskScheduled)
 * ```
 *
 * for the verify and
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 29, ActivityTaskScheduled)
 * ```
 *
 * for the recheck, and left the other 28 replays green. The sleeps were
 * removed and all 30 re-ran green.
 */
const verifyChecksPreHeartbeatPath = fileURLToPath(
  new URL('../fixtures/histories/verify-finding-checks-pre-heartbeat.bin', import.meta.url),
);
const recheckPreHeartbeatPath = fileURLToPath(new URL('../fixtures/histories/recheck-findings-pre-heartbeat.bin', import.meta.url));

test('a verify that ran its checks before the heartbeat timeout replays with it', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(verifyChecksPreHeartbeatPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'verify/mattpyle-com/content-perfect-score-labelled-fail--scorecard/2026-10-13T041233Z-0',
  );
});

test('a recheck that ran its checks before the heartbeat timeout replays with it', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(recheckPreHeartbeatPath));
  await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, 'recheck/temporal-io/test');
});

/**
 * Four closed lifecycle runs, one for each ending after the merge that left the
 * finding undecided before STW-653 (`open-until-verified`):
 *
 * - `finding-reopened-pre.bin`: merged, live, and the verify child's check
 *   failed: the run ended `reopened`. 131 events.
 * - `finding-verify-failed-pre.bin`: merged, live, and the verify child threw
 *   `VerifyCheckBroken`: the run ended `verify-failed`. 131 events.
 * - `finding-merge-timeout-pre.bin`: a dispatched attempt whose PR passed its
 *   preview test and was never merged; the merge wait, raced against the
 *   `retest` Update, ran out its 30 days, the slot release was signalled, and
 *   the run ended `merge-timeout`. 125 events.
 * - `finding-deploy-timeout-pre.bin`: a dispatched attempt, merged, whose
 *   deploy wait ran out its 24 hours; the release was signalled and the run
 *   ended `deploy-timeout`. 131 events.
 *
 * Each history is closed, and a closed history is still replayed: a query on a
 * closed run (`steward finding status` reads the state of one) replays it from
 * the start. The run's completion shares a workflow task with the event that
 * ended it, so no open run holds these endings; the closed ones are what new
 * code must replay.
 *
 * Recorded from the pre-change code (origin/master at f390896, the worktree
 * before its first edit) against the time-skipping server, with every activity
 * mocked by a one-off script run from `agents/steward` with
 * `node --import tsx --import ./tests/helpers/no-real-credentials.ts`: one
 * worker on `steward-findings` with `workflowBundle()` and
 * `skipVerdictMeasure` over mocks of the lifecycle's activities; a start with
 * `stopAfter: 'resolved'`, a `verdict` Signal (approved, source `cli`) and a
 * `fix` Signal; for the two timeouts `requestFixSlot` answered
 * `dispatched: true` and the script sent `slot-grant` with ticket 1 once the
 * run reported `waiting-slot`; then the run's result through the time-skipping
 * client and `fetchHistory()`, written with `History.encode(...).finish()`.
 * They hold no real finding text.
 */
const preOpenUntilVerified = ['reopened', 'verify-failed', 'merge-timeout', 'deploy-timeout'].map((ending) => ({
  ending,
  path: fileURLToPath(new URL(`../fixtures/histories/finding-${ending}-pre.bin`, import.meta.url)),
}));

for (const { ending, path } of preOpenUntilVerified) {
  test(`a lifecycle run that ended ${ending} before STW-653 still replays to that ending`, { timeout: 120_000 }, async () => {
    const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(path));
    await Worker.runReplayHistory(
      { workflowBundle: await workflowBundle() },
      history,
      'finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
    );
  });
}

/**
 * Four histories recorded on the STW-653 code, one for each new path, so a
 * later change to them strands nothing silently:
 *
 * - `finding-park-resume-resolved.bin`: a check failed on production; the run
 *   recorded `open-until-verified`, posted one PR comment and parked at
 *   `verify`; a `resume` Update ran the child again, which failed the same way
 *   and parked again with no second comment; a second `resume` passed and the
 *   run ended `resolved`. 177 events.
 * - `finding-park-request-fix.bin`: the child failed with `VerifyCheckBroken`,
 *   the run parked as `checks-broken`, and a `request-fix` Update started a
 *   second attempt in the same run, which merged, deployed and resolved.
 *   224 events.
 * - `finding-merge-rewait.bin`: an open run whose merge wait ran out its 30
 *   days; it signalled its release, recorded the marker, set its memo, posted
 *   one comment, and scheduled the unbounded re-wait, still pending. 123
 *   events.
 * - `verify-finding-slow-phase.bin`: a verify child with `slowRetry` whose
 *   `readFixPr` met a rejected credential and whose `runFindingChecks` used up
 *   its three fast attempts on a 503; each was run again in the slow phase and
 *   the child resolved. 47 events.
 *
 * Recorded with the lifecycle suite's own mocks (`finding-lifecycle.test.ts`,
 * the tests of the same names), each history written with
 * `History.encode(...).finish()` once the test had what it asserts. They hold
 * no real finding text.
 *
 * Probes (2026-11-22), each reverted and re-run green:
 *
 * 1. `await wf.sleep('1 second')` before `writing.commentOnFixPr` in
 *    `finding.ts` made the three `findingWorkflow` histories fail with
 *    `[TMPRL1100] Nondeterminism error`, and left the slow-phase child green.
 * 2. `await wf.sleep('1 second')` before the slow call in the child's
 *    `phases` made `verify-finding-slow-phase.bin` fail with
 *    `[TMPRL1100] Nondeterminism error`.
 * 3. Replacing every `wf.patched(OPEN_UNTIL_VERIFIED_PATCH)` with `true` made
 *    the four `*-pre.bin` histories above fail with `[TMPRL1100]
 *    Nondeterminism error: ModifyWorkflowPropertiesMachine does not handle
 *    HistoryEvent(id: 131, WorkflowExecutionCompleted)` (id 125 for the merge
 *    timeout), and left the other 37 replays green. Re-run on 2026-11-23 with
 *    `finding-returned-failed-pre.bin` added: those five failed, the three
 *    `findingWorkflow` histories above failed too (they hold the marker, which
 *    the probe no longer records), and the other 38 passed.
 *
 * These two histories and four others also guard the fix log confirmation
 * (STW-712, `FIX_LOG_CONFIRM_PATCH` in `finding.ts`): each reaches a verify
 * answer on the issue path with no confirmation after it. Probe (2026-11-27),
 * reverted and re-run green (59 of 59): dropping `wf.patched(FIX_LOG_CONFIRM_PATCH)`
 * from the step's condition made six fail with `[TMPRL1100]`:
 * `finding-verify-child-heavy.bin`, `finding-pr-bound-parked-pre.bin`,
 * `finding-pr-bound-reopen.bin`, `finding-reopened-pre.bin` and the two above.
 * Five read "Activity machine does not handle this event:
 * HistoryEvent(..., WorkflowExecutionCompleted)", where the new code scheduled
 * `openFixLogConfirmation`; the sixth, whose history records
 * `open-until-verified` right after the verify answer, read "Non-deprecated
 * patch marker encountered for change open-until-verified". The other 53
 * stayed green.
 */
const openUntilVerified = [
  { file: 'finding-park-resume-resolved.bin', id: 'finding/mattpyle-com/lifecycle-reopened', what: 'a run parked at verify, resumed twice and resolved' },
  { file: 'finding-park-request-fix.bin', id: 'finding/mattpyle-com/lifecycle-broken', what: 'a run parked on a broken check that took a second attempt' },
  { file: 'finding-merge-rewait.bin', id: 'finding/mattpyle-com/lifecycle-merge-timeout', what: 'a run waiting on its merge past 30 days' },
  { file: 'verify-finding-slow-phase.bin', id: 'verify/mattpyle-com/content-perfect-score-labelled-fail--scorecard/slow', what: 'a verify child that took its slow phase' },
];

for (const { file, id, what } of openUntilVerified) {
  test(`${what} replays`, { timeout: 120_000 }, async () => {
    const history = proto.temporal.api.history.v1.History.decode(
      await fs.readFile(fileURLToPath(new URL(`../fixtures/histories/${file}`, import.meta.url))),
    );
    await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, id);
  });
}

/**
 * A closed run that FAILED on the code before STW-653:
 * `finding-returned-failed-pre.bin`. Its PR closed unmerged, and
 * `writeFindingReturned` failed non-retryably (`FindingMissing`); the rethrown
 * `ActivityFailure` failed the execution. 96 events, the last
 * `WorkflowExecutionFailed`. New code reaches `patched(OPEN_UNTIL_VERIFIED_PATCH)`
 * there, which a history without the marker answers false, so the run rethrows
 * as before. It stands for the other closed failures that now pass a
 * `patched()` call (a merge or deploy wait's own failure).
 *
 * Recorded from the workflow code of f390896 (the three workflow files checked
 * out over the branch, then restored) by a one-off script like the one above:
 * `skipVerdictMeasure` over mocks, a `verdict` and a `fix` Signal, a merge
 * wait that answered `closed`, and the returned write throwing.
 *
 * Probe (2026-11-23): replacing every `wf.patched(OPEN_UNTIL_VERIFIED_PATCH)`
 * with `true` made it fail with `[TMPRL1100] Nondeterminism error`; reverted
 * and re-run green.
 */
test('a lifecycle run that FAILED on its returned write before STW-653 still replays to that failure', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(
    await fs.readFile(fileURLToPath(new URL('../fixtures/histories/finding-returned-failed-pre.bin', import.meta.url))),
  );
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});

/**
 * A run on the settings-at-use path that ends at its verdict, started with the
 * verdict in its input: `finding-watch-stop-pre.bin`. Site `temporal-io`, an
 * identity-only input with an approved `file` verdict, so the run skips the
 * gate's wait, writes nothing, takes the `settings-at-use` marker, reads
 * `readFindingSettings` (a site that stops at the verdict, recorded without a
 * `watch` field) and completes with the verdict. 13 events.
 *
 * Recorded from the code before stage 4 (origin/master at 93f64b2, before the
 * worktree's first edit) against the time-skipping server with mocked
 * activities, by a one-off script: `client.workflow.start`, then
 * `fetchHistory()`, written with `History.encode(...).finish()`. It covers two
 * branches the matrix listed as uncovered: a run started with a verdict in its
 * input, and a site that stops at the verdict on the settings-at-use path. It
 * is the path every closed temporal.io run took, and the stage 4 change reads
 * `watch` from this same recorded result, so it must replay to the same
 * `return base`.
 *
 * Probe (2026-11-25), on the pre-change code: a `wf.sleep('1 second')`
 * injected before the `readFindingSettings` of the verdict made this replay
 * fail with
 *
 *    ```
 *    [TMPRL1100] Nondeterminism error: Timer machine does not handle this
 *    event: HistoryEvent(id: 7, ActivityTaskScheduled)
 *    ```
 *
 * Reverted and re-run green.
 */
test('a run started with its verdict on a site that stops at the verdict replays to its end', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(
    await fs.readFile(fileURLToPath(new URL('../fixtures/histories/finding-watch-stop-pre.bin', import.meta.url))),
  );
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/temporal-io/watch-fixture--sitewide',
  );
});

/**
 * Stage 4: a run that watches production, `finding-watching.bin`. Site
 * `temporal-io`, started with an approved `file` verdict in its input (the
 * path Argus starts its approved lines on), the `settings-at-use` marker,
 * `readFindingSettings` answering `watch: true`, and `watchFinding`
 * scheduled on `steward-findings-watch`. Its first attempt failed
 * `StillPresent` with a delay of a day, so the history ends at the pending
 * activity's `ActivityTaskScheduled`: a retry is not a history event. 13
 * events. The run was terminated after the history was read.
 *
 * `finding-watch-resolved.bin` is the same start with `watchFinding`
 * returning `resolved` on its first attempt, and the run completing
 * `resolved`. 19 events.
 *
 * Both were recorded from the changed code (this branch, before its first
 * commit of workflow code) against the time-skipping server with mocked
 * activities, by a one-off script: `client.workflow.start`, then
 * `fetchHistory()`, written with `History.encode(...).finish()`. No history
 * from before stage 4 can hold these commands, so they guard the next change
 * to the path.
 *
 * On 2026-11-26 (STW-696) the seven `identity` fields of
 * `finding-watching.bin` were rewritten to `steward-fixture`, in place of the
 * recording machine's name. Nothing else in the history changed, and the test
 * passed before and after.
 *
 * Probes (2026-11-25), each reverted and re-run green:
 *
 * 1. A `wf.sleep('1 second')` injected before the `watchFinding` call made
 *    both replays fail with `[TMPRL1100] Nondeterminism error: Timer machine
 *    does not handle this event: HistoryEvent(id: 13, ActivityTaskScheduled)`.
 * 2. Testing `settings.watch === false` in place of `=== true` made both fail
 *    with `[TMPRL1100] Nondeterminism error: Complete workflow machine does not
 *    handle this event: HistoryEvent(id: 13, ActivityTaskScheduled)`.
 */
test('a run watching production replays to its pending watch', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(
    await fs.readFile(fileURLToPath(new URL('../fixtures/histories/finding-watching.bin', import.meta.url))),
  );
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/temporal-io/watch-fixture-watching--sitewide',
  );
});

test('a run its own watch resolved replays to resolved', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(
    await fs.readFile(fileURLToPath(new URL('../fixtures/histories/finding-watch-resolved.bin', import.meta.url))),
  );
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'finding/temporal-io/watch-fixture-resolved--sitewide',
  );
});

/**
 * ## The watch loop's other paths (STW-696)
 *
 * Five histories of `watchProduction`, recorded before the loop is changed for
 * a look by Argus. Each is site `temporal-io`, started with an approved `file`
 * verdict, through the `settings-at-use` marker and a `readFindingSettings`
 * that answers `watch: true`, as `finding-watching.bin` is.
 *
 * 1. `finding-watch-measure-now.bin`: the first `watchFinding` fails
 *    `StillPresent`, a `measure-now` Update is accepted and answered, the
 *    pending attempt is cancelled, and `watchFinding` is scheduled again. The
 *    history ends at the second watch's pending attempt. 30 events.
 * 2. `finding-watch-rejected.bin`: a `rejected` `record-verdict` Update is
 *    accepted at `watching`, the watch is cancelled, `writeFindingVerdict`
 *    runs, the Update is answered, and the run completes `rejected`. 33 events.
 * 3. `finding-watch-reject-loses.bin`: the same-task tie. With no workflow
 *    worker running, the rejection's Update waited at the server while
 *    `watchFinding` completed `resolved`. One workflow task then held both.
 *    The SDK runs the Update handler before it resolves the activity, but the
 *    activity's promise wins the race before the loop's condition is checked.
 *    So the run writes nothing, answers the Update with a failure ("resolved
 *    before the rejection was written") and completes `resolved`, all in that
 *    one task. 24 events.
 * 4. `finding-watch-decided.bin`: `watchFinding` answers `decided` with the
 *    status `reopened`, and the run completes `closed`. 19 events.
 * 5. `finding-watch-bound.bin`: the first watch is held by its daily delay
 *    past the 30-day schedule-to-close bound, closes `ActivityTaskFailed` with
 *    retry state `TIMEOUT`, and `watchFinding` is scheduled again. The history
 *    ends at the second watch's pending attempt. 22 events.
 *
 * Recorded from origin/master at 9543640, with no change under `src/`, on the
 * time-skipping server with mocked activities, by a one-off script that is not
 * committed: `client.workflow.start`, the messages above, then
 * `fetchHistory()`, written with `History.encode(...).finish()`. Workflow
 * workers ran with `maxCachedWorkflows: 0`, so the tie's second worker got
 * the whole history. Every identity field reads `steward-fixture` and every
 * stack trace is empty. Histories 1 and 5 were read before the run was
 * terminated.
 *
 * Probes (2026-11-26, on 9543640), each reverted and re-run green. Each
 * failed its own fixture and left the other six watch fixtures green:
 *
 * 1. `await wf.sleep('1 second')` before the `continue` taken on `measure`
 *    failed `finding-watch-measure-now.bin` with `[TMPRL1100] Nondeterminism
 *    error: Timer machine does not handle this event: HistoryEvent(id: 24,
 *    ActivityTaskScheduled)`.
 * 2. `await wf.sleep('1 second')` before the watch's `writeFindingVerdict`
 *    failed `finding-watch-rejected.bin` with `[TMPRL1100] Nondeterminism
 *    error: Timer machine does not handle this event: HistoryEvent(id: 23,
 *    ActivityTaskScheduled)`.
 * 3. Taking the rejection branch whenever `rejection.verdict` is set, so the
 *    rejection wins the tie, failed `finding-watch-reject-loses.bin` with
 *    `[TMPRL1100] Nondeterminism error: Activity machine does not handle this
 *    event: HistoryEvent(id: 23, WorkflowExecutionUpdateCompleted)`.
 * 4. `await wf.sleep('1 second')` before the `finish` of the `decided` branch
 *    failed `finding-watch-decided.bin` with `[TMPRL1100] Nondeterminism
 *    error: Timer machine does not handle this event: HistoryEvent(id: 19,
 *    WorkflowExecutionCompleted)`.
 * 5. `await wf.sleep('1 second')` before the `continue` taken on `timeout`
 *    failed `finding-watch-bound.bin` with `[TMPRL1100] Nondeterminism error:
 *    Timer machine does not handle this event: HistoryEvent(id: 22,
 *    ActivityTaskScheduled)`.
 */
for (const [name, file, key] of [
  ['a watch issued again after measure-now replays to its second watch', 'finding-watch-measure-now.bin', 'watch-fixture-measure-now--sitewide'],
  ['a rejection written while it watches replays to rejected', 'finding-watch-rejected.bin', 'watch-fixture-rejected--sitewide'],
  ['a rejection that ties with a watch result replays to the result', 'finding-watch-reject-loses.bin', 'watch-fixture-reject-loses--sitewide'],
  ['a watch that answers decided replays to closed', 'finding-watch-decided.bin', 'watch-fixture-decided--sitewide'],
  ['a watch issued again at its 30-day bound replays to its second watch', 'finding-watch-bound.bin', 'watch-fixture-bound--sitewide'],
] as const) {
  test(name, { timeout: 120_000 }, async () => {
    const history = proto.temporal.api.history.v1.History.decode(
      await fs.readFile(fileURLToPath(new URL(`../fixtures/histories/${file}`, import.meta.url))),
    );
    await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, `finding/temporal-io/${key}`);
  });
}

/**
 * ## Argus's look (STW-697)
 *
 * `finding-watch-look.bin`: a run at `watching` whose first `watchFinding`
 * failed `StillPresent` takes a `record-look` Update (`result: fixed`, run
 * `2026-11-26T0830Z`). The Update is accepted, the pending watch is cancelled,
 * `writeFindingLook` runs on `steward-findings` and answers `by: look`, the
 * Update is answered, and the run completes `resolved`. 33 events: the look
 * accepted at 20, the watch's cancel at 21 and 22, the write scheduled at 23,
 * the Update completed at 32 and the run at 33.
 *
 * Recorded from the STW-697 branch on the time-skipping server with mocked
 * activities, by a one-off script that is not committed, as the STW-696
 * fixtures were: `client.workflow.start`, the Update, then `fetchHistory()`,
 * written with `History.encode(...).finish()`. Workflow workers ran with
 * `maxCachedWorkflows: 0`. Every identity field reads `steward-fixture` and
 * every stack trace is empty.
 *
 * No open run holds a `record-look` Update, so this fixture guards the look's
 * own path for the runs that take one after the deploy. The eight older
 * `finding-watch*.bin` replay unedited: the change adds no command to any of
 * their paths.
 *
 * Probe (2026-11-26, on the STW-697 branch): `await wf.sleep('1 second')` before the look's
 * `writeFindingLook` failed this fixture alone, of the 56 replay tests, with
 * `[TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 23, ActivityTaskScheduled)`. Reverted and re-run green.
 */
test("a look accepted while it watches replays to resolved", { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(
    await fs.readFile(fileURLToPath(new URL('../fixtures/histories/finding-watch-look.bin', import.meta.url))),
  );
  await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, 'finding/temporal-io/watch-fixture-look--sitewide');
});

/**
 * ## The recheck before it read a watch (STW-678)
 *
 * `recheck-findings-watch-pre.bin`: one recheck of four approved findings on a
 * site whose `config.yaml` already says `after_verdict: watch`, one with an
 * open run (`has an open run`), one still present, one with no checks and one
 * resolved, then the health ping. 71 events. Recorded from origin/master at
 * b9023e0, before the recheck's first edit, against the time-skipping server
 * with mocked activities and a fake GitHub, so it holds no real finding text.
 *
 * Its recorded `readSiteHosts` result has no `watch` field, so it must take the
 * path that lists the open runs and measures, whatever the config says.
 *
 * Probe (2026-11-25, on b9023e0): `await wf.sleep('1 second')` before
 * `reading.listOpenFindingWorkflows` made it fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 17, ActivityTaskScheduled)
 * ```
 *
 * The sleep was removed and it re-ran green.
 *
 * Second probe, on the change's code: reading an absent `watch` as true
 * (`watch !== false`) made it and `recheck-findings-pre-heartbeat.bin` fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'listOpenFindingWorkflows' does not match activity type of activity command
 * 'readWatchRun'
 * ```
 *
 * Reverted, and both re-ran green.
 *
 * ## The durable policy of both scheduled workflows (STW-680)
 *
 * The reads and writes of `recheckFindingsWorkflow` and the reads and merge leg
 * of `scorecardAuditWorkflow` got a longer retry policy and a schedule-to-close
 * timeout, with no `patched` marker. All three recheck fixtures and all seven
 * scorecard fixtures replay unedited.
 *
 * Probe (2026-11-26): `await wf.sleep('1 second')` before
 * `reading.readFindingsIndex` and before `light.reading.readPublishedScorecard`
 * made those ten, and no other replay, fail with `[TMPRL1100] Nondeterminism
 * error: Timer machine does not handle this event`. The sleeps were removed and
 * every replay re-ran green.
 */
const recheckWatchPrePath = fileURLToPath(new URL('../fixtures/histories/recheck-findings-watch-pre.bin', import.meta.url));

test('a recheck recorded before it read a watch replays with it', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(recheckWatchPrePath));
  await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, 'recheck/temporal-io/test');
});

/**
 * `recheck-findings-watching.bin`: one recheck on a watch site (STW-678), four
 * approved findings read by ID: `watching`, `watch stale`, one with no pending
 * `watchFinding` that waits for its second read and stays `not watching`, and
 * `no run` after a `readRecheckBlock`. 64 events, with the timer between the
 * reads. Recorded on the change's code against the time-skipping server with a
 * mocked `readWatchRun` and a fake GitHub.
 *
 * Probe (2026-11-25): `await wf.sleep('1 second')` before
 * `reading.readRecheckBlock` in `readWatches` made it fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 52, ActivityTaskScheduled)
 * ```
 *
 * The sleep was removed and it re-ran green.
 */
const recheckWatchingPath = fileURLToPath(new URL('../fixtures/histories/recheck-findings-watching.bin', import.meta.url));

test('a recheck of a watch site replays with the watch reads', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(recheckWatchingPath));
  await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, 'recheck/temporal-io/test');
});

/**
 * ## Writes that ran out of retries (STW-680)
 *
 * `finding-writes-exhausted-pre.bin`: an open run on the settings-at-use path
 * whose GitHub calls used up their bounded retries. The measurement's
 * `readFinding` failed three times, so the finding went unmeasured. Attempt 1:
 * `openFixIssue` failed five times. Attempt 2: `writeFindingFix` failed five
 * times. Attempt 3: the PR closed unmerged, `writeFindingReturned` failed five
 * times, and `slowWriting` wrote it. The run waits at `waiting-fix`. 159 events.
 *
 * Recorded from origin/master at 40890d7, before the durable retry policies,
 * on a dev server with mocked activities, so it holds no real finding text.
 * The failures' stack traces were then emptied, as they held local paths. Its
 * recorded failures say `MAXIMUM_ATTEMPTS_REACHED`, which today's policies no
 * longer produce for these writes, so every catch and `slowOrPark` must still
 * take the branch the history records.
 *
 * Probe (2026-11-25, on 40890d7): `await wf.sleep('1 second')` before
 * `writing.openFixIssue` made it fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 57, ActivityTaskScheduled)
 * ```
 *
 * The sleep was removed and it re-ran green.
 */
test('a run whose writes ran out of retries replays to its next fix wait', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(
    await fs.readFile(fileURLToPath(new URL('../fixtures/histories/finding-writes-exhausted-pre.bin', import.meta.url))),
  );
  await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, 'finding/mattpyle-com/writes-exhausted-fixture');
});

/**
 * ## A verdict write that failed the run (STW-689)
 *
 * `finding-verdict-write-failed-pre.bin`: a closed run whose gate verdict
 * write failed on a permanent type. An approved `record-verdict` Update was
 * accepted, `writeFindingVerdict` failed `AuthError` (retry state
 * `NON_RETRYABLE_FAILURE`), the Update was answered `VerdictWriteFailed`, and
 * the run FAILED. 16 events. `steward finding status` queries such a run, which
 * replays it, so the code must reach the same failure.
 *
 * Recorded from origin/master at c754f66, before the park at `verdict`, on a
 * dev server with mocked activities, so it holds no real finding text. The
 * failures' stack traces were emptied, and the worker identity's machine name
 * replaced, before it was written.
 *
 * Probe (2026-11-25, on c754f66): `await wf.sleep('1 second')` before the
 * gate's `writing.writeFindingVerdict` made it fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Timer machine does not handle this event:
 * HistoryEvent(id: 9, ActivityTaskScheduled)
 * ```
 *
 * The sleep was removed and it re-ran green.
 */
test('a run whose gate verdict write failed replays to its failure', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(
    await fs.readFile(fileURLToPath(new URL('../fixtures/histories/finding-verdict-write-failed-pre.bin', import.meta.url))),
  );
  await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, 'finding/mattpyle-com/gate-park-fixture-pre');
});

/**
 * ## The parks before the lifecycle (STW-689)
 *
 * `finding-verdict-parked.bin`: the gate's verdict write failed `AuthError`,
 * the Update was answered `VerdictWriteFailed`, and the run parked at stage
 * `verdict` with the `failure-parks` marker and one memo upsert. A `resume`
 * Update wrote the held verdict again, the settings read said the site stops at
 * the verdict, and the run completed. 39 events.
 *
 * `finding-settings-parked.bin`: the verdict was written, the settings read
 * after it failed `NotFound`, and the run parked at stage `settings`. A
 * `resume` read again, the read said the site stops at the verdict, and the run
 * completed. 39 events.
 *
 * Both recorded on this change, on a dev server with mocked activities; stack
 * traces emptied and the worker identity's machine name replaced.
 *
 * Probe (2026-11-25): reading `wf.patched(FAILURE_PARKS_PATCH)` as `false` at
 * every site failed both with `TMPRL1100`, and left
 * `finding-verdict-write-failed-pre.bin` green. Reverted, green.
 *
 * Probe (2026-11-26, STW-693): the park reasons' text changed at the three
 * sites that build one at `verdict` or `settings`, and both fixtures replayed
 * green, so replay does not compare the `waitsFor` memo's value. Control: with
 * the gate's memo upsert removed instead, both failed as nondeterministic.
 * Reverted, green. No fixture holds a park at `settings` in the lifecycle,
 * which upserts the same memo.
 */
test('a run parked at its verdict write replays through its resume', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(
    await fs.readFile(fileURLToPath(new URL('../fixtures/histories/finding-verdict-parked.bin', import.meta.url))),
  );
  await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, 'finding/mattpyle-com/gate-park-fixture-verdict-parked');
});

test('a run parked at its settings read replays through its resume', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(
    await fs.readFile(fileURLToPath(new URL('../fixtures/histories/finding-settings-parked.bin', import.meta.url))),
  );
  await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, 'finding/mattpyle-com/gate-park-fixture-settings-parked');
});
