import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import {
  findingPath,
  findingWorkflowId,
  findingsIndexPath,
  fixCandidates,
  hasParkedDefect,
  listedRuns,
  planReconcile,
  restartCandidates,
  startsParked,
  type FindingVerdict,
} from '../lib/findings.js';
import { fixSignal, verdictSignal } from './finding.js';

/**
 * `reconcileFindingsWorkflow`: the findings store's one poller (findings-loop
 * design, decision 17). A Schedule runs it hourly on `steward-findings`, and
 * `steward finding sync` triggers the same Schedule on demand.
 *
 * For every site folder in the findings repository it reads `INDEX.md` and
 * compares it with the running finding workflows:
 *
 * - a `proposed` or `reopened` line with no open workflow gets one started,
 *   with `stopAfter: 'resolved'`, so it runs gate, fix and verify in one
 *   execution (design decisions 18 and 29). It waits at `waiting-verdict`.
 *   Workflows started earlier keep their `'verdict'`;
 * - an `approved` or `rejected` line whose workflow is still open at
 *   `waiting-verdict` gets the `verdict` signal with source `file`, carrying
 *   the reason from the line;
 * - an `approved` line, of any kind, whose workflow waits at `waiting-fix` and
 *   has opened no issue, on a site whose `config.yaml` says `auto_fix: true`
 *   and whose finding file the fixer's gate accepts (`fixRefusal`), gets the
 *   `fix` signal (design decision 31). A run reads the flag once, at its
 *   verdict, so one that passed it before the flag was set would wait for a
 *   `fix` nobody sends; a run whose attempt the gate refused waits the same
 *   way until the finding passes. "No issue" is the test, not "no attempt": a
 *   run whose Action failed keeps its issue and stays a person's retry. The
 *   flag is read once per site, and only for a site with such a run. The gate
 *   runs first, in `listFixableFindings`, so a refused finding is never
 *   signalled hourly;
 * - an `approved` line with no open workflow, on a site whose `config.yaml` says
 *   `auto_fix: true` and whose finding file the gate accepts, gets a new
 *   lifecycle run: `startFindingWorkflow` with `stopAfter: 'resolved'` and no
 *   `waitsForPerson`, then the `verdict` signal with status `approved`, the
 *   line's reason, source `file` and the workflow clock. The run attempts the
 *   fix at that verdict, as a run started `proposed` does. An approval whose
 *   run stopped at the verdict, or was cancelled, would otherwise wait for a
 *   person to press Fix. A start that finds the ID taken counts as unchanged and
 *   sends no signal. The gate read covers these lines with the parked ones, and
 *   the flag is read when either list is not empty;
 * - a `resolved` or `rejected` line whose workflow is open at `waiting-fix` has
 *   the workflow cancelled. Verify, or a verdict given outside the fixer's path,
 *   decided the file and left the run parked on a `fix` that will never come.
 *   An `approved` line's parked run is the fixer's business, and a `rejected`
 *   line's run at `waiting-verdict` takes the `verdict` signal above, so neither
 *   is closed here. The reason is the line's status, written to this
 *   workflow's log: a cancel request carries no reason of its own;
 * - everything else is unchanged.
 *
 * A start for a direction carries `waitsForPerson`, so the run parks at
 * `waiting-fix` without the automatic fix attempt. A defect or an opportunity
 * starts without it: its run attempts the fix at the verdict on an `auto_fix`
 * site, and the gate decides. The kind is read from the index line the plan
 * already holds, so no command is added: a history recorded before the field
 * replays the same start, and the activity's arguments are not compared on
 * replay.
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
 * The signals still go through an external workflow handle: a signal carries no
 * timeout, so the command form costs nothing there.
 *
 * **Replay.** `listOpenFindingWorkflows` once returned bare IDs. A history
 * recorded then replays its list as strings, which `planReconcile` reads as
 * runs of unknown step: no `fix` line and no `auto_fix` read, so the commands
 * match the history without a `patched` marker.
 *
 * **`reconcile-fix-any-kind`** (2026-11-03). The kind-blind rule reads the
 * flag for more runs than the defect rule did (an opportunity, a run with an
 * attempt) and adds the `listFixableFindings` command after it, so a run in
 * flight when this shipped would replay a different command sequence. A
 * history without the marker keeps the defect rule: `hasParkedDefect`, then
 * `planReconcile` without a `fixable` set. `reconcile-parked-defect-pre.bin`
 * in `tests/workflows/replay.test.ts` is such a history, recorded from
 * `e983b03`, and its docblock holds the probe.
 *
 * **`reconcile-restart-approved`** (2026-11-06). The restart adds a flag read, a
 * gate read, a start and a signal for an approved line with no run, so a run in
 * flight when this shipped would replay a different command sequence. A history
 * without the marker never restarts: it reads the candidates it did before.
 * `reconcile-restart-approved-pre.bin` in `tests/workflows/replay.test.ts` is
 * such a history, recorded from `7ea21e5`, and its docblock holds the probe.
 *
 * **`reconcile-close-parked`** (2026-11-07). The close adds one external cancel
 * per parked run behind a resolved or rejected line, so a run in flight when this
 * shipped would replay a different command sequence. A history without the
 * marker closes nothing and counts those lines as unchanged.
 * `reconcile-close-parked-pre.bin` in `tests/workflows/replay.test.ts` is such a
 * history, recorded from `de5f9cd`, and its docblock holds the probe.
 *
 * **Closed by cancellation, not termination.** The run parks on
 * `wf.condition(() => fix.requested)` in `findingWorkflow`, outside every
 * `try`, so a cancel raises `CancelledFailure` there and the run ends as
 * Canceled with its history intact. Its `finally` releases a dispatcher slot
 * only when one is held, and a run at `waiting-fix` holds none. So
 * `findingWorkflow` needs no handler and no marker. A termination through an
 * activity would record a reason in the target's history, but it skips every
 * `finally`; the cancel is the clean end, and the CLI already closes lifecycle
 * runs the same way (`cancelLifecycleRun`). A cancelled run leaves the
 * visibility list at once, so the next reconcile sees a line with no run and
 * counts it unchanged: a `resolved` or `rejected` line is never restarted.
 *
 * **Visibility lags.** The open-workflow list comes from the visibility store,
 * which is eventually consistent, so a workflow started a moment ago may not be
 * listed yet. A start that finds the workflow already running and a signal to a
 * workflow that has just closed are both counted as unchanged rather than
 * failing the run.
 *
 * **Pruned listing** (STW-598). The list asks only the runs behind an approved,
 * rejected or resolved line for their step; the rest come back with a null step
 * and `queried: false`. It is the same one activity call with other arguments,
 * and a call's arguments are not compared on replay, so the command sequence is
 * unchanged and no marker is needed. A history recorded before holds a bare
 * array, read by `listedRuns`. The counts of listed runs, queried runs and
 * index reads go into the log line and the health summary, not into the result.
 * The activity's docblock holds the two risks the pruning accepts.
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
  /** Parked approved findings sent the `fix` signal. */
  fixed: number;
  /**
   * Approved findings with no open run that got a new run and the `verdict` signal.
   * Absent from a result recorded before the restart existed.
   */
  restarted?: number;
  /**
   * Resolved or rejected findings whose run was parked at `waiting-fix` and got a cancel.
   * Absent from a result recorded before the close existed.
   */
  closed?: number;
  unchanged: number;
}

