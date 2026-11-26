import * as wf from '@temporalio/workflow';

/**
 * Stand-ins for `findingWorkflow`, for `tests/cli/finding-status-cli.test.ts`.
 * The CLI reads a run by workflow ID and the `state` query, so a stub that
 * answers that query and ends the way a test chooses is enough to see what
 * `steward finding status` prints for each way a run can stand or end. The
 * real workflow needs a dozen activities that say nothing about the output.
 */

export interface StubInput {
  /** `open` parks at the step below; `completed` returns `result`; `failed` throws `failure`; a cancelled run is an `open` one the test cancels. */
  mode: 'open' | 'completed' | 'failed';
  step: string;
  gate: 'waiting' | 'writing' | 'held' | 'done';
  result?: { outcome?: string; verifyWorkflowId?: string };
  failure?: string;
  /** The verdict the `state` query answers with; none when absent. */
  verdict?: { status: string; reason: string; source: string; at: string };
  /** The PR and issue the `state` query answers with (STW-689). */
  prUrl?: string;
  issueUrl?: string;
  /** Schedules `writeFindingFix` on a queue no worker serves, so `describe()` shows it pending. */
  pendingWrite?: boolean;
}

// A queue no test worker polls: an activity scheduled here stays pending.
const unserved = wf.proxyActivities<{ writeFindingFix(): Promise<void> }>({ taskQueue: 'status-stub-unserved', startToCloseTimeout: '1 minute' });

export async function findingWorkflow(input: StubInput): Promise<unknown> {
  wf.setHandler(
    wf.defineQuery<{ site: string; key: string; status: string; step: string; stopAfter: string; verdict: StubInput['verdict'] | null; commitSha: null; prUrl: string | null; issueUrl: string | null }>('state'),
    () => ({
      site: 'mattpyle-com',
      key: 'stub',
      status: input.gate,
      step: input.step,
      stopAfter: 'resolved',
      verdict: input.verdict ?? null,
      commitSha: null,
      prUrl: input.prUrl ?? null,
      issueUrl: input.issueUrl ?? null,
    }),
  );
  if (input.pendingWrite) void unserved.writeFindingFix().catch(() => undefined);
  if (input.mode === 'completed') return { site: 'mattpyle-com', key: 'stub', verdict: null, commitSha: null, ...input.result };
  if (input.mode === 'failed') throw wf.ApplicationFailure.nonRetryable(input.failure ?? 'The stub failed.');
  await wf.condition(() => false);
  return undefined;
}
