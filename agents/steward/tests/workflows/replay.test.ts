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

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const historyPath = fileURLToPath(
  new URL('../fixtures/histories/phase1b-smoke-test.json', import.meta.url),
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
