// A stub for `next-retry-delay.test.ts`: one activity under a policy whose
// longest interval is far shorter than the delay the failure asks for.
import { proxyActivities } from '@temporalio/workflow';

const { limitedOnce } = proxyActivities<{ limitedOnce(): Promise<void> }>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '1 second', maximumInterval: '5 seconds', maximumAttempts: 2 },
});

/** Milliseconds of workflow time the call took, retry wait included. */
export async function nextRetryDelayWorkflow(): Promise<number> {
  const started = Date.now();
  await limitedOnce();
  return Date.now() - started;
}
