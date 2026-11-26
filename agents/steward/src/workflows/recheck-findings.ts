import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import { findingWorkflowId, listedRuns, type Verification } from '../lib/findings.js';
import { findingsRecheckSignal, recheckShape } from '../lib/run-health.js';
import {
  judgeWatch,
  summariseRecheck,
  vancouverDay,
  type RecheckFindingsInput,
  type RecheckFindingsResult,
  type RecheckRow,
  type WatchRun,
} from '../lib/findings-recheck.js';

export type { RecheckFindingsInput, RecheckFindingsResult } from '../lib/findings-recheck.js';

/**
 * `recheckFindingsWorkflow` (STW-543): a site's approved findings, measured
 * again on production, on every host the site declares.
 *
 * A daily Schedule per site starts it on `steward-findings`, and
 * `steward finding recheck --site <site>` starts one run on demand. It reads
 * the site's origin and `site.hosts` from its `config.yaml`, then takes every
 * `approved` line of `INDEX.md`, one at a time. Each finding gets one outcome:
 *
 * - **has an open run**: a `findingWorkflow` is open on it. That run owns the
 *   file (an approved mattpyle.com finding can wait at `waiting-fix`), and a
 *   recheck that resolved the file under it would race it. Nothing measured;
 * - **skipped**: the file no longer reads approved with no `resolved_run`;
 * - **no checks**: no `verify` key, or an empty list. Nothing written;
 * - **could not measure**: production answered 5xx or not at all, a check's
 *   own expression did not run, or the block was refused by the host rule or
 *   the schema. Nothing written;
 * - **still present**: a check failed. `live_on` is set to the day, in
 *   America/Vancouver, the checks ran, and `live_by` is set to `check`;
 * - **resolved**: every check passed. The file is resolved through
 *   `setFindingVerification`, with its Verification section, and its index
 *   line reads `resolved`, in one commit.
 *
 * It opens no fix and starts no workflow: a recheck records what production
 * serves and nothing else. A write that fails is reported as `write failed`
 * and the run goes on, so one finding cannot stop the site's recheck.
 *
 * **A site that watches (STW-678).** There each approved finding's own run
 * measures it (`watchFinding`), and the recheck is the alarm for those runs.
 * It measures nothing and writes nothing. `readSiteHosts` says whether the site
 * watches; then each approved line's workflow is read by ID (`readWatchRun`):
 *
 * - **watching**: the last attempt is under 26 hours old, and its failure, if
 *   any, is `StillPresent` or `NoChecks`;
 * - **watch stale**: it is 26 hours old or more (`judgeWatch` says how an
 *   attempt is aged);
 * - **watch broken**: the last failure is any other type;
 * - **not watching**: the run is open with no pending `watchFinding`, still so
 *   when read again after {@link WATCH_SECOND_READ_DELAY}. The row names the
 *   run's step. One wait covers every such run;
 * - **no run**: no open run, and the file still reads approved and unresolved;
 * - **skipped**: no open run, and it does not. A run that resolved its finding
 *   after the index was read is not a missing one.
 *
 * **How late the alarm is.** A watch window opens at 13:20 UTC, spread over 20
 * minutes. The daily recheck starts at 06:20 America/Vancouver: 13:20 UTC while
 * Vancouver is at UTC-7, 14:20 UTC at UTC-8. At the recheck on the day a window
 * is missed, the last attempt is at most about 25 hours old and reads as
 * `watching`. The next day's recheck reports it, about a day after the miss.
 *
 * **Replay.** A new workflow type: no run recorded before it exists, so it
 * carries no `patched` marker.
 *
 * **Health (STW-549).** Every run pings `findings-recheck:<site>`, so a recheck
 * that stops running goes late at the alerting service (period 1 day, grace 1
 * hour). A run that throws pings `/fail` with the reason. A run that completes
 * pings what `recheckShape` decides: `/fail` when any row is `write failed`,
 * `could not measure`, `watch stale`, `watch broken`, `not watching` or
 * `no run`, success otherwise, the run's one-line summary starting the body
 * either way.
 * The check for a site is created by hand at the service under the slug
 * `steward-findings-recheck-<site>`.
 *
 * **Quiet completion log.** The run ends with its one-line summary at info
 * level and nothing else. The rows stay in the workflow result, which the CLI
 * prints, so the log carries no result object.
 *
 * **Replay of the `live_by` write (ARG-54).** No marker. `setFrontmatterLiveOn`
 * (the activity's pure helper) writes `live_by: check` beside `live_on`, so the
 * workflow issues the same commands with the same inputs and no recorded
 * history changes. Determinism rule 5 in `agents/steward/CLAUDE.md`.
 *
 * **Replay of runs open before STW-549.** Only an open run replays, and it has
 * not yet issued its last command. The ping is one activity call after the
 * last command such a history holds, so the history ends before it and the new
 * call is simply the next command. The log line is not a command. An open
 * scheduled run therefore replays without a `patched` marker.
 *
 * **Replay of the watch read (STW-678).** No marker. The new path is taken only
 * when the recorded result of `readSiteHosts` says `watch: true`. A result
 * recorded before it has no field and reads as false, so such a run issues the
 * commands it issued before, whatever the site's config says now
 * (determinism rules 1, 3 and 5). `recheck-findings-watch-pre.bin` holds that
 * case, and `recheck-findings-watching.bin` the new path.
 */

