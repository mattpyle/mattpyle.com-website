import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
// Pure, no imports of its own: the refusal rule and the ID the CLI holds.
import {
  fixPrUrl,
  verifyRefusal,
  verifyWorkflowId,
  type VerifyBlockSource,
  type VerifyOutcome,
} from '../lib/findings.js';

/**
 * `verifyFindingWorkflow`: one execution per verify run,
 * `verify/<site>/<key>/<stamp>`, from a `fixing` or `reopened` finding to `resolved` or
 * `reopened` (findings-loop design, phase 5).
 *
 * Up to five activities, in order: read the finding, read its PR, read the
 * `verify` block, run the checks against production (or, with no checks, read
 * what production serves), write the result back. All of them run on
 * `steward-findings`, the hosted worker's queue (design decision 29), so a
 * verify needs no machine of Matt's to be on.
 *
 * **Whose block.** The finding's own `verify` key, and nothing else: the
 * finder's measure, written by Argus before any fix existed. The handoff is
 * not read and no block is generated (decisions 27 and 29). The result and the
 * `## Verification` section say `Checks from: finding`.
 *
 * **The gate** is {@link verifyRefusal} and a merged PR. A finding that is not
 * `fixing` or `reopened`, or whose fix is not merged, ends the workflow before
 * a check runs: measuring production for a fix that is not there would reopen
 * the finding. A `reopened` finding is admitted so that a check corrected after
 * it failed (a missing viewport, say) can be re-run against the same live fix.
 * Whether the deploy has finished is the operator's to know.
 *
 * **A new execution, not a later stop point** (design decision 18), and a new
 * ID each run: a finding verified, reopened, fixed again and verified again
 * has one history per measurement.
 *
 * **What rides where** (design rule 10). The repository, the three paths, the
 * production origin and the run's instant are in the input, resolved by the
 * CLI or the parent. `handoffPath` stays in the input type so recorded
 * histories still decode; nothing reads it. Nothing here reads config, the
 * environment or the clock.
 *
 * **Three endings.** Every check passes: `resolved`. Any check fails:
 * `reopened`. The finding has no `verify` key, or an empty list, a measure no
 * check can express: the deploy is the evidence (decision 30). Production is
 * read once, as the lifecycle's deploy wait reads it, and when the live commit
 * contains the fix PR's merge the finding is written `resolved` with
 * `resolved_by: deploy` and the outcome is `confirmed`. When it does not, the
 * run fails as a check that could not measure, and nothing is written.
 *
 * **Versioned with `patched`.** A blockless run recorded before decision 30
 * has no {@link BLOCKLESS_CONFIRM_PATCH} marker and replays to its old
 * `unverifiable` ending, which writes nothing.
 */

// Duplicated rather than imported from config.ts, as in the sibling workflows.
// Every activity runs on the findings queue: GitHub API calls, fetch against
// production, and the hosted image's Chromium for `selector` and `js`.
const QUEUE_FINDINGS = 'steward-findings';

/** The `patched` marker of the blockless verify's production read in place of `unverifiable` (decision 30). */
export const BLOCKLESS_CONFIRM_PATCH = 'verify-blockless-confirm';

/** The GitHub deployment environment Vercel's integration posts production to, as in `finding.ts`. */
const PRODUCTION_ENVIRONMENT = 'Production';

export interface VerifyFindingInput {
  site: string;
  key: string;
  /** `owner/name` of the findings repository. */
  repo: string;
  /** `sites/<site>/findings/<key>.md` */
  findingPath: string;
  /** `sites/<site>/findings/INDEX.md` */
  indexPath: string;
  /** `sites/<site>/handoffs/<key>.md`. Unread since decision 29. */
  handoffPath?: string;
  /** The production origin every check must name. */
  origin: string;
  /** ISO 8601, when the CLI started the run. The workflow ID's stamp is built from it. */
  at: string;
  /** `steward finding verify --reason`: one line for the Verification section. Absent from the lifecycle's child. */
  reason?: string;
}

export interface VerifyFindingCheck {
  n: number;
  /** One URL, or the check's list of URLs. */
  url: string | string[];
  kind: string;
  pass: boolean;
  expected: string;
  measured: string;
  /** `selector` and `js` only: the size the page was opened at. Absent from results recorded before viewports. */
  viewport?: string;
}

export interface VerifyFindingResult {
  site: string;
  key: string;
  outcome: VerifyOutcome;
  /** The block as it was run: `{url, kind, expect}` per check, and a `viewport` or a `status` where the check names one. */
  block: { url: string | string[]; kind: string; expect: unknown; viewport?: string; status?: number }[];
  checks: VerifyFindingCheck[];
  /** Where the checks came from: `finding` since decision 29. An older result may name the handoff. */
  source: VerifyBlockSource;
  /** False when the finding has no `verify` key at all, rather than an empty one. */
  hasBlock: boolean;
  /** The last commit of the write back, or null when nothing was written. */
  findingCommitSha: string | null;
  /** When the checks ran or production was read, or null when neither happened. */
  ranAt: string | null;
  /** `confirmed` only: the fix PR, its merge commit, and what production served. Absent from older results. */
  deploy?: { prUrl: string; mergeSha: string; liveSha: string; deploymentId: number | null };
}

