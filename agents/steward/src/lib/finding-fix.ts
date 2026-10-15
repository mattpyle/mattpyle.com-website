import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
  type WorkflowHandle,
} from '@temporalio/client';
import {
  findingHandoffPath,
  findingPath,
  findingWorkflowId,
  findingsIndexPath,
  fixBranch,
  fixPrUrl,
  fixWorkflowId,
  parsePrUrl,
  type FindingVerdict,
} from './findings.js';
import {
  findingStateQuery,
  fixSignal,
  verdictSignal,
  type FindingState,
  type FindingWorkflowInput,
} from '../workflows/finding.js';
import { fixFindingStateQuery, type FixFindingResult } from '../workflows/fix-finding.js';

/**
 * `steward finding fix`, the one fix path: every fix runs as the child of a
 * `findingWorkflow` started with `stopAfter: 'resolved'` (standalone-fix-closed-pr,
 * decision 1). That parent writes `approved` back when the PR closes unmerged,
 * and waits for the merge, the deploy and the verify when it merges, so no fix
 * is left at `fixing` with nothing watching its PR.
 *
 * {@link requestFix} finds or makes that parent and sends it `fix`:
 *
 * 1. An open `'resolved'` run is used as it is.
 * 2. Otherwise the finding file decides. `approved` is fixable. `fixing` whose
 *    PR closed unmerged is first returned to `approved` with the lifecycle's own
 *    write. Anything else is refused with the reason.
 * 3. An open run that stops at `'verdict'` gives way: it is cancelled, as the
 *    adoption batch cancelled the backlog's, and a `'resolved'` run replaces it.
 * 4. A new run gets the file's verdict with source `file`, so it writes nothing.
 * 5. `fix` is sent only once the run reports `waiting-fix`, so it never races
 *    the verdict (finding-early-fix-signal).
 *
 * Nothing here starts `fixFindingWorkflow`. {@link followFix} only watches the
 * child the parent started.
 */

export interface FindingFixDeps {
  client: Client;
  /** `owner/name` of the findings repository. */
  repo: string;
  /** The task queue `findingWorkflow` runs on. */
  taskQueue: string;
  /** The site's production origin, or undefined for a site Steward knows none for. */
  origin: string | undefined;
  /** The finding file's frontmatter, from the findings repository. */
  readFinding: (path: string) => Promise<Record<string, unknown>>;
  /** Where the fixer's PR stands on GitHub. */
  readPr: (prUrl: string) => Promise<'open' | 'merged' | 'closed'>;
  /** `writeFindingReturned`: `status: approved` back, with the closed PR named. */
  returnFinding: (input: {
    repo: string;
    site: string;
    key: string;
    findingPath: string;
    indexPath: string;
    prUrl: string;
    at: string;
  }) => Promise<{ commitSha: string | null }>;
  /** One line of operator output. */
  say: (line: string) => void;
  /** How long to wait for a run to reach `waiting-fix`. */
  waitMs?: number;
  pollMs?: number;
}

/** A refusal the operator can act on; the CLI prints the message alone. */
export class FixRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixRefused';
  }
}

