import { ApplicationFailure, Context } from '@temporalio/activity';
import type { FindingSettings } from '../../src/activities/findings.js';

/**
 * What `readFindingSettings` answers for a site that fixes findings, with
 * `auto_fix` off and a finding the gate accepts. A test names what differs.
 */
export function settings(over: Partial<FindingSettings> = {}): FindingSettings {
  return { stopAfter: 'resolved', origin: 'https://www.mattpyle.com', autoFix: false, watch: false, status: 'approved', kind: 'defect', refusal: null, ...over };
}

/** A site whose runs end at the verdict: `stop_after: verdict`, or no production origin on the worker. */
export const STOPS_AT_VERDICT: FindingSettings = settings({ stopAfter: 'verdict', origin: null });

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
 *
 * **The settings read (STW-645).** A run that takes an approved verdict reads
 * `readFindingSettings` twice: the stop point before the measurement, and the
 * decision after it. A test that brings no mock of its own gets a site that
 * fixes findings and a gate that accepts, with `auto_fix` taken from the
 * test's own `readSiteAutoFix`. That mock is asked on every read but a run's
 * first, so it is first called where the flag was read before the settings
 * read existed, after the measurement, and a test's call list reads as it did.
 * `tests/workflows/finding-settings-at-use.test.ts` covers the read itself.
 */
/**
 * A stand-in for the fix log entry step (STW-710) in a lifecycle test that is
 * about something else: the entry is already on the PR branch, so the run
 * schedules the draft once, commits nothing, and goes on to the merge wait.
 * `tests/workflows/finding-fix-log.test.ts` runs the real activities.
 */
export const FIX_LOG_ENTRY_PRESENT = {
  draftFixLogEntry: async () => ({ state: 'exists' as const, key: 'MP-0', path: 'src/content/fixes/mp-0.md' }),
};

/**
 * A stand-in for the fix log confirmation (STW-712) in a lifecycle test that is
 * about something else: no entry on master, so the step does nothing and the run
 * ends or parks as before. `tests/workflows/finding-fix-log-confirm.test.ts`
 * runs the real activities.
 */
export const FIX_LOG_CONFIRM_SKIPPED = {
  openFixLogConfirmation: async () => ({ state: 'skipped' as const, reason: 'no entry on master in this test' }),
};

export function skipVerdictMeasure<T extends object>(activities: T): T {
  const own = activities as Record<string, unknown>;
  const checks = own.runFindingChecks as ((input: { previewOrigin?: string }) => Promise<unknown>) | undefined;
  const autoFix = own.readSiteAutoFix as ((input: unknown) => Promise<boolean>) | undefined;
  const reads = new Map<string, number>();
  return {
    writeFindingVerdictMeasure: async () => ({ commitSha: null }),
    ...FIX_LOG_ENTRY_PRESENT,
    ...FIX_LOG_CONFIRM_SKIPPED,
    readFindingSettings: async (input: { repo: string; site: string }) => {
      const info = Context.current().info.workflowExecution;
      const run = `${info?.workflowId}/${info?.runId}`;
      const n = (reads.get(run) ?? 0) + 1;
      reads.set(run, n);
      return settings({ autoFix: n > 1 && autoFix ? await autoFix({ repo: input.repo, site: input.site }) : false });
    },
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
