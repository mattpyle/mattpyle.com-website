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
  gate: 'waiting' | 'writing' | 'done';
  result?: { outcome?: string; verifyWorkflowId?: string };
  failure?: string;
}

export async function findingWorkflow(input: StubInput): Promise<unknown> {
  wf.setHandler(
    wf.defineQuery<{ site: string; key: string; status: string; step: string; stopAfter: string; verdict: null; commitSha: null }>('state'),
    () => ({ site: 'mattpyle-com', key: 'stub', status: input.gate, step: input.step, stopAfter: 'resolved', verdict: null, commitSha: null }),
  );
  if (input.mode === 'completed') return { site: 'mattpyle-com', key: 'stub', verdict: null, commitSha: null, ...input.result };
  if (input.mode === 'failed') throw wf.ApplicationFailure.nonRetryable(input.failure ?? 'The stub failed.');
  await wf.condition(() => false);
  return undefined;
}
