import type { Client } from '@temporalio/client';
import {
  ARGUS_REPO,
  FINDINGS_DEFAULT_SITE,
  NAMESPACE,
  PROD_ORIGIN,
  QUEUE_FINDINGS,
  WEB_UI,
} from '../config.js';
import { readFinding, writeFindingReturned } from '../activities/findings.js';
import { FixRefused, requestFix, type FixRequested } from './finding-fix.js';
import { ResumeRefused, parkedElsewhereLine, parkedRun, requestResume, resumedLine } from './finding-resume.js';
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
import { verifyFindingWorkflow, type VerifyFindingResult } from '../workflows/verify-finding.js';

/**
 * The two verbs the console runs from its page beside the CLI: `steward finding
 * fix` and `verify`. Each verb and its button call the functions here, so
 * the two cannot drift. The pattern is `finding-verdict.ts`: nothing here prints
 * or exits, and a refusal is an error whose message the operator can act on.
 *
 * It also holds the gates the page uses to offer a button ({@link fixOffered},
 * {@link verifyOffered}): the same refusals the verbs apply, so the page never
 * offers what the CLI would refuse.
 */

const runLink = (workflowId: string) => `${WEB_UI}/namespaces/${NAMESPACE}/workflows/${encodeURIComponent(workflowId)}`;

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
export function requestFindingFix(
  client: Client,
  site: string,
  key: string,
  say: (line: string) => void,
  source: 'cli' | 'console' = 'cli',
): Promise<FixRequested> {
  return requestFix(
    {
      client,
      source,
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
 * retries it; the page leaves that one to the CLI as it always did. A run
 * parked after its fix PR (STW-653) is offered Fix whatever the file's status,
 * at every stage but an unmerged PR's: the run's own `request-fix` validator
 * decides, and its refusal comes back to the page.
 */
export function fixOffered(input: {
  site: string;
  status: string;
  runOpen: boolean;
  /** The open run's `state.step`, when the loader asked. */
  runStep?: string | null;
  /** At `parked`: whether the park takes a new fix (STW-653). */
  parkTakesFix?: boolean;
  /** The open run's fix issue, when the loader asked. */
  issueUrl?: string | null;
  stopAfter: string | null;
  data: Record<string, unknown>;
  text: string;
}): boolean {
  if (input.runOpen && input.runStep === 'parked') return input.parkTakesFix === true;
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
  // A run parked after its fix PR verifies inside itself (STW-653): a verify
  // beside it would decide the file without telling the run.
  const parked = await parkedRun(client, site, key);
  if (parked) {
    // Only a park at its verify is a verify; any other names the command that moves it.
    if (parked.parked?.stage !== 'verify') throw new VerifyRefused(parkedElsewhereLine(key, parked));
    try {
      const accepted = await requestResume(client, site, key, new Date().toISOString(), 'console');
      return { workflowId: accepted.workflowId, webUrl: runLink(accepted.workflowId), nextStep: resumedLine(key, accepted) };
    } catch (err) {
      if (err instanceof ResumeRefused) throw new VerifyRefused(err.message);
      throw err;
    }
  }
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
