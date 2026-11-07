import type { Client } from '@temporalio/client';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import {
  ARGUS_REPO,
  FINDINGS_DEFAULT_SITE,
  FINDINGS_SCHEDULE_ID,
  NAMESPACE,
  PROD_ORIGIN,
  QUEUE_FINDINGS,
  WEB_UI,
} from '../config.js';
import { readFinding, writeFindingReturned } from '../activities/findings.js';
import { FixRefused, requestFix, type FixRequested } from './finding-fix.js';
import { LIFECYCLE_CANCEL_WAIT_MS, VerifyRefused, buildVerifyInput, cancelLifecycleRun, verifyFindingPaths, type LifecycleRunClosed } from './finding-verify.js';
import { gh } from './github.js';
import {
  findingWorkflowId,
  fixPrUrl,
  fixRefusal,
  parseFindingBody,
  parsePrUrl,
  verifyRefusal,
  verifyWorkflowId,
} from './findings.js';
import type { ReconcileFindingsResult, SiteReconcileCounts } from '../workflows/reconcile-findings.js';
import { verifyFindingWorkflow, type VerifyFindingResult } from '../workflows/verify-finding.js';

/**
 * The three verbs the console runs from its page beside the CLI: `steward finding
 * sync`, `fix` and `verify`. Each verb and its button call the functions here, so
 * the two cannot drift. The pattern is `finding-verdict.ts`: nothing here prints
 * or exits, and a refusal is an error whose message the operator can act on.
 *
 * It also holds the gates the page uses to offer a button ({@link fixOffered},
 * {@link verifyOffered}): the same refusals the verbs apply, so the page never
 * offers what the CLI would refuse.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const runLink = (workflowId: string) => `${WEB_UI}/namespaces/${NAMESPACE}/workflows/${encodeURIComponent(workflowId)}`;

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

/** The slice of the Schedule handle `sync` uses. `client.schedule.getHandle(...)` satisfies it. */
export interface SyncScheduleHandle {
  describe(): Promise<{
    info: {
      numActionsTaken: number;
      numActionsSkippedOverlap: number;
      recentActions: { action: { type: string; workflow?: { workflowId: string; firstExecutionRunId: string } } }[];
    };
  }>;
  trigger(overlap?: ScheduleOverlapPolicy): Promise<void>;
}

export interface SyncClient {
  schedule: { getHandle(scheduleId: string): SyncScheduleHandle };
  workflow: { getHandle(workflowId: string, runId?: string): { result(): Promise<unknown> } };
}

export interface SyncResult {
  /** False when a reconcile was already running, so the trigger started none. */
  triggered: boolean;
  /** The reconcile run's workflow id; null when none was started. */
  workflowId: string | null;
  /** The plan counts per site; null when the run did not finish in the wait. */
  sites: ReconcileFindingsResult | null;
  /** The counts summed over every site. */
  total: SiteReconcileCounts | null;
}

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

export function totalCounts(sites: ReconcileFindingsResult): SiteReconcileCounts {
  const total = { started: 0, signalled: 0, fixed: 0, restarted: 0, unchanged: 0 };
  for (const counts of Object.values(sites)) {
    total.started += counts.started ?? 0;
    total.signalled += counts.signalled ?? 0;
    total.fixed += counts.fixed ?? 0;
    total.restarted += counts.restarted ?? 0;
    total.unchanged += counts.unchanged ?? 0;
  }
  return total;
}

/**
 * Runs the findings reconcile now and waits for its plan counts. The trigger is
 * the Schedule's own, with overlap SKIP: a reconcile already in flight is left
 * alone and `triggered` is false. The schedule's description names the run the
 * trigger started, so the counts are that run's own result.
 */
export async function syncFindings(
  client: SyncClient,
  options: { pickUpMs?: number; resultMs?: number; pollMs?: number } = {},
): Promise<SyncResult> {
  const pickUpMs = options.pickUpMs ?? 15_000;
  const resultMs = options.resultMs ?? 90_000;
  const pollMs = options.pollMs ?? 500;
  const schedule = client.schedule.getHandle(FINDINGS_SCHEDULE_ID);
  const before = (await schedule.describe()).info;
  await schedule.trigger(ScheduleOverlapPolicy.SKIP);

  const deadline = Date.now() + pickUpMs;
  let started: { workflowId: string; runId: string } | null = null;
  for (;;) {
    const { info } = await schedule.describe();
    if (info.numActionsTaken > before.numActionsTaken) {
      const action = info.recentActions[info.recentActions.length - 1]?.action;
      if (action?.workflow) started = { workflowId: action.workflow.workflowId, runId: action.workflow.firstExecutionRunId };
      break;
    }
    if (info.numActionsSkippedOverlap > before.numActionsSkippedOverlap) {
      return { triggered: false, workflowId: null, sites: null, total: null };
    }
    if (Date.now() > deadline) {
      throw new SyncError(`The schedule did not report a run within ${pickUpMs / 1000}s. Is the Schedule paused or missing? \`steward finding schedule describe\` shows it.`);
    }
    await sleep(pollMs);
  }
  if (!started) throw new SyncError('The schedule started a run but did not name it.');

  const handle = client.workflow.getHandle(started.workflowId, started.runId);
  const sites = await Promise.race([
    handle.result() as Promise<ReconcileFindingsResult>,
    sleep(resultMs).then(() => null),
  ]);
  return { triggered: true, workflowId: started.workflowId, sites, total: sites ? totalCounts(sites) : null };
}

