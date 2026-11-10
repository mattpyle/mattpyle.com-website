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
 * | `scorecardAuditWorkflow` | `scorecard-dry-run.json`, `scorecard-performance-recheck-pre.bin`, `scorecard-mixed-lighthouse-pre.bin` | The scheduled path: `checkActionUsage` and the `nightly-scorecard` health signal. It needs a run started by the schedule, and none is recorded. The Performance re-check's extra `auditLiveUrl` calls and the mixed-Lighthouse refusal on current code (both fixtures predate their markers). A run that throws, and the audit-set guard. |
 * | `findingWorkflow` | `finding-verdict-cli.json`, `finding-verdict-file.json`, `finding-child-fix-returned.bin`, `finding-opportunity-auto-fix-attempt.bin`, `finding-pr-closed-before-dispatch.bin`, `finding-pr-closed-before-preview-test.bin`, `finding-verify-child-heavy.bin`, `finding-verify-unverifiable.bin` | A fix attempt the dispatcher holds: the `slot-grant` wait, the re-request after `SLOT_RESEND`, the release signal. The preview test (`testOnPreview`). The conflict close and re-cut. The merge-timeout, deploy-timeout and verify-failed endings. |
 * | `fixFindingWorkflow` (frozen) | `fix-finding-pr.bin`, `fix-finding-preview.bin` | The diff review (`reviewFixDiff`) on current code. A refusal (`FindingNotFixable`). A finding with no checks. |
 * | `verifyFindingWorkflow` | `verify-finding-blockless.bin` | The checks path (`runFindingChecks`, then `writeFindingVerification`, resolved or reopened). The blockless confirm by deploy (`readProductionDeploy`). The refusals (`FindingNotVerifiable`, `FixNotMerged`, `FixNotLive`). |
 * | `reconcileFindingsWorkflow` | `reconcile-parked-defect-pre.bin`, `reconcile-restart-approved-pre.bin`, `reconcile-close-parked-pre.bin` | All three markers on current code: `listFixableFindings`, the restart start and signal, the close cancel. A reconcile that throws (`reportRunHealth` before the rethrow). |
 * | `fixDispatchWorkflow` | `fix-dispatch-grant-after-release.bin` | The hourly sweep (`runningWorkflowIds`). A grant whose signal fails. A re-sent request for a held ticket. The idle close. The continue-as-new rollover is a test in `fix-dispatch.test.ts`, not a replay. |
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
 * A reconcile run as `reconcileFindingsWorkflow` ran it before the kind-blind
 * `fix` rule: one site, a parked approved defect on an `auto_fix` site (the
 * `readSiteAutoFix` read and the `fix` signal), a parked approved opportunity
 * (left alone) and a new proposed opportunity (one `startFindingWorkflow`). 46
 * events. New code reads the flag for any parked approved line and asks
 * `listFixableFindings` before it signals, so this replays only because the
 * `reconcile-fix-any-kind` patch sends a history without the marker down the
 * defect rule: `hasParkedDefect`, then `planReconcile` with no `fixable` set.
 *
 * Recorded from the pre-change `reconcile-findings.ts` (origin/master at
 * e983b03, the worktree before its first edit) against the time-skipping server
 * with mocked activities and real finding runs, so it holds no real finding
 * text.
 *
 * Probe (2026-11-03): replacing `wf.patched(RECONCILE_FIX_ANY_KIND_PATCH)` with
 * `true`, so every run takes the new rule, made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'startFindingWorkflow' does not match activity type of activity command
 * 'listFixableFindings'
 * ```
 *
 * The other 17 replays stayed green. The guard was restored and all 18 re-ran green.
 */
const reconcileParkedDefectPath = fileURLToPath(
  new URL('../fixtures/histories/reconcile-parked-defect-pre.bin', import.meta.url),
);

test('a reconcile run recorded before the kind-blind fix rule replays down the defect rule', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(reconcileParkedDefectPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'reconcile-fixture-3',
  );
});

/**
 * A reconcile run as `reconcileFindingsWorkflow` ran it before the restart of an
 * approved line with no open run: one site, an approved opportunity with no
 * run (left alone, with no flag read) and a new proposed defect (one
 * `startFindingWorkflow`). 37 events. New code reads the flag for an approved
 * line with no run, then asks `listFixableFindings`, before it starts anything,
 * so this replays only because the `reconcile-restart-approved` patch sends a
 * history without the marker down the old candidates: `fixCandidates` alone.
 *
 * Recorded from the pre-change `reconcile-findings.ts` (origin/master at
 * 7ea21e5, the worktree before its first edit) against the time-skipping server
 * with mocked activities, so it holds no real finding text.
 *
 * Probe (2026-11-06): replacing `wf.patched(RECONCILE_RESTART_APPROVED_PATCH)` with
 * `true`, so every run takes the restart path, made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Activity type of scheduled event
 * 'startFindingWorkflow' does not match activity type of activity command
 * 'readSiteAutoFix'
 * ```
 *
 * The other 18 replays stayed green. The guard was restored and all 19 replays re-ran green.
 */
const reconcileRestartApprovedPath = fileURLToPath(
  new URL('../fixtures/histories/reconcile-restart-approved-pre.bin', import.meta.url),
);

test('a reconcile run recorded before the restart rule replays without a restart', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(reconcileRestartApprovedPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'reconcile-fixture-4',
  );
});

/**
 * A reconcile run as `reconcileFindingsWorkflow` ran it before the close of a
 * parked run: one site, a `resolved` direction line whose run waits at
 * `waiting-fix` (left alone) and a new proposed defect (one
 * `startFindingWorkflow`). 39 events. New code cancels the parked run of a
 * resolved or rejected line, so this replays only because the
 * `reconcile-close-parked` patch sends a history without the marker down the old
 * plan: such a line counts as unchanged and no cancel is issued.
 *
 * Recorded from the pre-change `reconcile-findings.ts` (origin/master at
 * de5f9cd, the worktree before its first edit) against the time-skipping server
 * with mocked activities and real finding runs, so it holds no real finding
 * text.
 *
 * Probe (2026-11-07): replacing `wf.patched(RECONCILE_CLOSE_PARKED_PATCH)` with
 * `true`, so every run takes the close path, made this replay fail with
 *
 * ```
 * [TMPRL1100] Nondeterminism error: Cancel external WF machine does not handle this event:
 * HistoryEvent(id: 33, ActivityTaskScheduled)
 * ```
 *
 * The other 19 replays stayed green. The guard was restored and all 20 replays re-ran green.
 */
const reconcileCloseParkedPath = fileURLToPath(
  new URL('../fixtures/histories/reconcile-close-parked-pre.bin', import.meta.url),
);

test('a reconcile run recorded before the close rule replays without a cancel', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(reconcileCloseParkedPath));
  await Worker.runReplayHistory(
    { workflowBundle: await workflowBundle() },
    history,
    'reconcile-fixture-5',
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