export type ReconcileFindingsResult = Record<string, SiteReconcileCounts>;

/** A reconcile run recorded without this marker keeps the defect-only `fix` rule. */
export const RECONCILE_FIX_ANY_KIND_PATCH = 'reconcile-fix-any-kind';

/** A reconcile run recorded without this marker never restarts an approved line that has no open run. */
export const RECONCILE_RESTART_APPROVED_PATCH = 'reconcile-restart-approved';

/** A reconcile run recorded without this marker never cancels the parked run of a resolved or rejected line. */
export const RECONCILE_CLOSE_PARKED_PATCH = 'reconcile-close-parked';

const reading = wf.proxyActivities<
  Pick<
    typeof activities,
    'listSites' | 'readFindingsIndex' | 'listOpenFindingWorkflows' | 'startFindingWorkflow' | 'readSiteAutoFix' | 'listFixableFindings'
  >
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

async function reconcile(input: ReconcileFindingsInput): Promise<{ result: ReconcileFindingsResult; stats: ListingStats }> {
  const sites = await reading.listSites(input.repo);
  const listing = await reading.listOpenFindingWorkflows({ repo: input.repo, sites });
  const open = listedRuns(listing);
  const stats: ListingStats = {
    listed: open.length,
    // The activity's own count includes a run whose query read `done` and was dropped from the
    // list. A bare array from an old history has no count, so it is recomputed from the runs.
    queried: Array.isArray(listing) ? open.filter((run) => typeof run === 'string' || run.queried !== false).length : listing.queried,
    // A list recorded before the activity pruned is a bare array: it read no index.
    indexReads: Array.isArray(listing) ? 0 : listing.indexReads,
  };
  const result: ReconcileFindingsResult = {};
  const anyKind = wf.patched(RECONCILE_FIX_ANY_KIND_PATCH);
  const restartApproved = anyKind && wf.patched(RECONCILE_RESTART_APPROVED_PATCH);
  const closeParked = anyKind && restartApproved && wf.patched(RECONCILE_CLOSE_PARKED_PATCH);

  for (const site of sites) {
    const index = await reading.readFindingsIndex(input.repo, site);
    let autoFix = false;
    let fixable: ReadonlySet<string> | undefined;
    if (anyKind) {
      const candidates = [...fixCandidates(site, index, open), ...(restartApproved ? restartCandidates(site, index, open) : [])];
      if (candidates.length > 0) autoFix = await reading.readSiteAutoFix({ repo: input.repo, site });
      fixable = new Set(
        autoFix
          ? await reading.listFixableFindings({ repo: input.repo, site, keys: candidates.map((line) => line.key) })
          : [],
      );
    } else if (hasParkedDefect(site, index, open)) {
      autoFix = await reading.readSiteAutoFix({ repo: input.repo, site });
    }
    const plan = planReconcile(site, index, open, autoFix, fixable, closeParked);
    const counts: Required<SiteReconcileCounts> = { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: plan.unchanged };

    for (const line of plan.start) {
      const outcome = await reading.startFindingWorkflow({
        site,
        key: line.key,
        repo: input.repo,
        findingPath: findingPath(site, line.key),
        indexPath: findingsIndexPath(site),
        stopAfter: 'resolved',
        indexStatus: line.status === 'reopened' ? 'reopened' : 'proposed',
        ...(startsParked(line) ? { waitsForPerson: true } : {}),
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

    for (const line of plan.fix) {
      try {
        await wf
          .getExternalWorkflowHandle(findingWorkflowId(site, line.key))
          .signal(fixSignal, { source: 'reconcile', at: new Date(Date.now()).toISOString() });
        counts.fixed++;
      } catch (err) {
        if (!isGone(err)) throw err;
        counts.unchanged++;
      }
    }

    for (const line of plan.restart) {
      const outcome = await reading.startFindingWorkflow({
        site,
        key: line.key,
        repo: input.repo,
        findingPath: findingPath(site, line.key),
        indexPath: findingsIndexPath(site),
        stopAfter: 'resolved',
        indexStatus: 'approved',
      });
      if (outcome !== 'started') {
        counts.unchanged++;
        continue;
      }
      const verdict: FindingVerdict = {
        status: 'approved',
        reason: line.reason,
        source: 'file',
        at: new Date(Date.now()).toISOString(),
      };
      try {
        await wf.getExternalWorkflowHandle(findingWorkflowId(site, line.key)).signal(verdictSignal, verdict);
        counts.restarted++;
      } catch (err) {
        if (!isGone(err)) throw err;
        counts.unchanged++;
      }
    }

    for (const line of plan.close) {
      try {
        await wf.getExternalWorkflowHandle(findingWorkflowId(site, line.key)).cancel();
        wf.log.info('closing a parked run', { site, key: line.key, reason: `the index line says ${line.status}` });
        counts.closed++;
      } catch (err) {
        if (!isGone(err)) throw err;
        counts.unchanged++;
      }
    }

    result[site] = counts;
  }
  return { result, stats };
}

/** How one firing's listing went: the cost line for the health summary and the log. */
interface ListingStats {
  listed: number;
  queried: number;
  indexReads: number;
}

function summarise(result: ReconcileFindingsResult, stats: ListingStats): string {
  const cost = `Listed ${stats.listed} open runs, queried ${stats.queried}, read ${stats.indexReads} indexes to decide.`;
  const sites = Object.entries(result);
  if (sites.length === 0) return `Findings reconcile: no site folders. ${cost}`;
  const parts = sites.map(
    ([site, c]) => `${site} started ${c.started}, signalled ${c.signalled}, fixed ${c.fixed}, restarted ${c.restarted ?? 0}, closed ${c.closed ?? 0}, unchanged ${c.unchanged}`,
  );
  return `Findings reconcile: ${parts.join('; ')}. ${cost}`;
}

export async function reconcileFindingsWorkflow(input: ReconcileFindingsInput): Promise<ReconcileFindingsResult> {
  let outcome: { result: ReconcileFindingsResult; stats: ListingStats };
  try {
    outcome = await reconcile(input);
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

  const { result, stats } = outcome;
  const summary = summarise(result, stats);
  // The one-line plan counts, not the result object: this runs hourly, and the
  // result stays in the return value. A log line is not a command, so no marker.
  wf.log.info(summary);
  await alerting.reportRunHealth({ signal: 'findings-reconcile', shape: { ok: true, summary } });
  return result;
}
