import { test } from 'node:test';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';

/**
 * Replay regression test (temporal-developer skill, testing.md § Replay Testing).
 *
 * This is the tripwire for the Steward's normal operating condition: reviews
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
 * otherwise guard the fan-out shape the Steward now takes by default.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const historyPath = fileURLToPath(
  new URL('../fixtures/histories/phase1b-smoke-test.json', import.meta.url),
);
const buildAuditHistoryPath = fileURLToPath(
  new URL('../fixtures/histories/phase1c-build-audit.json', import.meta.url),
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
