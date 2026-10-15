import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
// Pure, no imports of its own: the same parser and the same refusal rule the
// PR body and the tests hold.
import { fixRefusal, parseFindingBody, parsePrUrl } from '../lib/findings.js';
import type { FixerDiffReview } from '../lib/diff-review.js';
import type { FixerSiteChecks } from '../lib/fixer.js';
import type { VerifyCheck, VerifyCheckResult } from '../lib/verify-checks.js';

/**
 * `fixFindingWorkflow`: one execution per approved finding, `fix/<site>/<key>`,
 * from the finding to an open PR (findings-loop design, phase 5).
 *
 * The activities, in order: read the finding, generate the handoff, test its
 * checks on production, run Claude Code on it, review its diff, open the PR,
 * write `status: fixing` and the PR link back, then test the checks on the
 * PR's preview and update the PR with the result.
 *
 * **A new execution, not a later stop point on `findingWorkflow`** (design
 * decision 18). That workflow completed at the verdict; this one starts from
 * the file the verdict was written to, so no open execution replays through
 * code it never ran.
 *
 * **Always a child** of a `findingWorkflow` started with `stopAfter:
 * 'resolved'`, which `steward finding fix` signals (standalone-fix-closed-pr).
 * The parent watches the PR, so a close or a merge is never left unhandled.
 *
 * **What rides where** (design rule 10). The repository, the three paths, the
 * branch and the stop point are in the input, resolved by its parent. Nothing here
 * reads config or the environment. The finding itself is read by an activity,
 * so the text the gate judged, the handoff was written from and the PR body
 * quotes is one string in the history. So are the checks, the production
 * origin they name and the preview's origin: each is an activity result.
 *
 * **The gate** is {@link fixRefusal}: approved, `kind: defect`, a cause and a
 * measure. A finding that fails it ends the workflow as `FindingNotFixable`
 * before a model is called.
 *
 * **The two tests** of the `verify` block, the finding's own when it has one,
 * else the handoff's:
 *
 * 1. On production, before the fixer runs, every check must fail. A handoff
 *    check that passes gets one regeneration, told what each check measured;
 *    one that still passes opens the PR as a draft. A finding's check is never
 *    rewritten, and one that passes opens the PR as a draft.
 * 2. On the PR head's Vercel preview, after the PR opens, every check must
 *    pass. One that fails turns the PR into a draft and is not rewritten: a
 *    check rewritten to pass the fixer's own output would be the fixer grading
 *    itself.
 *
 * An empty block is a measure no check can express. Neither test runs, and the
 * PR body says the fix is unverifiable by checks.
 *
 * **The diff review**, after the fixer and before the PR: a second model call
 * reads the diff against the finding and the handoff, and reports hunks
 * neither calls for and new mistakes in changed lines. Any report, and a
 * review that could not finish, opens the PR as a draft. It never fails the
 * workflow, and it never edits the diff.
 *
 * **Versioned with `patched`.** A history written before the two tests has no
 * marker, so it replays down the five steps it ran. One written before the
 * diff review has no review marker, so it opens the PR straight after the
 * fixer.
 *
 * **`stopAfter`** is `'pr'`, the only value this code knows. Waiting for the
 * merge and verifying on production start new executions with a later one.
 */

// Duplicated rather than imported from config.ts, as in the sibling workflows:
// config.ts touches `node:path` and `process.env`, neither available in the
// workflow sandbox. Every activity runs on the heavy queue, which only the
// laptop worker polls: two of them need its Claude Code login and its checkout,
// and keeping the GitHub calls and the checks beside them means one worker,
// running one version of the code, carries a fix from start to end.
const QUEUE_HEAVY = 'steward-heavy';

/** The `patched` marker of the two tests. */
export const PREVIEW_VERIFY_PATCH = 'fixer-preview-verify';

/** The `patched` marker of the diff review. */
export const DIFF_REVIEW_PATCH = 'fixer-diff-review';

/** The GitHub deployment environment Vercel's integration posts previews to. */
const PREVIEW_ENVIRONMENT = 'Preview';

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
  /** True when the run was incomplete, a check failed or a test of the `verify` block failed, and the PR is a draft. */
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
    timingsMs: { worktree: number; install: number; claude: number; checks: number; push: number; total: number };
    /** The Verify checks as Steward ran them. */
    checks: { n: number; status: 'pass' | 'fail' | 'not-run'; command: string | null }[];
  };
  /** The `verify` block's two tests. Absent from a run that predates them. */
  verify?: FixerSiteChecks & { previewOrigin: string | null };
  /** The diff review. Absent from a run that predates it. */
  review?: FixerDiffReview;
}

