// A stub for `long-retry.test.ts`: one call and one wait, each retried a second
// apart with no attempt limit.
import { proxyActivities } from '@temporalio/workflow';

const { writeThing, awaitFixPrMerge } = proxyActivities<{ writeThing(): Promise<void>; awaitFixPrMerge(): Promise<void> }>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '1 second', backoffCoefficient: 1 },
});

export async function lastFailureWorkflow(): Promise<void> {
  await writeThing();
  await awaitFixPrMerge();
}