export type VerifyFindingStep = 'reading' | 'checking' | 'writing' | 'done';

export interface VerifyFindingState {
  site: string;
  key: string;
  step: VerifyFindingStep;
}

export const verifyFindingStateQuery = wf.defineQuery<VerifyFindingState>('state');

const GITHUB_PERMANENT = ['AuthError', 'NotFound', 'UnprocessableRequest'];

const reading = wf.proxyActivities<
  Pick<typeof activities, 'readFinding' | 'readFixPr' | 'readVerifyBlock' | 'readProductionDeploy'>
>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'FindingMissing', 'FindingMalformed', 'VerifyBlockInvalid'],
  },
});

// Three attempts, a minute apart at the last: what is retried is production
// answering 5xx or not at all, and a deploy in progress is over in that time.
const checking = wf.proxyActivities<Pick<typeof activities, 'runFindingChecks'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3, initialInterval: '15 seconds', backoffCoefficient: 4, nonRetryableErrorTypes: ['VerifyCheckBroken'] },
});

// Five attempts with backoff, for the reason `findingWorkflow` gives: the
// retryable failure is Argus pushing between the read and the write.
const writing = wf.proxyActivities<Pick<typeof activities, 'writeFindingVerification'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'FindingMissing', 'FindingMalformed', 'FindingMoved'],
  },
});

export async function verifyFindingWorkflow(input: VerifyFindingInput): Promise<VerifyFindingResult> {
  const state: VerifyFindingState = { site: input.site, key: input.key, step: 'reading' };
  wf.setHandler(verifyFindingStateQuery, () => state);

  const finding = await reading.readFinding(input.repo, input.findingPath);
  const refusal = verifyRefusal(finding.data);
  if (refusal) {
    throw wf.ApplicationFailure.nonRetryable(`${input.key} is not verified: ${refusal}.`, 'FindingNotVerifiable');
  }
  const pr = await reading.readFixPr(fixPrUrl(finding.data));
  if (!pr.merged) {
    throw wf.ApplicationFailure.nonRetryable(
      `${input.key} is not verified: ${pr.prUrl} is not merged, so the fix is not on production.`,
      'FixNotMerged',
    );
  }

  const read = await reading.readVerifyBlock({
    repo: input.repo,
    findingPath: input.findingPath,
    findingText: finding.text,
    origin: input.origin,
  });
  // `finding` since decision 29. A result recorded before then may lack it.
  const source: VerifyBlockSource = read.source ?? 'handoff';
  const block = read.checks;

  const result: VerifyFindingResult = {
    site: input.site,
    key: input.key,
    outcome: 'unverifiable',
    block,
    checks: [],
    source,
    hasBlock: read.hasBlock,
    findingCommitSha: null,
    ranAt: null,
  };
  if (block.length === 0) {
    if (!wf.patched(BLOCKLESS_CONFIRM_PATCH)) {
      state.step = 'done';
      return result;
    }
    return await confirmByDeploy(input, state, result, pr.prUrl);
  }

  state.step = 'checking';
  const run = await checking.runFindingChecks({ key: input.key, checks: block });
  const outcome = run.passed ? 'resolved' : 'reopened';

  state.step = 'writing';
  const written = await writing.writeFindingVerification({
    repo: input.repo,
    site: input.site,
    key: input.key,
    findingPath: input.findingPath,
    indexPath: input.indexPath,
    verification: {
      status: outcome,
      at: run.ranAt,
      workflowId: verifyWorkflowId(input.site, input.key, input.at),
      source,
      rows: run.results,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  state.step = 'done';
  return { ...result, outcome, checks: run.results, findingCommitSha: written.commitSha, ranAt: run.ranAt };
}

/**
 * A finding with no checks, resolved by its deploy: one read of production,
 * and the write when the live commit contains the fix PR's merge.
 */
async function confirmByDeploy(
  input: VerifyFindingInput,
  state: VerifyFindingState,
  result: VerifyFindingResult,
  prUrl: string,
): Promise<VerifyFindingResult> {
  state.step = 'checking';
  const live = await reading.readProductionDeploy({ prUrl, environment: PRODUCTION_ENVIRONMENT });
  if (!live.contains || !live.mergeSha || !live.liveSha) {
    throw wf.ApplicationFailure.nonRetryable(
      `${input.key} has no check, and its fix could not be confirmed by the deploy: ${live.why} The finding is unchanged.`,
      'FixNotLive',
    );
  }
  const deploy = { prUrl, mergeSha: live.mergeSha, liveSha: live.liveSha };

  state.step = 'writing';
  const written = await writing.writeFindingVerification({
    repo: input.repo,
    site: input.site,
    key: input.key,
    findingPath: input.findingPath,
    indexPath: input.indexPath,
    verification: {
      status: 'resolved',
      at: live.readAt,
      workflowId: verifyWorkflowId(input.site, input.key, input.at),
      source: result.source,
      rows: [],
      deploy,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  state.step = 'done';
  return {
    ...result,
    outcome: 'confirmed',
    findingCommitSha: written.commitSha,
    ranAt: live.readAt,
    deploy: { ...deploy, deploymentId: live.deploymentId },
  };
}
