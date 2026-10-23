import { test } from 'node:test';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import proto from '@temporalio/proto';

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

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
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
      { workflowsPath, bundlerOptions: {} },
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
      { workflowsPath, bundlerOptions: {} },
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
      { workflowsPath, bundlerOptions: {} },
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
      { workflowsPath, bundlerOptions: {} },
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
    { workflowsPath, bundlerOptions: {} },
    history,
    'finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});

test('a verdict-only finding history with a file reject replays against current workflow code', { timeout: 120_000 }, async () => {
  const history = JSON.parse(await fs.readFile(findingFileHistoryPath, 'utf8'));
  await Worker.runReplayHistory(
    { workflowsPath, bundlerOptions: {} },
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
    { workflowsPath, bundlerOptions: {} },
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
    { workflowsPath, bundlerOptions: {} },
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
    { workflowsPath, bundlerOptions: {} },
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
    { workflowsPath, bundlerOptions: {} },
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
    { workflowsPath, bundlerOptions: {} },
    history,
    'verify/mattpyle-com/content-perfect-score-labelled-fail--scorecard/2026-10-13T041233Z',
  );
});

test('a lifecycle run whose child ended unverifiable still replays to that ending', { timeout: 120_000 }, async () => {
  const history = proto.temporal.api.history.v1.History.decode(await fs.readFile(findingUnverifiableHistoryPath));
  await Worker.runReplayHistory(
    { workflowsPath, bundlerOptions: {} },
    history,
    'finding/mattpyle-com/content-perfect-score-labelled-fail--scorecard',
  );
});
