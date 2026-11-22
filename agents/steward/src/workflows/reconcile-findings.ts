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
 * `reconcileFindingsWorkflow`: the findings store's safety net (findings-loop
 * design, decision 17). A Schedule runs it hourly on `steward-findings`, and
 * `steward finding sync` triggers the same Schedule on demand.
 *
 * **One rule** (STW-645, 2026-11-22). For every site folder in the findings
 * repository, every line of `INDEX.md` that should have a running workflow has
 * one after the pass, or is named in the result. `startMissingFindingRuns` does
 * a site in one activity: it reads the index, looks each such line's workflow
 * up by ID and starts the ones that are not running. `runNeeds` in
 * `lib/findings.ts` is the rule:
 *
 * - a `proposed` or `reopened` line, on every site. Its run waits at
 *   `waiting-verdict`;
 * - an `approved` line, on a site that goes past the verdict. Its run gets the
 *   line's verdict in its input (source `file`, so the run writes nothing),
 *   reads its settings and measures, then attempts the fix or parks at
 *   `waiting-fix`. Every such line gets a run, whatever `auto_fix` and the
 *   fixer's gate say: the run reads both itself, at once and then daily;
 * - an `approved` line on a site that stops at the verdict (`stop_after:
 *   verdict`, or no production origin on the worker) is skipped: its run ended
 *   there by design;
 * - every other line needs no workflow.
 *
 * The workflow lists no workflow through Visibility and sends no query, signal
 * or cancel. What the earlier rules did is done elsewhere, or not at all:
 *
 * | Earlier rule | Now |
 * |---|---|
 * | The `verdict` signal for a verdict found in a file | Retired. A verdict reaches a run by its `record-verdict` Update, and the run writes the file. A file edited by hand is not a verdict; `steward finding fix` still carries a file's approval to its run. |
 * | The `fix` signal for an approved run parked with no issue | The run reads its settings daily and attempts when `auto_fix` is on and the gate accepts (`findingWorkflow`, "Settings are read when they are used"). |
 * | The restart of an approved line with no run | The start rule, with the verdict in the input in place of a signal after the start. |
 * | The cancel of a run parked behind a `resolved` or `rejected` line | The run reads its file daily and ends `closed`, with an issue or without. |
 *
 * A run that took its approved verdict before `settings-at-use` shipped
 * (2026-11-21) reads nothing while it is parked: only a person's `fix`, or a
 * cancel, moves it. `steward finding status <key>` shows such a run's step and
 * its verdict's time.
 *
 * **The recheck and a parked run.** `recheckFindingsWorkflow` measures an
 * approved finding only when no run is open on it. On a site that goes past
 * the verdict every approved line now has an open run, so the daily recheck
 * skips them all there. What resolves such a finding in its file is its own
 * fix, or the inspector's verify; the parked run then reads `resolved` and
 * closes itself.
 *
 * **Nothing silent.** The result names the keys: `startedKeys` had no running
 * workflow until this pass, `blocked` have none and could not be given one (a
 * `proposed` line whose last run completed), and `failed` are the lines whose
 * lookup or start threw. One line never fails the pass. A pass with a `blocked`
 * or `failed` line pings `findings-reconcile` as failed, with the keys in the
 * summary; the same summary is the log line, and `steward finding sync` prints
 * the counts and the keys.
 *
 * A second run straight after the first starts nothing, which is the property
 * the design needs from a pass that runs every hour forever.
 *
 * **`reconcile-start-only`** (2026-11-22). The one rule replaces the list, the
 * index reads, the flag and gate reads, the per-line starts, the signals and
 * the cancels with one activity per site, so a run in flight when this shipped
 * would replay a different command sequence. A history without the marker
 * replays {@link reconcileBeforeStartOnly}, the earlier body kept whole. Only a
 * run in flight at the deploy is such a history: every run comes from the
 * Schedule, under its 15-minute execution timeout. `reconcile-all-rules-pre.bin`
 * in `tests/workflows/replay.test.ts` is one, recorded from `b262bd4`, and
 * `reconcile-start-only.bin` is a run with the marker; their docblocks hold the
 * probes. The earlier body, its three markers and their fixtures can be deleted
 * once no such run is open.
 *
 * The rest of this docblock describes the earlier body.
 *
 * For every site folder it read `INDEX.md` and compared it with the running
 * finding workflows:
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

/**
 * One site's counts. A pass on the start-only rule fills `started`, `running`,
 * `skipped`, `unchanged` and the three key lists. A result recorded before it
 * holds `signalled`, `fixed`, `restarted` and `closed` in their place.
 */
