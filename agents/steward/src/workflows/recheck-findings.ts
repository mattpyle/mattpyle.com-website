import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import { findingWorkflowId, type Verification } from '../lib/findings.js';
import {
  summariseRecheck,
  vancouverDay,
  type RecheckFindingsInput,
  type RecheckFindingsResult,
  type RecheckRow,
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
 *   America/Vancouver, the checks ran;
 * - **resolved**: every check passed. The file is resolved through
 *   `setFindingVerification`, with its Verification section, and its index
 *   line reads `resolved`, in one commit.
 *
 * It opens no fix and starts no workflow: a recheck records what production
 * serves and nothing else. A write that fails is reported as `write failed`
 * and the run goes on, so one finding cannot stop the site's recheck.
 *
 * **Replay.** A new workflow type: no run recorded before it exists, so it
 * carries no `patched` marker.
 *
 * **No health ping yet.** Its healthchecks.io check does not exist; adding the
 * ping is a follow-up.
 */

const QUEUE_FINDINGS = 'steward-findings';

const reading = wf.proxyActivities<
  Pick<typeof activities, 'readSiteHosts' | 'readFindingsIndex' | 'listOpenFindingWorkflows' | 'readRecheckBlock'>
>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['AuthError', 'NotFound', 'StoreLayout', 'SiteConfigInvalid', 'FindingMissing'] },
});

// Twelve browser checks at a 30-second load and a 10-second settle each is
// eight minutes; the timeout leaves room for Chrome's launch.
const checking = wf.proxyActivities<Pick<typeof activities, 'runFindingChecks'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 2, initialInterval: '30 seconds', nonRetryableErrorTypes: ['VerifyCheckBroken'] },
});

const writing = wf.proxyActivities<Pick<typeof activities, 'writeFindingRecheck'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, nonRetryableErrorTypes: ['AuthError', 'FindingMoved', 'FindingMissing', 'FindingMalformed', 'BadInput'] },
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
  const at = new Date(Date.now()).toISOString();
  const { workflowId } = wf.workflowInfo();
  const { origin, hosts } = await reading.readSiteHosts({ repo: input.repo, site: input.site });
  const index = await reading.readFindingsIndex(input.repo, input.site);
  const open = new Set((await reading.listOpenFindingWorkflows()).map((run) => (typeof run === 'string' ? run : run.workflowId)));

  const rows: RecheckRow[] = [];
  for (const line of index.filter((entry) => entry.status === 'approved')) {
    const key = line.key;
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

  const result: RecheckFindingsResult = { site: input.site, at, rows };
  wf.log.info(summariseRecheck(result), { rows });
  return result;
}
