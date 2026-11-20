import * as wf from '@temporalio/workflow';
import type { RunFindingChecksInput, RunFindingChecksResult } from '../../src/activities/verify-finding.js';

/**
 * A workflow that schedules `runFindingChecks` the way the real stubs do, with
 * the two timeouts far apart and short enough for a test: a three-second
 * heartbeat timeout under a five-minute start-to-close.
 * `tests/workflows/check-heartbeat-retry.test.ts` runs it on a real dev
 * server. The real stubs' own values are pinned by
 * `tests/workflows/heartbeat-timeouts.test.ts`.
 */
const checking = wf.proxyActivities<{ runFindingChecks(input: RunFindingChecksInput): Promise<RunFindingChecksResult> }>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '3 seconds',
  retry: { maximumAttempts: 2, initialInterval: '1 second' },
});

export async function checkHeartbeatStub(input: RunFindingChecksInput): Promise<RunFindingChecksResult> {
  return checking.runFindingChecks(input);
}
