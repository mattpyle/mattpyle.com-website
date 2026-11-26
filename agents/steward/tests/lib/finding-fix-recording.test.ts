import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowHandle } from '@temporalio/client';
import { followFix, type FixRequested } from '../../src/lib/finding-fix.js';
import type { FindingState } from '../../src/workflows/finding.js';

/**
 * `steward finding fix` while `writeFindingFix` retries (STW-689). The run
 * holds the attempt's PR at `fixing` before its record is written, which can
 * take days in an outage (STW-680). `followFix` returns that PR at once, says
 * its record is being written, and never takes the last attempt's PR for it.
 * A fake handle answers the `state` query from a list, one state per poll.
 */

const ISSUE = 'https://github.com/mattpyle/mattpyle.com-website/issues/102';
const OLD_PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/401';
const NEW_PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/402';

function state(over: Partial<FindingState>): FindingState {
  return { site: 'mattpyle-com', key: 'k', status: 'done', verdict: null, commitSha: null, step: 'fixing', fixAttempts: 2, ...over };
}

function requested(states: FindingState[], priorPrUrl: string | null): FixRequested {
  let i = 0;
  const lifecycle = { workflowId: 'finding/mattpyle-com/k', query: async () => states[Math.min(i++, states.length - 1)] } as unknown as WorkflowHandle;
  return { lifecycle, started: false, returnedFrom: null, replacedVerdictRun: false, priorAttempts: 1, priorIssueUrl: null, priorPrUrl };
}

test("the attempt's PR, known while its record is written, is returned at once and marked as recording", async () => {
  const fixed = await followFix(
    requested([state({ issueUrl: ISSUE, prUrl: OLD_PR }), state({ issueUrl: ISSUE, prUrl: NEW_PR })], OLD_PR),
    () => undefined,
    { pollMs: 1, waitMs: 5_000 },
  );
  assert.deepEqual(fixed, { issueUrl: ISSUE, prUrl: NEW_PR, recording: true });
});

test("the last attempt's PR at fixing is not this attempt's: the follow waits, and fails at its bound as before", async () => {
  await assert.rejects(
    followFix(requested([state({ issueUrl: ISSUE, prUrl: OLD_PR })], OLD_PR), () => undefined, { pollMs: 1, waitMs: 50 }),
    /has no PR after 0 minutes/,
  );
});
