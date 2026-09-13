import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import {
  findingPath,
  findingWorkflowId,
  findingsIndexPath,
  planReconcile,
  type FindingVerdict,
} from '../lib/findings.js';
import { verdictSignal } from './finding.js';

/**
 * `reconcileFindingsWorkflow`: the findings store's one poller (findings-loop
 * design, decision 17). A Schedule runs it hourly on `steward-findings`, and
 * `steward finding sync` triggers the same Schedule on demand.
 *
 * For every site folder in the findings repository it reads `INDEX.md` and
 * compares it with the running finding workflows:
 *
 * - a `proposed` line with no open workflow gets one started;
 * - an `approved` or `rejected` line whose workflow is still open gets the
 *   `verdict` signal with source `file`, carrying the reason from the line;
 * - everything else is unchanged.
 *
 * A second run straight after the first finds nothing to do, which is the
 * property the design needs from a poller that runs every hour forever.
 *
 * **Started through an activity, not as children.** The child form was built
 * first, with `ParentClosePolicy.ABANDON`, and its test showed the children
 * carrying an execution timeout they never asked for. A child with no execution
 * timeout of its own inherits its parent's, and this workflow runs under the
 * Schedule's 15-minute `workflowExecutionTimeout`, so every finding would time
 * out a quarter of an hour after it was started. `startFindingWorkflow` starts a
 * top-level execution through the worker's client, with no parent and no
 * timeout, and reports `already-started` on a collision so a retry is harmless.
 * The signal still goes through an external workflow handle: a signal carries no
 * timeout, so the command form costs nothing there.
 *
 * **Visibility lags.** The open-workflow list comes from the visibility store,
 * which is eventually consistent, so a workflow started a moment ago may not be
 * listed yet. A start that finds the workflow already running and a signal to a
 * workflow that has just closed are both counted as unchanged rather than
 * failing the run.
 *
 * **Health.** Every run pings `findings-reconcile`, success and failure, so a
 * reconciler that stops running goes late at the alerting service.
 */

const QUEUE_FINDINGS = 'steward-findings';

export interface ReconcileFindingsInput {
  /** `owner/name` of the findings repository, frozen into the Schedule's action. */
  repo: string;
}

export interface SiteReconcileCounts {
  started: number;
  signalled: number;
  unchanged: number;
}

export type ReconcileFindingsResult = Record<string, SiteReconcileCounts>;

const reading = wf.proxyActivities<
  Pick<typeof activities, 'listSites' | 'readFindingsIndex' | 'listOpenFindingWorkflows' | 'startFindingWorkflow'>
>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['AuthError', 'NotFound', 'StoreLayout'] },
});

// Same shape as the scorecard's alerting proxy: the activity retries the HTTP
// call itself and never throws.
const alerting = wf.proxyActivities<Pick<typeof activities, 'reportRunHealth'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
});

function describeError(err: unknown): string {
  let current: unknown = err;
  let best = '';
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.message && current.message !== 'Activity task failed') best = current.message;
    current = (current as Error).cause;
  }
  return best || (err instanceof Error ? err.message : String(err));
}

/** A signal to a workflow that closed between the list and the signal. */
function isGone(err: unknown): boolean {
  return err instanceof Error && /not found|already completed|WorkflowNotFound/i.test(`${err.name} ${err.message}`);
}

async function reconcile(input: ReconcileFindingsInput): Promise<ReconcileFindingsResult> {
  const sites = await reading.listSites(input.repo);
  const openIds = await reading.listOpenFindingWorkflows();
  const result: ReconcileFindingsResult = {};

  for (const site of sites) {
    const index = await reading.readFindingsIndex(input.repo, site);
    const plan = planReconcile(site, index, openIds);
    const counts: SiteReconcileCounts = { started: 0, signalled: 0, unchanged: plan.unchanged };

    for (const line of plan.start) {
      const outcome = await reading.startFindingWorkflow({
        site,
        key: line.key,
        repo: input.repo,
        findingPath: findingPath(site, line.key),
        indexPath: findingsIndexPath(site),
        stopAfter: 'verdict',
      });
      if (outcome === 'started') counts.started++;
      else counts.unchanged++;
    }

    for (const line of plan.signal) {
      const verdict: FindingVerdict = {
        status: line.status as FindingVerdict['status'],
        reason: line.reason,
        source: 'file',
        at: new Date(Date.now()).toISOString(),
      };
      try {
        await wf.getExternalWorkflowHandle(findingWorkflowId(site, line.key)).signal(verdictSignal, verdict);
        counts.signalled++;
      } catch (err) {
        if (!isGone(err)) throw err;
        counts.unchanged++;
      }
    }

    result[site] = counts;
  }
  return result;
}

function summarise(result: ReconcileFindingsResult): string {
  const sites = Object.entries(result);
  if (sites.length === 0) return 'Findings reconcile: no site folders.';
  const parts = sites.map(
    ([site, c]) => `${site} started ${c.started}, signalled ${c.signalled}, unchanged ${c.unchanged}`,
  );
  return `Findings reconcile: ${parts.join('; ')}.`;
}

export async function reconcileFindingsWorkflow(input: ReconcileFindingsInput): Promise<ReconcileFindingsResult> {
  let result: ReconcileFindingsResult;
  try {
    result = await reconcile(input);
  } catch (err) {
    await alerting.reportRunHealth({
      signal: 'findings-reconcile',
      shape: {
        ok: false,
        summary:
          `Findings reconcile against ${input.repo} failed: ${describeError(err)}. No finding ` +
          'workflow was started or signalled after the failure point, so a verdict given in ' +
          'Discord or Obsidian waits for the next good run. The workflow history in Temporal ' +
          'Cloud names the failing step.',
      },
    });
    throw err;
  }

  const summary = summarise(result);
  wf.log.info('findings reconciled', { result });
  await alerting.reportRunHealth({ signal: 'findings-reconcile', shape: { ok: true, summary } });
  return result;
}