export interface SiteReconcileCounts {
  started: number;
  /** Lines whose workflow was already running. Absent from a result recorded before the start-only rule. */
  running?: number;
  /** Approved lines on a site that stops at the verdict. Absent from a result recorded before the start-only rule. */
  skipped?: number;
  /** The keys behind `started`. */
  startedKeys?: string[];
  /** Lines with no running workflow that could not be given one: a `proposed` line whose last run completed. */
  blocked?: string[];
  /** Lines whose lookup or start failed, with the reason. */
  failed?: Array<{ key: string; error: string }>;
  /** The earlier body: verdicts sent from the file. */
  signalled?: number;
  /** The earlier body: parked approved findings sent the `fix` signal. */
  fixed?: number;
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

/** A reconcile run recorded without this marker replays the earlier body: the list, the signals and the cancels. */
export const RECONCILE_START_ONLY_PATCH = 'reconcile-start-only';

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

// One site's pass: an index read, then a describe and at most a start per line that
// should have a run, about 175 calls on today's stores. Five minutes is room for a slow
// server; a retry repeats no start, because a line that was started reads as running.
const starting = wf.proxyActivities<Pick<typeof activities, 'startMissingFindingRuns'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '5 minutes',
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

/** The start-only pass: one activity per site, and nothing else. */
async function startOnly(input: ReconcileFindingsInput): Promise<ReconcileFindingsResult> {
  const sites = await reading.listSites(input.repo);
  const result: ReconcileFindingsResult = {};
  for (const site of sites) {
    const pass = await starting.startMissingFindingRuns({ repo: input.repo, site });
    result[site] = {
      started: pass.started.length,
      running: pass.running,
      skipped: pass.skipped,
      unchanged: pass.unchanged,
      startedKeys: pass.started,
      blocked: pass.blocked,
      failed: pass.failed,
    };
  }
  return result;
}

/** At most this many keys are named per list in a summary; the result holds them all. */
const SUMMARY_KEYS = 10;

function named(keys: string[]): string {
  if (keys.length === 0) return '';
  const shown = keys.slice(0, SUMMARY_KEYS).join(', ');
  return ` (${shown}${keys.length > SUMMARY_KEYS ? `, and ${keys.length - SUMMARY_KEYS} more` : ''})`;
}

/** Whether a start-only pass left a line with no workflow, or could not tell. */
export function reconcileNeedsAttention(result: ReconcileFindingsResult): boolean {
  return Object.values(result).some((c) => (c.blocked?.length ?? 0) > 0 || (c.failed?.length ?? 0) > 0);
}

/** The one line a start-only pass leaves in the log and the health ping. */
export function summariseStartOnly(result: ReconcileFindingsResult): string {
  const sites = Object.entries(result);
  if (sites.length === 0) return 'Findings reconcile: no site folders.';
  const parts = sites.map(([site, c]) => {
    const blocked = c.blocked ?? [];
    const failed = c.failed ?? [];
    return (
      `${site} started ${c.started}${named(c.startedKeys ?? [])}, running ${c.running ?? 0}, skipped ${c.skipped ?? 0}, ` +
      `blocked ${blocked.length}${named(blocked)}, failed ${failed.length}${named(failed.map((f) => `${f.key}: ${f.error}`))}, ` +
      `unchanged ${c.unchanged}`
    );
  });
  const attention = reconcileNeedsAttention(result)
    ? ' A blocked line has no running workflow and its last run completed: reopen the finding or correct the line. ' +
      'A failed line was not checked: the next pass tries it again.'
    : '';
  return `Findings reconcile: ${parts.join('; ')}.${attention}`;
}

/**
 * The body before the start-only rule, kept whole for a run in flight when it
 * shipped. Nothing here is changed: `reconcile-all-rules-pre.bin` and the three
 * older fixtures replay through it.
 */
async function reconcileBeforeStartOnly(input: ReconcileFindingsInput): Promise<{ result: ReconcileFindingsResult; stats: ListingStats }> {
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
    const counts = { started: 0, signalled: 0, fixed: 0, restarted: 0, closed: 0, unchanged: plan.unchanged };

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
    ([site, c]) => `${site} started ${c.started}, signalled ${c.signalled ?? 0}, fixed ${c.fixed ?? 0}, restarted ${c.restarted ?? 0}, closed ${c.closed ?? 0}, unchanged ${c.unchanged}`,
  );
  return `Findings reconcile: ${parts.join('; ')}. ${cost}`;
}

export async function reconcileFindingsWorkflow(input: ReconcileFindingsInput): Promise<ReconcileFindingsResult> {
  const startsOnly = wf.patched(RECONCILE_START_ONLY_PATCH);
  let result: ReconcileFindingsResult;
  let summary: string;
  try {
    if (startsOnly) {
      result = await startOnly(input);
      summary = summariseStartOnly(result);
    } else {
      const outcome = await reconcileBeforeStartOnly(input);
      result = outcome.result;
      summary = summarise(outcome.result, outcome.stats);
    }
  } catch (err) {
    await alerting.reportRunHealth({
      signal: 'findings-reconcile',
      shape: {
        ok: false,
        summary: startsOnly
          ? `Findings reconcile against ${input.repo} failed: ${describeError(err)}. The sites after the ` +
            'failure point were not checked, so a finding filed since the last good run may have no ' +
            'workflow until the next one. The workflow history in Temporal Cloud names the failing step.'
          : `Findings reconcile against ${input.repo} failed: ${describeError(err)}. No finding ` +
            'workflow was started or signalled after the failure point, so a verdict given in ' +
            'Discord or Obsidian waits for the next good run. The workflow history in Temporal ' +
            'Cloud names the failing step.',
      },
    });
    throw err;
  }

  // The one-line counts, not the result object: this runs hourly, and the
  // result stays in the return value. A log line is not a command, so no marker.
  wf.log.info(summary);
  // A blocked or failed line is a finding with no workflow, or one nobody could check: the
  // ping fails so the alerting service says so, and the run itself completes with the keys.
  const ok = !(startsOnly && reconcileNeedsAttention(result));
  await alerting.reportRunHealth({ signal: 'findings-reconcile', shape: { ok, summary } });
  return result;
}