export type FixFindingStep =
  | 'reading'
  | 'generating'
  | 'testing-production'
  | 'fixing'
  | 'reviewing'
  | 'opening'
  | 'writing'
  | 'waiting-preview'
  | 'testing-preview'
  | 'done';

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
// more than that, since each attempt is a model run that reads the checkout.
const generating = wf.proxyActivities<Pick<typeof activities, 'generateHandoff'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2, nonRetryableErrorTypes: GITHUB_PERMANENT },
});

// The same two attempts, for the block written a second time.
const regenerating = wf.proxyActivities<Pick<typeof activities, 'generateVerifyBlock'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2, nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'HandoffMissing', 'FixerBusy'] },
});

const choosing = wf.proxyActivities<Pick<typeof activities, 'readFixChecks'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['VerifyBlockInvalid'] },
});

// The verifier's policy: what is retried is the site answering 5xx or not at
// all, and a deploy in progress is over in a minute. A broken check and a
// worker with no bypass secret are not mended by a retry.
const checking = wf.proxyActivities<Pick<typeof activities, 'runFindingChecks'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '15 seconds',
    backoffCoefficient: 4,
    nonRetryableErrorTypes: ['VerifyCheckBroken', 'PreviewBypassMissing'],
  },
});

// One attempt: a second would spend another model turn on the same handoff and
// force-push over whatever the first left. The heartbeat timeout is what turns
// a dead worker into a failure in a minute rather than in seventy-five, and the
// cancellation type makes a cancelled workflow wait until the process tree is
// down before it reports cancelled.
const fixing = wf.proxyActivities<Pick<typeof activities, 'runFixer'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '75 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
  cancellationType: wf.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

// One attempt: the activity returns every failure it can name as an
// unfinished review, and a second model call on the same diff is not worth a
// retry. What still throws (a dead worker, a timeout) the workflow records as
// an unfinished review too.
const reviewing = wf.proxyActivities<Pick<typeof activities, 'reviewFixDiff'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
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

// The preview wait: the merge wait's polling pattern. Every 30 seconds for up
// to 20 minutes; a Vercel preview build takes about three.
const previewing = wf.proxyActivities<Pick<typeof activities, 'awaitPreviewDeploy'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '20 minutes',
  retry: {
    initialInterval: '30 seconds',
    backoffCoefficient: 1,
    nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'PreviewFailed'],
  },
});

/** A wait that ran out its schedule-to-close bound, rather than failing outright. */
function isTimeout(err: unknown): boolean {
  return err instanceof wf.ActivityFailure && (err.retryState === 'TIMEOUT' || err.cause instanceof wf.TimeoutFailure);
}

function failedAs(err: unknown, type: string): boolean {
  return err instanceof wf.ActivityFailure && err.cause instanceof wf.ApplicationFailure && err.cause.type === type;
}

/** The innermost specific message of a failure chain. */
function describeError(err: unknown): string {
  let current: unknown = err;
  let best = '';
  for (let depth = 0; current instanceof Error && depth < 6; depth++) {
    if (current.message && current.message !== 'Activity task failed') best = current.message;
    current = (current as Error).cause;
  }
  return best || (err instanceof Error ? err.message : String(err));
}

interface Measured {
  results: VerifyCheckResult[] | null;
  /** Why no rows: a check's own expression did not run. */
  broken: string | null;
}

/** One run of the block. A broken check is a result here, not a failure. */
async function measure(key: string, checks: VerifyCheck[], previewOrigin?: string): Promise<Measured> {
  try {
    const run = await checking.runFindingChecks({ key, checks, ...(previewOrigin ? { previewOrigin } : {}) });
    return { results: run.results, broken: null };
  } catch (err) {
    if (failedAs(err, 'VerifyCheckBroken')) return { results: null, broken: describeError(err) };
    throw err;
  }
}

/** Every check ran, and every one failed. */
function showsTheDefect(measured: Measured): boolean {
  return measured.broken === null && (measured.results ?? []).every((row) => !row.pass);
}

/**
 * The first test: the block chosen, run on production, and the handoff's block
 * written once more when it does not show the defect. Returns the handoff the
 * fixer gets, which carries the block that stands.
 */
