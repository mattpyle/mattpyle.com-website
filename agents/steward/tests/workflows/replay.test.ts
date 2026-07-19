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
 * The fixture is the real Phase 1a durability-test execution (51 events): the
 * run whose worker was killed while parked, received `approve` while no process
 * existed to hear it, and completed on restart as `approved_force`. It exercises
 * the fan-out, both archive calls, the signal handler, and completion.
 *
 * `runReplayHistory` throws on a determinism mismatch, so no assertion is
 * needed — reaching the end of the test is the pass condition.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const historyPath = fileURLToPath(
  new URL('../fixtures/histories/phase1a-smoke-test.json', import.meta.url),
);

test(
  'the Phase 1a smoke-test history still replays against current workflow code',
  { timeout: 120_000 },
  async () => {
    const history = JSON.parse(await fs.readFile(historyPath, 'utf8'));

    await Worker.runReplayHistory(
      { workflowsPath, bundlerOptions: {} },
      history,
      'steward-review-steward-smoke-test',
    );
  },
);
