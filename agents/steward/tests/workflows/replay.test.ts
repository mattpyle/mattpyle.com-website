import { test } from 'node:test';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';

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
 * That break is a legitimate versioning finding (recorded in the build log), not
 * a regression: adding activities to a parallel fan-out is not a replay-safe
 * change, and nothing in production was parked on the old shape. The old fixture
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
 * on trust — see the build-log entry for the probe and its output.
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
 * The probe was reverted and the test re-run green — see the build-log entry.
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
