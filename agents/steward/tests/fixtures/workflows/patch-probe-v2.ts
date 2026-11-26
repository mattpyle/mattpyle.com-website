import * as wf from '@temporalio/workflow';

/**
 * The code after a patch (STW-689), for `tests/workflows/patched-replay.test.ts`.
 * The same as `patch-probe-v1.ts`, but the catch now reads the marker first
 * and, when it answers true, issues a new command.
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
    if (wf.patched('probe-marker')) await probe.newBranch();
  }
  await wf.condition(() => go);
  if (wf.patched('probe-marker')) await probe.marked();
  return 'done';
}