const QUEUE_FINDINGS = 'steward-findings';

/** How long a watch site's run with no pending `watchFinding` gets before its second read. */
const WATCH_SECOND_READ_DELAY = '30 seconds';

const reading = wf.proxyActivities<
  Pick<typeof activities, 'readSiteHosts' | 'readFindingsIndex' | 'listOpenFindingWorkflows' | 'readRecheckBlock' | 'readWatchRun'>
>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['AuthError', 'NotFound', 'StoreLayout', 'SiteConfigInvalid', 'FindingMissing'] },
});

// Twelve browser checks at a 30-second load and a 10-second settle each is
// eight minutes; the timeout leaves room for Chrome's launch.
// The heartbeat timeout turns a worker that died mid-run into a retry in 30
// seconds, not at the start-to-close timeout. No `patched` marker: it is an
// attribute of the same schedule command, and the history recorded before it
// (`recheck-findings-pre-heartbeat.bin`) replays unchanged (determinism rule 5).
const checking = wf.proxyActivities<Pick<typeof activities, 'runFindingChecks'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2, initialInterval: '30 seconds', nonRetryableErrorTypes: ['VerifyCheckBroken'] },
});

const writing = wf.proxyActivities<Pick<typeof activities, 'writeFindingRecheck'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, nonRetryableErrorTypes: ['AuthError', 'FindingMoved', 'FindingMissing', 'FindingMalformed', 'BadInput'] },
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

export async function recheckFindingsWorkflow(input: RecheckFindingsInput): Promise<RecheckFindingsResult> {
  let result: RecheckFindingsResult;
  try {
    result = await recheck(input);
  } catch (err) {
    await alerting.reportRunHealth({
      signal: findingsRecheckSignal(input.site),
      shape: {
        ok: false,
        summary:
          `Findings recheck of ${input.site} against ${input.repo} failed: ${describeError(err)}. ` +
          'Findings after the failure point were not rechecked, and the next daily run starts again. ' +
          'The workflow history in Temporal Cloud names the failing step.',
      },
    });
    throw err;
  }

  wf.log.info(summariseRecheck(result));
  await alerting.reportRunHealth({ signal: findingsRecheckSignal(input.site), shape: recheckShape(result) });
  return result;
}