/** The one sentence for a sync's counts. */
export function syncSummary(result: SyncResult): string {
  if (!result.triggered) return 'A reconcile is already running, so none was started.';
  if (!result.total) return 'The reconcile is running and has not finished. Refresh in a minute.';
  const t = result.total;
  return `Started ${t.started}, signalled ${t.signalled}, fixed ${t.fixed}, restarted ${t.restarted ?? 0}, unchanged ${t.unchanged}.`;
}

// ---------------------------------------------------------------------------
// fix
// ---------------------------------------------------------------------------

/** Where a PR stands on GitHub, for `fix`, `verify` and `verify --pr`. */
export async function readPrState(prUrl: string): Promise<'open' | 'merged' | 'closed'> {
  const pr = parsePrUrl(prUrl) as { repo: string; number: number };
  const data = await gh(`/repos/${pr.repo}/pulls/${pr.number}`);
  return data.merged === true ? 'merged' : data.state === 'closed' ? 'closed' : 'open';
}

/**
 * Asks for the fix: finds or starts the finding's lifecycle run and sends it
 * `fix`. It returns once the signal is sent; {@link FixRefused} carries a refusal.
 * `say` receives the lines the CLI prints as the request proceeds.
 */
export function requestFindingFix(client: Client, site: string, key: string, say: (line: string) => void): Promise<FixRequested> {
  return requestFix(
    {
      client,
      repo: ARGUS_REPO,
      taskQueue: QUEUE_FINDINGS,
      origin: site === FINDINGS_DEFAULT_SITE ? PROD_ORIGIN : undefined,
      readFinding: (p) => readFinding(ARGUS_REPO, p),
      readPr: readPrState,
      returnFinding: writeFindingReturned,
      say,
    },
    site,
    key,
  );
}

/** What the CLI prints after `fix` has named the run. */
export const FIX_NEXT_STEP = 'It opens an issue for claude-code-action, then waits for its PR, the merge, the deploy and the verify.';

export interface FixStarted {
  workflowId: string;
  webUrl: string;
  nextStep: string;
}

export function fixStarted(requested: FixRequested): FixStarted {
  const workflowId = requested.lifecycle.workflowId;
  return { workflowId, webUrl: runLink(workflowId), nextStep: FIX_NEXT_STEP };
}

/**
 * Whether the page offers Fix: an approved finding on a site with a fixer and
 * a known production origin, that `fixRefusal` accepts, and whose run is
 * absent or parked. A parked run is open at `waiting-fix` with no issue: it
 * waits for a `fix` signal, which `requestFix` sends. A run with an issue is
 * past the gate and mid-fix, or its fix ended and `steward finding fix`
 * retries it; the page leaves that one to the CLI as it always did.
 */
