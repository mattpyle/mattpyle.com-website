import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
// Pure, no imports of its own: the same parser and the same refusal rule the
// PR body and the tests hold.
import { fixRefusal, parseFindingBody } from '../lib/findings.js';

/**
 * `fixFindingWorkflow`: one execution per approved finding, `fix/<site>/<key>`,
 * from the finding to an open PR (findings-loop design, phase 5).
 *
 * Five activities, in order: read the finding, generate the handoff, run Claude
 * Code on it, open the PR, write `status: fixing` and the PR link back.
 *
 * **A new execution, not a later stop point on `findingWorkflow`** (design
 * decision 18). That workflow completed at the verdict; this one starts from
 * the file the verdict was written to, so no open execution replays through
 * code it never ran.
 *
 * **What rides where** (design rule 10). The repository, the three paths, the
 * branch and the stop point are in the input, resolved by the CLI. Nothing here
 * reads config or the environment. The finding itself is read by an activity,
 * so the text the gate judged, the handoff was written from and the PR body
 * quotes is one string in the history.
 *
 * **The gate** is {@link fixRefusal}: approved, `kind: defect`, a cause and a
 * measure. A finding that fails it ends the workflow as `FindingNotFixable`
 * before a model is called.
 *
 * **`stopAfter`** is `'pr'`, the only value this code knows. Waiting for the
 * merge and verifying on production start new executions with a later one.
 */

// Duplicated rather than imported from config.ts, as in the sibling workflows:
// config.ts touches `node:path` and `process.env`, neither available in the
// workflow sandbox. Every activity runs on the heavy queue, which only the
// laptop worker polls: two of them need its Claude Code login and its checkout,
// and keeping the three GitHub calls beside them means one worker, running one
// version of the code, carries a fix from start to end.
const QUEUE_HEAVY = 'steward-heavy';

export type FixFindingStopAfter = 'pr';

export interface FixFindingInput {
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
  /** The branch the fixer creates and pushes in the site repository. */
  branch: string;
  stopAfter: FixFindingStopAfter;
}

export interface FixFindingResult {
  site: string;
  key: string;
  prUrl: string;
  /** True when the run was incomplete and the PR is a draft. */
  draft: boolean;
  branch: string;
  commitSha: string;
  filesChanged: string[];
  /** The commit that wrote the handoff, or null when it was already there. */
  handoffCommitSha: string | null;
  /** The last commit of the write back, or null when the finding already said `fixing`. */
  findingCommitSha: string | null;
  run: {
    exitCode: number;
    timedOut: boolean;
    model: string | null;
    numTurns: number | null;
    costUsd: number | null;
    /** What the handoff generation would cost at API rates. */
    handoffCostUsd: number | null;
    permissionDenials: string[];
    timingsMs: { worktree: number; install: number; claude: number; push: number; total: number };
  };
}

export type FixFindingStep = 'reading' | 'generating' | 'fixing' | 'opening' | 'writing' | 'done';

export interface FixFindingState {
  site: string;
  key: string;
  step: FixFindingStep;
  prUrl: string | null;
}

export const fixFindingStateQuery = wf.defineQuery<FixFindingState>('state');

const GITHUB_PERMANENT = ['AuthError', 'NotFound', 'UnprocessableRequest'];

const reading = wf.proxyActivities<Pick<typeof activities, 'readFinding'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3, nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'FindingMissing'] },
});

// Two attempts: a reply the validator refuses is worth one more ask, and no
// more than that, since each attempt is a model call.
const generating = wf.proxyActivities<Pick<typeof activities, 'generateHandoff'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '6 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2, nonRetryableErrorTypes: GITHUB_PERMANENT },
});

// One attempt: a second would spend another model turn on the same handoff and
// force-push over whatever the first left. The heartbeat timeout is what turns
// a dead worker into a failure in a minute rather than in forty-five, and the
// cancellation type makes a cancelled workflow wait until the process tree is
// down before it reports cancelled.
const fixing = wf.proxyActivities<Pick<typeof activities, 'runFixer'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
  cancellationType: wf.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

const opening = wf.proxyActivities<Pick<typeof activities, 'openFixerPr'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, initialInterval: '2 seconds', nonRetryableErrorTypes: GITHUB_PERMANENT },
});

// Five attempts with backoff, for the reason `findingWorkflow` gives: the
// retryable failure is Argus pushing between the read and the write.
const writing = wf.proxyActivities<Pick<typeof activities, 'writeFindingFix'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'FindingMissing', 'FindingMalformed', 'FindingMoved'],
  },
});

export async function fixFindingWorkflow(input: FixFindingInput): Promise<FixFindingResult> {
  if (input.stopAfter !== 'pr') {
    throw wf.ApplicationFailure.nonRetryable(
      `stopAfter "${String(input.stopAfter)}" is not a stop point this workflow knows.`,
      'UnknownStopPoint',
    );
  }

  const state: FixFindingState = { site: input.site, key: input.key, step: 'reading', prUrl: null };
  wf.setHandler(fixFindingStateQuery, () => state);

  const finding = await reading.readFinding(input.repo, input.findingPath);
  const refusal = fixRefusal(finding.data, parseFindingBody(finding.text));
  if (refusal) {
    throw wf.ApplicationFailure.nonRetryable(
      `${input.key} does not go to the fixer: ${refusal}.`,
      'FindingNotFixable',
    );
  }

  state.step = 'generating';
  const generated = await generating.generateHandoff({
    repo: input.repo,
    key: input.key,
    findingText: finding.text,
    handoffPath: input.handoffPath,
  });

  state.step = 'fixing';
  const run = await fixing.runFixer({ key: input.key, handoff: generated.handoff, branch: input.branch });

  state.step = 'opening';
  const pr = await opening.openFixerPr({
    key: input.key,
    findingText: finding.text,
    handoff: generated.handoff,
    branch: run.branch,
    base: run.base,
    filesChanged: run.filesChanged,
    checks: run.checks,
    exitCode: run.claude.exitCode,
    timedOut: run.claude.timedOut,
  });
  state.prUrl = pr.prUrl;

  state.step = 'writing';
  const written = await writing.writeFindingFix({
    repo: input.repo,
    site: input.site,
    key: input.key,
    findingPath: input.findingPath,
    indexPath: input.indexPath,
    prUrl: pr.prUrl,
  });

  state.step = 'done';
  return {
    site: input.site,
    key: input.key,
    prUrl: pr.prUrl,
    draft: pr.draft,
    branch: run.branch,
    commitSha: run.commitSha,
    filesChanged: run.filesChanged,
    handoffCommitSha: generated.commitSha,
    findingCommitSha: written.commitSha,
    run: {
      exitCode: run.claude.exitCode,
      timedOut: run.claude.timedOut,
      model: run.claude.model,
      numTurns: run.claude.numTurns,
      costUsd: run.claude.costUsd,
      handoffCostUsd: generated.claude.costUsd,
      permissionDenials: run.claude.permissionDenials,
      timingsMs: run.timingsMs,
    },
  };
}