async function recheck(input: RecheckFindingsInput): Promise<RecheckFindingsResult> {
  const at = new Date(Date.now()).toISOString();
  const { workflowId } = wf.workflowInfo();
  const { origin, hosts, watch } = await reading.readSiteHosts({ repo: input.repo, site: input.site });
  const index = await reading.readFindingsIndex(input.repo, input.site);
  const approved = index.filter((entry) => entry.status === 'approved').map((entry) => entry.key);
  // `=== true`: a result recorded before the field has none.
  if (watch === true) return { site: input.site, at, rows: await readWatches(input, approved, { origin, hosts }) };
  // Only the IDs are read, so no `state` query is worth its cost.
  const open = new Set(listedRuns(await reading.listOpenFindingWorkflows({ idsOnly: true })).map((run) => (typeof run === 'string' ? run : run.workflowId)));

  const rows: RecheckRow[] = [];
  for (const key of approved) {
    if (open.has(findingWorkflowId(input.site, key))) {
      rows.push({ key, outcome: 'has an open run', detail: `${findingWorkflowId(input.site, key)} owns the file` });
      continue;
    }
    const block = await reading.readRecheckBlock({ repo: input.repo, site: input.site, key, origin, hosts });
    const short = block.keyShort ? { keyShort: block.keyShort } : {};
    if (block.state === 'skip') {
      rows.push({ key, ...short, outcome: 'skipped', detail: block.reason });
      continue;
    }
    if (block.state === 'none') {
      rows.push({ key, ...short, outcome: 'no checks' });
      continue;
    }
    if (block.state === 'refused') {
      rows.push({ key, ...short, outcome: 'could not measure', detail: `the block was refused: ${block.problems.join('; ')}` });
      continue;
    }

    let run;
    try {
      run = await checking.runFindingChecks({ key, checks: block.checks });
    } catch (err) {
      rows.push({ key, ...short, outcome: 'could not measure', detail: describeError(err) });
      continue;
    }

    try {
      if (run.passed) {
        const verification: Verification = {
          status: 'resolved',
          at: run.ranAt,
          workflowId,
          source: 'finding',
          rows: run.results,
        };
        const written = await writing.writeFindingRecheck({ repo: input.repo, site: input.site, key, verification });
        rows.push({ key, ...short, outcome: 'resolved', detail: `${run.results.length} of ${run.results.length} checks pass`, commitSha: written.commitSha });
      } else {
        const day = vancouverDay(run.ranAt);
        const written = await writing.writeFindingRecheck({ repo: input.repo, site: input.site, key, liveOn: day });
        const failed = run.results.filter((row) => !row.pass).map((row) => `check ${row.n}: ${row.measured}`);
        rows.push({ key, ...short, outcome: 'still present', detail: `live_on ${day}; ${failed.join('; ')}`, commitSha: written.commitSha });
      }
    } catch (err) {
      rows.push({ key, ...short, outcome: 'write failed', detail: describeError(err) });
    }
  }

  return { site: input.site, at, rows };
}

/** The rows of a site that watches: each approved finding's run, read from Temporal by ID. */
async function readWatches(
  input: RecheckFindingsInput,
  keys: string[],
  site: { origin: string; hosts: string[] },
): Promise<RecheckRow[]> {
  const read = (key: string) => reading.readWatchRun({ workflowId: findingWorkflowId(input.site, key) });
  const runs = new Map<string, WatchRun>();
  for (const key of keys) runs.set(key, await read(key));

  const unsure = keys.filter((key) => {
    const run = runs.get(key)!;
    return run.state === 'open' && !run.pending;
  });
  if (unsure.length > 0) {
    await wf.sleep(WATCH_SECOND_READ_DELAY);
    for (const key of unsure) runs.set(key, await read(key));
  }

  const rows: RecheckRow[] = [];
  for (const key of keys) {
    const run = runs.get(key)!;
    if (run.state === 'open') {
      rows.push(
        run.pending
          ? { key, ...judgeWatch(run.pending, Date.now()) }
          : { key, outcome: 'not watching', detail: `the run is open at ${run.step ?? 'an unknown step'} with no pending watchFinding` },
      );
      continue;
    }
    const block = await reading.readRecheckBlock({ repo: input.repo, site: input.site, key, ...site });
    const short = block.keyShort ? { keyShort: block.keyShort } : {};
    rows.push(
      block.state === 'skip'
        ? { key, ...short, outcome: 'skipped', detail: block.reason }
        : { key, ...short, outcome: 'no run', detail: `no open ${findingWorkflowId(input.site, key)}` },
    );
  }
  return rows;
}