export function fixOffered(input: {
  site: string;
  status: string;
  runOpen: boolean;
  /** The open run's `state.step`, when the loader asked. */
  runStep?: string | null;
  /** The open run's fix issue, when the loader asked. */
  issueUrl?: string | null;
  stopAfter: string | null;
  data: Record<string, unknown>;
  text: string;
}): boolean {
  if (input.status !== 'approved') return false;
  if (input.runOpen && !(input.runStep === 'waiting-fix' && !input.issueUrl)) return false;
  if (input.site !== FINDINGS_DEFAULT_SITE || input.stopAfter === 'verdict') return false;
  return fixRefusal(input.data, parseFindingBody(input.text)) === null;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * Whether the page offers Verify: the verifier's gate accepts the finding, and
 * its PR is merged. `prMerged` is asked only when the gate has accepted.
 */
export async function verifyOffered(
  input: { site: string; data: Record<string, unknown> },
  prMerged: (prUrl: string) => Promise<boolean>,
): Promise<boolean> {
  if (input.site !== FINDINGS_DEFAULT_SITE || input.data.status !== 'fixing') return false;
  if (verifyRefusal(input.data) !== null) return false;
  const prUrl = fixPrUrl(input.data);
  return parsePrUrl(prUrl) !== null && (await prMerged(prUrl));
}

export interface VerifyStarted {
  workflowId: string;
  input: ReturnType<typeof buildVerifyInput>;
  /** The Temporal handle, for {@link finishVerify}. */
  handle: Awaited<ReturnType<Client['workflow']['start']>>;
}

/**
 * The refusals `verify` applies before it starts a run: the site's origin is
 * known, and the finding passes the verifier's gate with its PR merged. The
 * verifier applies the same gate, but only after a run has started and failed.
 */
export async function verifyPrecondition(site: string, key: string, root?: string): Promise<void> {
  // The origin is this site's. Another site's would ride in its own config.
  if (site !== FINDINGS_DEFAULT_SITE) {
    throw new VerifyRefused(`verify knows the production origin of ${FINDINGS_DEFAULT_SITE} only, not ${site}.`);
  }
  const { data } = await readFinding(ARGUS_REPO, verifyFindingPaths(site, key, root).findingPath);
  const refusal = verifyRefusal(data);
  if (refusal) throw new VerifyRefused(`${key} is not verified: ${refusal}.`);
  const prUrl = fixPrUrl(data);
  if (!parsePrUrl(prUrl)) throw new VerifyRefused(`${key} has no links.pr to a pull request, so its fix is not known to be live.`);
  const state = await readPrState(prUrl);
  if (state !== 'merged') throw new VerifyRefused(`${prUrl} is ${state}, not merged, so its fix is not on production.`);
}

/**
 * Starts one verify run and returns at once with its workflow id. The input is
 * resolved HERE and frozen into the workflow (design rule 10): the repository,
 * the paths, the origin and the instant the ID is stamped with. A `root` puts
 * the paths under a scratch copy, and the finding's lifecycle run is then left
 * alone: it belongs to the real finding, not the copy.
 */
export async function startVerify(
  client: Client,
  site: string,
  key: string,
  options: { reason?: string; root?: string } = {},
): Promise<VerifyStarted> {
  await verifyPrecondition(site, key, options.root);
  const at = new Date().toISOString();
  const input = buildVerifyInput({ site, key, repo: ARGUS_REPO, origin: PROD_ORIGIN, at, reason: options.reason, root: options.root });
  const workflowId = verifyWorkflowId(site, key, at);
  const handle = await client.workflow.start(verifyFindingWorkflow, { workflowId, taskQueue: QUEUE_FINDINGS, args: [input] });
  return { workflowId, input, handle };
}

export interface VerifyFinished {
  result: VerifyFindingResult;
  /** What happened to the finding's lifecycle run; null when the verify left it alone. */
  lifecycle: { id: string; closed: LifecycleRunClosed } | null;
}

/**
 * The end of a verify: waits for the run's result, and after `resolved` or
 * `confirmed` closes the finding's own lifecycle run, which has nothing left
 * to do. A scratch copy touches no lifecycle run.
 */
export async function finishVerify(client: Client, site: string, key: string, started: VerifyStarted): Promise<VerifyFinished> {
  const result = (await started.handle.result()) as VerifyFindingResult;
  if (started.input.findingPath !== verifyFindingPaths(site, key).findingPath) return { result, lifecycle: null };
  if (result.outcome !== 'resolved' && result.outcome !== 'confirmed') return { result, lifecycle: null };
  const lifecycle = client.workflow.getHandle(findingWorkflowId(site, key));
  return { result, lifecycle: { id: lifecycle.workflowId, closed: await cancelLifecycleRun(lifecycle, LIFECYCLE_CANCEL_WAIT_MS) } };
}

export interface VerifyLaunched {
  workflowId: string;
  webUrl: string;
  nextStep: string;
}

/**
 * The console's verify: {@link startVerify}, answered at once, and
 * {@link finishVerify} left running in the background. `onDone` receives the
 * outcome or the failure, since no request is waiting for it.
 */
export async function launchVerify(
  client: Client,
  site: string,
  key: string,
  onDone: (outcome: { workflowId: string; finished?: VerifyFinished; error?: unknown }) => void,
): Promise<VerifyLaunched> {
  const started = await startVerify(client, site, key);
  finishVerify(client, site, key, started).then(
    (finished) => onDone({ workflowId: started.workflowId, finished }),
    (error: unknown) => onDone({ workflowId: started.workflowId, error }),
  );
  return {
    workflowId: started.workflowId,
    webUrl: runLink(started.workflowId),
    nextStep: 'Production is being measured. The finding is written resolved or reopened when the run ends: refresh to see it.',
  };
}

export { FixRefused, VerifyRefused };
