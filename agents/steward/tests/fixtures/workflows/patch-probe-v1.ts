import * as wf from '@temporalio/workflow';

/**
 * The code before a patch (STW-689), for `tests/workflows/patched-replay.test.ts`.
 * A catch that goes on, a wait, then the marker's first reading at a later site.
 */
const probe = wf.proxyActivities<{ first(): Promise<void>; marked(): Promise<void>; newBranch(): Promise<void> }>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
});

export const goSignal = wf.defineSignal('go');

export async function patchProbe(): Promise<string> {
  let go = false;
  wf.setHandler(goSignal, () => {
    go = true;
  });
  try {
    await probe.first();
  } catch {
    // The old branch: go on.
  }
  await wf.condition(() => go);
  if (wf.patched('probe-marker')) await probe.marked();
  return 'done';
}