export interface FixRequested {
  lifecycle: WorkflowHandle;
  /** True when this call started the lifecycle run. */
  started: boolean;
  /** The closed PR when this call returned the finding from `fixing`. */
  returnedFrom: string | null;
  /** True when an open run that stopped at the verdict was cancelled for it. */
  replacedVerdictRun: boolean;
  /** The fix child's run before the signal, so {@link followFix} knows the new one. */
  priorFixRunId: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function describeOpen(handle: WorkflowHandle): Promise<boolean> {
  try {
    return (await handle.describe()).status.name === 'RUNNING';
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return false;
    throw err;
  }
}

async function runId(handle: WorkflowHandle): Promise<string | null> {
  try {
    return (await handle.describe()).runId;
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return null;
    throw err;
  }
}

/** The run's state, retried while a just-started run has no worker answer yet. */
async function queryState(handle: WorkflowHandle, deadline: number, pollMs: number): Promise<FindingState> {
  for (;;) {
    try {
      return await handle.query(findingStateQuery);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(pollMs);
    }
  }
}

/**
 * The file's case for a finding with no lifecycle run: fixable as it stands,
 * fixable after its closed PR returns it, or refused.
 */
async function prepareFromFile(deps: FindingFixDeps, site: string, key: string): Promise<{ verdict: FindingVerdict; returnedFrom: string | null }> {
  const path = findingPath(site, key);
  let data = await deps.readFinding(path);
  let returnedFrom: string | null = null;

  if (data.status === 'fixing') {
    const prUrl = fixPrUrl(data);
    if (!parsePrUrl(prUrl)) throw new FixRefused(`${key} is fixing with no links.pr to a pull request.`);
    const pr = await deps.readPr(prUrl);
    if (pr === 'open') throw new FixRefused(`${key} is fixing and ${prUrl} is still open. Merge or close it first.`);
    if (pr === 'merged') {
      throw new FixRefused(`${key} is fixing and ${prUrl} merged. \`steward finding verify ${key}\` closes it.`);
    }
    const returned = await deps.returnFinding({
      repo: deps.repo,
      site,
      key,
      findingPath: path,
      indexPath: findingsIndexPath(site),
      prUrl,
      at: new Date().toISOString(),
    });
    deps.say(`returned ${key} to approved: ${prUrl} closed unmerged (commit ${returned.commitSha ?? 'none, already returned'})`);
    returnedFrom = prUrl;
    data = await deps.readFinding(path);
  }

  if (data.status !== 'approved') {
    throw new FixRefused(`${key} cannot be fixed: its status is ${String(data.status ?? 'unset')}, not approved.`);
  }
  // The child's own gate refuses anything else; refused here, no run is left
  // open waiting for a fix that can never start.
  if (data.kind !== 'defect') {
    throw new FixRefused(`${key} does not go to the fixer: its kind is ${String(data.kind ?? 'unset')}, not defect.`);
  }
  const verdict: FindingVerdict = {
    status: 'approved',
    reason: typeof data.verdict_reason === 'string' ? data.verdict_reason : '',
    source: 'file',
    at: typeof data.verdict_at === 'string' ? data.verdict_at : new Date().toISOString(),
  };
  return { verdict, returnedFrom };
}

export async function requestFix(deps: FindingFixDeps, site: string, key: string): Promise<FixRequested> {
  const waitMs = deps.waitMs ?? 60_000;
  const pollMs = deps.pollMs ?? 1000;
  const id = findingWorkflowId(site, key);
  const fixHandle = deps.client.workflow.getHandle(fixWorkflowId(site, key));

  let lifecycle: WorkflowHandle | undefined = deps.client.workflow.getHandle(id);
  let verdictRun: WorkflowHandle | undefined;
  if (await describeOpen(lifecycle)) {
    const state = await queryState(lifecycle, Date.now() + waitMs, pollMs);
    if ((state.stopAfter ?? 'verdict') !== 'resolved') {
      verdictRun = lifecycle;
      lifecycle = undefined;
    }
  } else {
    lifecycle = undefined;
  }

  let started = false;
  let returnedFrom: string | null = null;
  if (!lifecycle) {
    if (!deps.origin) {
      throw new FixRefused(`Steward knows no production origin for ${site}, so a fix could not be verified.`);
    }
    if (await describeOpen(fixHandle)) {
      throw new FixRefused(`${fixHandle.workflowId} is already running.`);
    }
    const prepared = await prepareFromFile(deps, site, key);
    returnedFrom = prepared.returnedFrom;

    if (verdictRun) {
      // The adoption batch's rule: a run that stops at the verdict gives way to
      // one that runs the lifecycle. The file holds the verdict, so nothing is lost.
      await verdictRun.cancel();
      await verdictRun.result().catch(() => undefined);
      deps.say(`cancelled ${id}: it stopped at the verdict, and a lifecycle run replaces it`);
    }

    const input: FindingWorkflowInput = {
      site,
      key,
      repo: deps.repo,
      findingPath: findingPath(site, key),
      indexPath: findingsIndexPath(site),
      stopAfter: 'resolved',
      handoffPath: findingHandoffPath(site, key),
      branch: fixBranch(key),
      origin: deps.origin,
    };
    try {
      // ALLOW_DUPLICATE, unlike the reconciler's FAILED_ONLY: the file was just
      // read as approved, so a completed run before this one is history, not a
      // decision to protect.
      lifecycle = await deps.client.workflow.start('findingWorkflow', {
        workflowId: id,
        taskQueue: deps.taskQueue,
        args: [input],
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      });
      started = true;
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      // The reconciler started one between the read and the start.
      lifecycle = deps.client.workflow.getHandle(id);
    }
    await lifecycle.signal(verdictSignal, prepared.verdict);
    if (started) deps.say(`started ${id} (stop after resolved), verdict approved from the file`);
  }

  const deadline = Date.now() + waitMs;
  let state = await queryState(lifecycle, deadline, pollMs);
  if (state.step !== 'waiting-verdict' && state.step !== 'waiting-fix') {
    throw new FixRefused(`${id} is ${state.step}, not waiting for a fix.`);
  }
  if (!state.verdict && !started) {
    // An open lifecycle run the reconciler has not caught up with: the file's
    // verdict is the one the reconciler would send.
    const prepared = await prepareFromFile(deps, site, key);
    returnedFrom = prepared.returnedFrom;
    await lifecycle.signal(verdictSignal, prepared.verdict);
  }
  while (state.step !== 'waiting-fix') {
    if (state.step === 'done' || state.verdict?.status === 'rejected') {
      throw new FixRefused(`${id} has a rejected verdict, so there is nothing to fix.`);
    }
    if (Date.now() > deadline) {
      throw new FixRefused(`${id} is still ${state.step} after ${waitMs / 1000}s. Is a worker running (\`steward up\`)?`);
    }
    await sleep(pollMs);
    state = await queryState(lifecycle, deadline, pollMs);
  }

  const priorFixRunId = await runId(fixHandle);
  await lifecycle.signal(fixSignal, { source: 'cli', at: new Date().toISOString() });
  deps.say(`fix signal sent to ${id}`);
  return { lifecycle, started, returnedFrom, replacedVerdictRun: Boolean(verdictRun), priorFixRunId };
}

/**
 * Watches the fix child the signal started, reporting each step, and returns
 * its result. The child is told from an earlier run of the same ID by its run
 * ID, so no clock is compared.
 */
export async function followFix(
  client: Client,
  site: string,
  key: string,
  requested: FixRequested,
  onStep: (step: string) => void,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<FixFindingResult> {
  const waitMs = opts.waitMs ?? 120_000;
  const pollMs = opts.pollMs ?? 2000;
  const id = fixWorkflowId(site, key);
  const deadline = Date.now() + waitMs;

  let childRunId: string | null = null;
  for (;;) {
    const current = await runId(client.workflow.getHandle(id));
    if (current && current !== requested.priorFixRunId) {
      childRunId = current;
      break;
    }
    const parent = await requested.lifecycle.query(findingStateQuery).catch(() => undefined);
    if (parent?.step === 'done') throw new Error(`${requested.lifecycle.workflowId} ended before it started ${id}.`);
    if (Date.now() > deadline) {
      throw new Error(`${requested.lifecycle.workflowId} has not started ${id} after ${waitMs / 1000}s. Is a worker running?`);
    }
    await sleep(pollMs);
  }
  onStep('started');

  const child = client.workflow.getHandle(id, childRunId);
  let done = false;
  const result = child.result().finally(() => {
    done = true;
  });
  result.catch(() => undefined);
  let step = '';
  while (!done) {
    try {
      const state = await child.query(fixFindingStateQuery);
      if (state.step !== step) {
        step = state.step;
        onStep(step);
      }
    } catch {
      /* the child just closed: the result says how */
    }
    await Promise.race([result.catch(() => undefined), sleep(pollMs)]);
  }
  return (await result) as FixFindingResult;
}
