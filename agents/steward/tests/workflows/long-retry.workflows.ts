// A stub for `long-retry.test.ts`: two activities retried every half hour with
// no attempt limit.
import { proxyActivities } from '@temporalio/workflow';

const { writeThing, awaitFixPrMerge } = proxyActivities<{ writeThing(): Promise<void>; awaitFixPrMerge(): Promise<void> }>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '30 minutes', backoffCoefficient: 1 },
});

export async function longRetryWorkflow(): Promise<void> {
  await writeThing();
}

export async function longWaitWorkflow(): Promise<void> {
  await awaitFixPrMerge();
}
