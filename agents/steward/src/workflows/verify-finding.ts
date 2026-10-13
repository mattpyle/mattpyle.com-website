import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
// Pure, no imports of its own: the refusal rule and the ID the CLI holds.
import { fixPrUrl, verifyRefusal, verifyWorkflowId, type VerifyOutcome } from '../lib/findings.js';

/**
 * `verifyFindingWorkflow`: one execution per verify run,
 * `verify/<site>/<key>/<stamp>`, from a `fixing` finding to `resolved` or
 * `reopened` (findings-loop design, phase 5).
 *
 * Up to six activities, in order: read the finding, read its PR, read the
 * `verify` block in its generated handoff, generate the block when the handoff
 * has none, run the checks against production, write the result back.
 *
 * **The gate** is {@link verifyRefusal} and a merged PR. A finding that is not
 * `fixing`, or whose fix is not merged, ends the workflow before a check runs:
 * measuring production for a fix that is not there would reopen the finding.
 * Whether the deploy has finished is the operator's to know.
 *
 * **A new execution, not a later stop point** (design decision 18), and a new
 * ID each run: a finding verified, reopened, fixed again and verified again
 * has one history per measurement.
 *
 * **What rides where** (design rule 10). The repository, the three paths, the
 * production origin and the run's instant are in the input, resolved by the
 * CLI. Whether the block is generated is decided from an activity result, the
 * handoff as it was read, so it replays from history. Nothing here reads
 * config, the environment or the clock.
 *
 * **Three endings.** Every check passes: `resolved`. Any check fails:
 * `reopened`. The block is an empty list, a measure no check can express:
 * `unverifiable`, and nothing is written.
 */

// Duplicated rather than imported from config.ts, as in the sibling workflows.
// Every activity runs on the heavy queue, for the reason `fixFindingWorkflow`
// gives: generating a block needs the laptop's Claude Code login and checkout,
// and one worker running one version of the code carries a run from start to
// end. The laptop has a Chromium for the two browser kinds.
const QUEUE_HEAVY = 'steward-heavy';

export interface VerifyFindingInput {
  site: string;
  key: string;
  /** `owner/name` of the findings repository. */
  repo: string;
  /** `sites/<site>/findings/<key>.md` */
  findingPath: string;
  /** `sites/<site>/findings/INDEX.md` */
  indexPath: string;
  /** `sites/<site>/handoffs/<key>.md` */
  handoffPath: string;
  /** The production origin every check must name. */
  origin: string;
  /** ISO 8601, when the CLI started the run. The workflow ID's stamp is built from it. */
  at: string;
}

export interface VerifyFindingCheck {
  n: number;
  url: string;
  kind: string;
  pass: boolean;
  expected: string;
  measured: string;
}

export interface VerifyFindingResult {
  site: string;
  key: string;
  outcome: VerifyOutcome;
  /** The block as it was run: `{url, kind, expect}` per check. */
  block: { url: string; kind: string; expect: unknown }[];
  checks: VerifyFindingCheck[];
  /** True when this run wrote the block into the handoff. */
  generated: boolean;
  /** The commit that wrote the block, or null. */
  handoffCommitSha: string | null;
  /** The last commit of the write back, or null when nothing was written. */
  findingCommitSha: string | null;
  /** When the checks ran, or null when there were none. */
  ranAt: string | null;
  /** What generating the block would cost at API rates, or null when none was generated. */
  generateCostUsd: number | null;
}

export type VerifyFindingStep = 'reading' | 'generating' | 'checking' | 'writing' | 'done';

export interface VerifyFindingState {
  site: string;
  key: string;
  step: VerifyFindingStep;
}

export const verifyFindingStateQuery = wf.defineQuery<VerifyFindingState>('state');

const GITHUB_PERMANENT = ['AuthError', 'NotFound', 'UnprocessableRequest'];

const reading = wf.proxyActivities<Pick<typeof activities, 'readFinding' | 'readFixPr' | 'readVerifyBlock'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'FindingMissing', 'FindingMalformed', 'HandoffMissing', 'VerifyBlockInvalid'],
  },
});

// Two attempts, as for the handoff: a reply the validator refuses is worth one
// more ask. A busy worktree is not retried: the fix that holds it runs for
// longer than any backoff here.
const generating = wf.proxyActivities<Pick<typeof activities, 'generateVerifyBlock'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2, nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'HandoffMissing', 'FixerBusy'] },
});

// Three attempts, a minute apart at the last: what is retried is production
// answering 5xx or not at all, and a deploy in progress is over in that time.
const checking = wf.proxyActivities<Pick<typeof activities, 'runFindingChecks'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3, initialInterval: '15 seconds', backoffCoefficient: 4, nonRetryableErrorTypes: ['VerifyCheckBroken'] },
});

// Five attempts with backoff, for the reason `findingWorkflow` gives: the
// retryable failure is Argus pushing between the read and the write.
const writing = wf.proxyActivities<Pick<typeof activities, 'writeFindingVerification'>>({
  taskQueue: QUEUE_HEAVY,
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

  const handoff = await reading.readVerifyBlock({
    repo: input.repo,
    handoffPath: input.handoffPath,
    origin: input.origin,
  });

  let block = handoff.checks;
  let handoffCommitSha: string | null = null;
  let generateCostUsd: number | null = null;
  if (!handoff.hasBlock) {
    state.step = 'generating';
    const generated = await generating.generateVerifyBlock({
      repo: input.repo,
      key: input.key,
      findingText: finding.text,
      handoffPath: input.handoffPath,
      origin: input.origin,
    });
    block = generated.checks;
    handoffCommitSha = generated.commitSha;
    generateCostUsd = generated.claude.costUsd;
  }

  const result: VerifyFindingResult = {
    site: input.site,
    key: input.key,
    outcome: 'unverifiable',
    block,
    checks: [],
    generated: !handoff.hasBlock,
    handoffCommitSha,
    findingCommitSha: null,
    ranAt: null,
    generateCostUsd,
  };
  if (block.length === 0) {
    state.step = 'done';
    return result;
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
      rows: run.results,
    },
  });

  state.step = 'done';
  return { ...result, outcome, checks: run.results, findingCommitSha: written.commitSha, ranAt: run.ranAt };
}
