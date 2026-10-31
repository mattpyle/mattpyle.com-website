import * as wf from '@temporalio/workflow';
import type { FindingVerdict } from '../../../src/lib/findings.js';
import { findingStateQuery, verdictSignal, type FindingState } from '../../../src/workflows/finding.js';

/**
 * A stand-in for `findingWorkflow` that answers the verdict gate's two names,
 * the `verdict` signal and the `state` query, and records every payload it
 * receives. `tests/console/verdict-shared.test.ts` sends one verdict from the
 * CLI and one from the console to it and compares the two.
 *
 * It stays open after the verdict, as a `resolved` run does, so the sender
 * reads the recorded verdict from `state`.
 */

export const receivedVerdictsQuery = wf.defineQuery<FindingVerdict[]>('received-verdicts');

export const STUB_COMMIT = 'stub-commit-sha';

export async function verdictStubWorkflow(input: { site: string; key: string }): Promise<void> {
  const received: FindingVerdict[] = [];
  wf.setHandler(verdictSignal, (verdict) => {
    received.push(verdict);
  });
  wf.setHandler(receivedVerdictsQuery, () => received);
  wf.setHandler(
    findingStateQuery,
    (): FindingState => ({
      site: input.site,
      key: input.key,
      status: received.length > 0 ? 'done' : 'waiting',
      verdict: received[0] ?? null,
      commitSha: received.length > 0 ? STUB_COMMIT : null,
      stopAfter: 'resolved',
      step: received.length > 0 ? 'waiting-fix' : 'waiting-verdict',
    }),
  );
  await wf.condition(() => false);
}
