import { ApplicationFailure, Context } from '@temporalio/activity';

/**
 * Keeps a lifecycle test on the path it was written for, past the measurement
 * at the approved verdict (STW-589). `tests/workflows/finding-verdict-measure.test.ts`
 * covers the measurement itself.
 *
 * The measurement is the one `runFindingChecks` a `finding/` run schedules
 * without a preview origin: the preview test passes one, and the verify child
 * runs as `verify/`. This answers that call with a broken check, so the run
 * records it unmeasured and goes on to the fix as before. Every other call
 * reaches the test's own mock. `writeFindingVerdictMeasure` writes nothing
 * unless the test brings its own.
 */
export function skipVerdictMeasure<T extends object>(activities: T): T {
  const own = activities as Record<string, unknown>;
  const checks = own.runFindingChecks as ((input: { previewOrigin?: string }) => Promise<unknown>) | undefined;
  return {
    writeFindingVerdictMeasure: async () => ({ commitSha: null }),
    ...activities,
    runFindingChecks: async (input: { previewOrigin?: string }) => {
      const workflowId = Context.current().info.workflowExecution?.workflowId ?? '';
      if (workflowId.startsWith('finding/') && !input.previewOrigin) {
        throw ApplicationFailure.nonRetryable('not measured in this test', 'VerifyCheckBroken');
      }
      if (!checks) throw ApplicationFailure.nonRetryable('this test has no runFindingChecks', 'VerifyCheckBroken');
      return checks(input);
    },
  } as T;
}