async function testOnProduction(
  input: FixFindingInput,
  findingText: string,
  handoff: string,
): Promise<{ handoff: string; site: FixerSiteChecks }> {
  const chosen = await choosing.readFixChecks({
    key: input.key,
    findingPath: input.findingPath,
    findingText,
    handoff,
  });
  const site: FixerSiteChecks = {
    source: chosen.source,
    regenerated: false,
    regenerateError: null,
    block: chosen.checks,
    coverage: chosen.coverage ?? null,
    production: null,
    productionNote: null,
    preview: null,
    previewNote: null,
  };
  if (site.block.length === 0) return { handoff, site };

  let measured = await measure(input.key, site.block);
  if (chosen.source === 'handoff' && !showsTheDefect(measured)) {
    try {
      const again = await regenerating.generateVerifyBlock({
        repo: input.repo,
        key: input.key,
        findingText,
        handoffPath: input.handoffPath,
        origin: chosen.origin,
        rejected: { checks: site.block, results: measured.results, broken: measured.broken },
      });
      handoff = again.handoff ?? handoff;
      site.block = again.checks;
      site.coverage = again.coverage ?? null;
      site.regenerated = true;
      if (site.block.length === 0) return { handoff, site };
      measured = await measure(input.key, site.block);
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      // The first block stands, with what it measured, and the PR says so.
      site.regenerateError = describeError(err);
    }
  }
  site.production = measured.results;
  site.productionNote = measured.broken;
  return { handoff, site };
}

/**
 * The second test: the PR head's preview, once Vercel reports it ready, and
 * the block run against it. Nothing here fails the workflow: the finding is
 * already marked fixing, and a preview that cannot be measured is a draft PR
 * with the reason in its body.
 */
async function testOnPreview(
  input: FixFindingInput,
  state: FixFindingState,
  site: FixerSiteChecks,
  prUrl: string,
  headSha: string,
): Promise<string | null> {
  const pr = parsePrUrl(prUrl);
  if (!pr) {
    site.previewNote = `${prUrl} is not a pull request URL, so its preview could not be found.`;
    return null;
  }
  state.step = 'waiting-preview';
  let origin: string;
  try {
    origin = (await previewing.awaitPreviewDeploy({ repo: pr.repo, sha: headSha, environment: PREVIEW_ENVIRONMENT })).origin;
  } catch (err) {
    if (wf.isCancellation(err)) throw err;
    site.previewNote = isTimeout(err)
      ? `No ${PREVIEW_ENVIRONMENT} deployment of ${headSha.slice(0, 7)} was ready within 20 minutes.`
      : describeError(err);
    return null;
  }

  state.step = 'testing-preview';
  try {
    const measured = await measure(input.key, site.block, origin);
    site.preview = measured.results;
    site.previewNote = measured.broken;
  } catch (err) {
    if (wf.isCancellation(err)) throw err;
    site.previewNote = describeError(err);
  }
  return origin;
}

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

  let handoff = generated.handoff;
  let site: FixerSiteChecks | null = null;
  if (wf.patched(PREVIEW_VERIFY_PATCH)) {
    state.step = 'testing-production';
    ({ handoff, site } = await testOnProduction(input, finding.text, handoff));
  }

  state.step = 'fixing';
  const run = await fixing.runFixer({
    key: input.key,
    handoff,
    branch: input.branch,
    baseSha: generated.baseSha,
  });

  let review: FixerDiffReview | null = null;
  if (wf.patched(DIFF_REVIEW_PATCH)) {
    state.step = 'reviewing';
    try {
      const reviewed = await reviewing.reviewFixDiff({
        key: input.key,
        findingText: finding.text,
        handoff,
        baseSha: generated.baseSha,
        headSha: run.commitSha,
        coverage: site?.coverage ?? null,
      });
      review = { problems: reviewed.problems, incomplete: reviewed.incomplete };
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      review = { problems: [], incomplete: `The review activity failed: ${describeError(err)}` };
    }
  }

  state.step = 'opening';
  const prInput = {
    key: input.key,
    findingText: finding.text,
    handoff,
    branch: run.branch,
    base: run.base,
    filesChanged: run.filesChanged,
    checks: run.checks,
    exitCode: run.claude.exitCode,
    timedOut: run.claude.timedOut,
    ...(review ? { review } : {}),
  };
  const pr = await opening.openFixerPr(site ? { ...prInput, site } : prInput);
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

  let draft = pr.draft;
  let previewOrigin: string | null = null;
  if (site && site.block.length > 0) {
    previewOrigin = await testOnPreview(input, state, site, pr.prUrl, run.commitSha);
    try {
      draft = (await opening.openFixerPr({ ...prInput, site })).draft;
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      wf.log.warn('the PR was not updated with the preview test', { key: input.key, error: describeError(err) });
    }
  }

  state.step = 'done';
  return {
    site: input.site,
    key: input.key,
    prUrl: pr.prUrl,
    draft,
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
      checks: run.checks,
    },
    ...(site ? { verify: { ...site, previewOrigin } } : {}),
    ...(review ? { review } : {}),
  };
}
