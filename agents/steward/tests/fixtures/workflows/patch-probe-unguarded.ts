import * as wf from '@temporalio/workflow';

/**
 * `patch-probe-v2.ts` with the guard removed (STW-689): the catch always
 * issues its new command. `tests/workflows/patched-replay.test.ts` shows its
 * replay of a v1 history fails, so the guarded replay can fail too.
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
    await probe.newBranch();
  }
  await wf.condition(() => go);
  if (wf.patched('probe-marker')) await probe.marked();
  return 'done';
}
