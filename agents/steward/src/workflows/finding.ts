import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { FixIssue } from '../activities/findings.js';
// Pure, no imports of its own: the ID, the paths and the verdict types are the
// same objects the reconciler and the CLI hold.
import {
  fixWorkflowId,
  parsePrUrl,
  verifyWorkflowId,
  type FindingVerdict,
  type VerifyOutcome,
} from '../lib/findings.js';
import { fixFindingWorkflow } from './fix-finding.js';
import { verifyFindingWorkflow } from './verify-finding.js';

/**
 * `findingWorkflow`: one execution per finding, `finding/<site>/<key>`. It
 * waits for Matt's verdict (findings-loop design, decisions 16 to 19) and,
 * started with `stopAfter: 'resolved'`, carries an approved finding through its
 * fix to `resolved` or `reopened` (fixer-merge-and-verify, decisions 1 to 8).
 *
 * The gate is the `verdict` signal, and it has two senders. `steward finding
 * approve|reject` sends it with source `cli`, and this workflow writes the
 * verdict into the finding file and its index line. The hourly reconciler sends
 * it with source `file` when the verdict is already in the file (Discord through
 * Argus, or an edit in Obsidian), and this workflow writes nothing.
 *
 * **`stopAfter`** is where the run ends.
 *
 * - `'verdict'`: it completes with the verdict, as every execution started
 *   before the lifecycle shipped does. That path issues exactly the commands it
 *   always did, so those histories replay unchanged.
 * - `'resolved'`: after an `approved` verdict it waits for the `fix` signal,
 *   or, when the site's `config.yaml` says `auto_fix: true`, goes straight on
 *   (decision 28). The fix is a GitHub issue that `claude-code-action` answers
 *   with a PR (decisions 26 and 27): `openFixIssue`, then `awaitFixPr`, then
 *   `writeFindingFix`, all on `steward-findings`. The merge wait and the
 *   deploy wait poll from here too, and `verifyFindingWorkflow` runs as a
 *   child on the same queue (decision 29). Its outcome is this run's result:
 *   a finding with no checks ends `confirmed` when its child reads the fix on
 *   production (decision 30).
 *   A rejected verdict ends the run as `'verdict'` does.
 *
 * **What rides where** (design rule 10). The repository, the paths, the branch,
 * the production origin and the stop point are in the input, so an open
 * workflow keeps the arguments it was started with whatever config says later.
 * The verdict and the fix request are signals, so the history records who
 * decided what. Nothing here reads config or the environment.
 *
 * **The two waits** are Temporal's infrequent-polling pattern (decision 7): an
 * activity that fails with a retryable error until it is done, retried at a
 * fixed interval. Retries are not history events. Either wait timing out ends
 * the run with the finding still `fixing` (decision 8), and the result says
 * which; `steward finding verify` closes it by hand.
 *
 * **A PR closed unmerged** writes `status: approved` back with a note, and the
 * run waits for the next `fix`. So does a fix that fails, and an issue with no
 * PR after 60 minutes: the finding is still approved, and a second `fix` is the
 * retry. The retry closes the last attempt's issue with a comment saying why,
 * and opens a new one. `auto_fix` covers the first attempt only.
 *
 * **Versioned with `patched`.** A run whose history started a
 * `fixFindingWorkflow` child replays that attempt as a child: it has no
 * {@link ACTION_ADAPTER_PATCH} marker there. Its next attempt, and every
 * attempt of a run parked at `waiting-fix` before this shipped, takes the
 * issue. A run already past its verdict has no {@link AUTO_FIX_PATCH} marker,
 * so it never reads the flag and waits for `fix` as it did. A run that started
 * its verify child on `steward-heavy` has no {@link VERIFIER_HOSTED_PATCH}
 * marker there and replays that start unchanged; every later verify runs on
 * `steward-findings`. The `confirmed` ending needs no marker here: the child
 * carries `verify-blockless-confirm`, and a child recorded before that marker
 * returns `unverifiable`, which this run still ends on.
 *
 * **The waits' retry policies carry no marker** (2026-10-22). Dropping
 * `AuthError` from the three waits' `nonRetryableErrorTypes` changes an
 * attribute of a command, not the command: replay matches an activity on its
 * type, and the SDK does not compare retry policies or timeouts against the
 * history. The lifecycle fixtures in `tests/workflows/replay.test.ts`
 * (`finding-verify-child-heavy.bin`, `finding-verify-unverifiable.bin`) were
 * recorded with `AuthError` in those lists and replay green against this code,
 * which is the proof. The new policy applies to a wait scheduled after the
 * worker picks this up; a wait already pending keeps the policy it was
 * scheduled with, and no open run was inside a wait when this shipped.
 */

// Duplicated from config.ts rather than imported, for the reason
// scorecard-audit.ts gives: config.ts touches `node:path` and `process.env`.
const QUEUE_FINDINGS = 'steward-findings';
const QUEUE_HEAVY = 'steward-heavy';

/** The `patched` marker of the issue path in place of the fix child (decision 26). */
export const ACTION_ADAPTER_PATCH = 'fixer-action-adapter';

/** The `patched` marker of the `auto_fix` read after an approved verdict (decision 28). */
export const AUTO_FIX_PATCH = 'fixer-auto-fix';

/** The `patched` marker of the verify child on `steward-findings` in place of `steward-heavy` (decision 29). */
export const VERIFIER_HOSTED_PATCH = 'verifier-hosted';

/** The GitHub deployment environment Vercel's integration posts production to. */
const PRODUCTION_ENVIRONMENT = 'Production';

export type FindingStopAfter = 'verdict' | 'resolved';

export interface FindingWorkflowInput {
  site: string;
  key: string;
  /** `owner/name` of the findings repository. */
  repo: string;
  /** `sites/<site>/findings/<key>.md` */
  findingPath: string;
  /** `sites/<site>/findings/INDEX.md` */
  indexPath: string;
  stopAfter: FindingStopAfter;
  /** `sites/<site>/handoffs/<key>.md`. Required for `'resolved'`. */
  handoffPath?: string;
  /** The fixer's branch in the site repository. Required for `'resolved'`. */
  branch?: string;
  /** The production origin every verify check must name. Required for `'resolved'`. */
  origin?: string;
}

/**
 * How a run ended. `verdict` and `rejected` end at the gate. The verify
 * outcomes end the lifecycle: `resolved`, `reopened`, and `confirmed` for a
 * finding with no checks resolved by its deploy (decision 30). `unverifiable`
 * is a run recorded before that. The two timeouts and `verify-failed` end it
 * with the finding still `fixing`.
 */
export type FindingOutcome = 'verdict' | 'rejected' | VerifyOutcome | 'merge-timeout' | 'deploy-timeout' | 'verify-failed';

export interface FindingWorkflowResult {
  site: string;
  key: string;
  verdict: FindingVerdict;
  /** The last commit the verdict write made, when the verdict came by CLI and changed the files. */
  commitSha: string | null;
  /** Absent from results recorded before the lifecycle. */
  outcome?: FindingOutcome;
  /** One line on how the run ended, for the CLI and the Web UI. */
  note?: string;
  /** The last fixer PR, or null when no fix opened one. */
  prUrl?: string | null;
  mergeSha?: string | null;
  /** The commit production served when the deploy wait ended. */
  liveSha?: string | null;
  verifyWorkflowId?: string | null;
  /** How many `fix` signals started a fix. */
  fixAttempts?: number;
}

/**
 * Where the run is. `waiting-verdict` until the verdict, then for a
 * `'resolved'` run one of the lifecycle steps, and `done` when it ends.
 */
export type FindingStep =
  | 'waiting-verdict'
  | 'waiting-fix'
  | 'fixing'
  | 'waiting-merge'
  | 'waiting-deploy'
  | 'verifying'
  | 'done';

export interface FindingState {
  site: string;
  key: string;
  /**
   * The verdict gate's own state: `done` once the verdict is recorded and
   * written. A `'resolved'` run is still open then; `step` says where.
   */
  status: 'waiting' | 'writing' | 'done';
  verdict: FindingVerdict | null;
  commitSha: string | null;
  /** Absent from a worker older than the lifecycle; read it as `'verdict'`. */
  stopAfter?: FindingStopAfter;
  step?: FindingStep;
  prUrl?: string | null;
  /** The fix issue of the current or last attempt. Absent from a worker older than the issue path. */
  issueUrl?: string | null;
  /** How many fixes have started, so a watcher tells its own attempt from an earlier one. */
  fixAttempts?: number;
  /** Why the last fix failed, while the run waits for the next `fix`. */
  lastFixError?: string | null;
}

/** The `fix` signal's payload: who asked, and when. `reconcile` is the hourly pass unparking a run (decision 31). */
export interface FixRequest {
  source: 'cli' | 'reconcile';
  /** ISO 8601, the sender's clock. */
  at: string;
}

export const verdictSignal = wf.defineSignal<[FindingVerdict]>('verdict');
export const fixSignal = wf.defineSignal<[FixRequest]>('fix');
export const findingStateQuery = wf.defineQuery<FindingState>('state');

/**
 * GitHub's permanent answers, as `gh` names them. A 401 or 403 is permanent
 * for a wrong token and transient during a rotation, and the two cases look
 * the same from here, so where it goes depends on how long the activity runs.
 * A write is five quick attempts, and five against a dead token is enough:
 * `AuthError` is permanent there. A wait runs for hours or days at a fixed
 * interval, which is where a rotation window lands, so a wait retries it at
 * that interval and its schedule-to-close bound is the give-up. The wait
 * activities throw the failure retryable themselves (`authRetryable` in
 * `lib/github.ts`): the flag `gh` sets would otherwise end the wait whatever
 * this policy says. On 2026-10-21 a rotation with the old token still in the
 * hosted worker ended every run parked in the merge wait on its next poll.
 */
const GITHUB_PERMANENT_FOR_WAITS = ['NotFound', 'UnprocessableRequest'];
const GITHUB_PERMANENT = ['AuthError', ...GITHUB_PERMANENT_FOR_WAITS];

/**
 * Five attempts with backoff, because the retryable failure here is a real one:
 * Argus pushing to the same repository between the read and the write, which
 * GitHub answers with 409 and the next attempt resolves from a fresh read. The
 * rest are permanent and named so they fail on the first attempt.
 */
const writing = wf.proxyActivities<
  Pick<typeof activities, 'writeFindingVerdict' | 'writeFindingReturned' | 'writeFindingFix' | 'openFixIssue' | 'readSiteAutoFix'>
>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      ...GITHUB_PERMANENT,
      'FindingMissing',
      'FindingMalformed',
      'FindingMoved',
      'FindingNotFixable',
      'UnknownSite',
    ],
  },
});

// The PR wait: every minute for up to 60. The Action took minutes in the
// spike, so an hour with no PR is a run that is not coming. A rejected
// credential is one more poll, not the end of the wait.
const awaitingPr = wf.proxyActivities<Pick<typeof activities, 'awaitFixPr'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '60 minutes',
  retry: {
    initialInterval: '1 minute',
    backoffCoefficient: 1,
    nonRetryableErrorTypes: GITHUB_PERMANENT_FOR_WAITS,
  },
});

// The merge wait: every 5 minutes for up to 30 days. No `maximumAttempts`, so
// no attempt cap; the schedule-to-close bound ends it. A PR a person has not
// merged yet is the normal case, not a failure, and so is a token being
// rotated under the worker: the next poll reads with the new one.
const merging = wf.proxyActivities<Pick<typeof activities, 'awaitFixPrMerge'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '30 days',
  retry: {
    initialInterval: '5 minutes',
    backoffCoefficient: 1,
    nonRetryableErrorTypes: [...GITHUB_PERMANENT_FOR_WAITS, 'FindingMalformed'],
  },
});

// The deploy wait: every 2 minutes for up to 24 hours. A Vercel build takes
// about three, so a day is a deploy that is not coming. A rejected credential
// is one more poll, as in the merge wait.
const deploying = wf.proxyActivities<Pick<typeof activities, 'awaitProductionDeploy'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '24 hours',
  retry: {
    initialInterval: '2 minutes',
    backoffCoefficient: 1,
    nonRetryableErrorTypes: GITHUB_PERMANENT_FOR_WAITS,
  },
});

function isVerdict(value: unknown): value is FindingVerdict {
  const v = value as FindingVerdict;
  return (
    typeof v === 'object' &&
    v !== null &&
    (v.status === 'approved' || v.status === 'rejected') &&
    (v.source === 'cli' || v.source === 'file') &&
    typeof v.reason === 'string' &&
    typeof v.at === 'string'
  );
}

/** A wait that ran out its schedule-to-close bound, rather than failing outright. */
function isTimeout(err: unknown): boolean {
  return err instanceof wf.ActivityFailure && (err.retryState === 'TIMEOUT' || err.cause instanceof wf.TimeoutFailure);
}

/** The innermost specific message of a failure chain. */
function describeError(err: unknown): string {
  let current: unknown = err;
  let best = '';
  for (let depth = 0; current instanceof Error && depth < 6; depth++) {
    if (current.message && !/^(Activity task failed|Child Workflow execution failed)$/.test(current.message)) {
      best = current.message;
    }
    current = (current as Error).cause;
  }
  return best || (err instanceof Error ? err.message : String(err));
}

function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

export async function findingWorkflow(input: FindingWorkflowInput): Promise<FindingWorkflowResult> {
  if (input.stopAfter !== 'verdict' && input.stopAfter !== 'resolved') {
    throw wf.ApplicationFailure.nonRetryable(
      `stopAfter "${String(input.stopAfter)}" is not a stop point this workflow knows.`,
      'UnknownStopPoint',
    );
  }
  if (input.stopAfter === 'resolved' && (!input.handoffPath || !input.branch || !input.origin)) {
    throw wf.ApplicationFailure.nonRetryable(
      'stopAfter "resolved" needs handoffPath, branch and origin in the input.',
      'UnknownStopPoint',
    );
  }

  const state: FindingState = {
    site: input.site,
    key: input.key,
    status: 'waiting',
    verdict: null,
    commitSha: null,
    stopAfter: input.stopAfter,
    step: 'waiting-verdict',
    prUrl: null,
    issueUrl: null,
    fixAttempts: 0,
    lastFixError: null,
  };

  wf.setHandler(findingStateQuery, () => state);

  // The first well-formed verdict wins. A later one (the reconciler catching up
  // on a verdict the CLI already delivered, or a second CLI call) is logged and
  // dropped: the record is what was decided first, and a signal cannot reopen it.
  wf.setHandler(verdictSignal, (verdict) => {
    if (!isVerdict(verdict)) {
      wf.log.warn('ignoring a malformed verdict signal', { key: input.key });
      return;
    }
    if (state.verdict) {
      wf.log.info('ignoring a later verdict; the first one stands', {
        key: input.key,
        first: `${state.verdict.status}/${state.verdict.source}`,
        later: `${verdict.status}/${verdict.source}`,
      });
      return;
    }
    state.verdict = verdict;
  });

  // A `fix` counts only while the run waits for one, or is about to: an
  // approved verdict and no fix in flight. One sent during a fix is dropped, so
  // a double send never queues a second fixer run behind the first.
  const fix = { requested: false };
  wf.setHandler(fixSignal, (request) => {
    const accepting =
      input.stopAfter === 'resolved' &&
      state.verdict?.status === 'approved' &&
      (state.step === 'waiting-verdict' || state.step === 'waiting-fix');
    if (!accepting) {
      wf.log.info('ignoring a fix signal', { key: input.key, step: state.step, at: request?.at });
      return;
    }
    fix.requested = true;
  });

  await wf.condition(() => state.verdict !== null);
  const verdict = state.verdict as unknown as FindingVerdict;

  if (verdict.source === 'cli') {
    state.status = 'writing';
    const written = await writing.writeFindingVerdict({
      repo: input.repo,
      site: input.site,
      key: input.key,
      findingPath: input.findingPath,
      indexPath: input.indexPath,
      status: verdict.status,
      reason: verdict.reason,
      at: verdict.at,
      source: verdict.source,
    });
    state.commitSha = written.commitSha;
  }
  state.status = 'done';

  const base = { site: input.site, key: input.key, verdict, commitSha: state.commitSha };
  if (input.stopAfter === 'verdict') {
    state.step = 'done';
    return base;
  }
  if (verdict.status === 'rejected') {
    state.step = 'done';
    return { ...base, outcome: 'rejected', note: 'Rejected at the gate.' };
  }

  return await lifecycle(input as Required<FindingWorkflowInput>, state, base, fix);
}

/**
 * Fix, merge, deploy, verify, looping back to the fix wait when a PR closes
 * unmerged or a fix child fails.
 */
async function lifecycle(
  input: Required<FindingWorkflowInput>,
  state: FindingState,
  base: Pick<FindingWorkflowResult, 'site' | 'key' | 'verdict' | 'commitSha'>,
  fix: { requested: boolean },
): Promise<FindingWorkflowResult> {
  let fixAttempts = 0;
  const end = (outcome: FindingOutcome, note: string, extra: Partial<FindingWorkflowResult> = {}): FindingWorkflowResult => {
    state.step = 'done';
    return { ...base, outcome, note, prUrl: state.prUrl ?? null, fixAttempts, ...extra };
  };

  // Read once, at the verdict: the flag the site had when the finding was approved.
  let autoFix = false;
  if (wf.patched(AUTO_FIX_PATCH)) {
    autoFix = await writing.readSiteAutoFix({ repo: input.repo, site: input.site });
  }

  // The last attempt's issue, and why it ended: the next attempt closes it with that.
  let lastIssue: { url: string; reason: string } | null = null;

  for (;;) {
    state.step = 'waiting-fix';
    if (!(autoFix && fixAttempts === 0)) await wf.condition(() => fix.requested);
    fix.requested = false;
    fixAttempts++;
    state.fixAttempts = fixAttempts;

    state.step = 'fixing';
    let prUrl: string;
    try {
      if (wf.patched(ACTION_ADAPTER_PATCH)) {
        const issue: FixIssue = await writing.openFixIssue({
          repo: input.repo,
          site: input.site,
          key: input.key,
          findingPath: input.findingPath,
          supersedes: lastIssue,
        });
        state.issueUrl = issue.url;
        lastIssue = { url: issue.url, reason: '' };
        try {
          prUrl = (await awaitingPr.awaitFixPr({ repo: issue.repo, issueNumber: issue.number })).prUrl;
        } catch (err) {
          if (isTimeout(err)) throw new Error(`No PR from ${issue.url} within 60 minutes.`);
          throw err;
        }
        // The custom fixer wrote this from inside its child; the Action cannot.
        await writing.writeFindingFix({
          repo: input.repo,
          site: input.site,
          key: input.key,
          findingPath: input.findingPath,
          indexPath: input.indexPath,
          prUrl,
        });
        // From here the only way back to the fix wait is the PR closing unmerged.
        lastIssue.reason = `${prUrl} closed unmerged`;
      } else {
        const fixed = await wf.executeChild(fixFindingWorkflow, {
          workflowId: fixWorkflowId(input.site, input.key),
          taskQueue: QUEUE_HEAVY,
          args: [
            {
              site: input.site,
              key: input.key,
              repo: input.repo,
              findingPath: input.findingPath,
              indexPath: input.indexPath,
              handoffPath: input.handoffPath,
              branch: input.branch,
              stopAfter: 'pr',
            },
          ],
        });
        prUrl = fixed.prUrl;
      }
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      state.lastFixError = describeError(err);
      if (lastIssue && !lastIssue.reason) lastIssue.reason = state.lastFixError;
      wf.log.warn('the fix failed; waiting for the next fix signal', { key: input.key, error: state.lastFixError });
      continue;
    }
    state.prUrl = prUrl;
    state.lastFixError = null;

    state.step = 'waiting-merge';
    let merge;
    try {
      merge = await merging.awaitFixPrMerge(prUrl);
    } catch (err) {
      if (isTimeout(err)) {
        return end('merge-timeout', `${prUrl} was not merged or closed within 30 days. The finding is still fixing.`);
      }
      throw err;
    }

    if (merge.state === 'closed') {
      await writing.writeFindingReturned({
        repo: input.repo,
        site: input.site,
        key: input.key,
        findingPath: input.findingPath,
        indexPath: input.indexPath,
        prUrl,
        at: nowIso(),
      });
      continue;
    }

    const mergeSha = merge.mergeSha as string;
    const pr = parsePrUrl(prUrl);
    if (!pr) throw wf.ApplicationFailure.nonRetryable(`${prUrl} is not a pull request URL.`, 'FindingMalformed');

    state.step = 'waiting-deploy';
    let deploy;
    try {
      deploy = await deploying.awaitProductionDeploy({ repo: pr.repo, mergeSha, environment: PRODUCTION_ENVIRONMENT });
    } catch (err) {
      if (isTimeout(err)) {
        return end(
          'deploy-timeout',
          `Production did not serve ${mergeSha.slice(0, 7)} within 24 hours. The finding is still fixing.`,
          { mergeSha },
        );
      }
      throw err;
    }

    state.step = 'verifying';
    const at = nowIso();
    const verifyId = verifyWorkflowId(input.site, input.key, at);
    const verifyQueue = wf.patched(VERIFIER_HOSTED_PATCH) ? QUEUE_FINDINGS : QUEUE_HEAVY;
    try {
      const verified = await wf.executeChild(verifyFindingWorkflow, {
        workflowId: verifyId,
        taskQueue: verifyQueue,
        args: [
          {
            site: input.site,
            key: input.key,
            repo: input.repo,
            findingPath: input.findingPath,
            indexPath: input.indexPath,
            handoffPath: input.handoffPath,
            origin: input.origin,
            at,
          },
        ],
      });
      const live = { mergeSha, liveSha: deploy.liveSha, verifyWorkflowId: verifyId };
      if (verified.outcome === 'confirmed') {
        return end(
          'confirmed',
          `Confirmed by its deploy: production serves ${(verified.deploy?.liveSha ?? deploy.liveSha).slice(0, 7)}, which contains ${mergeSha.slice(0, 7)}. No check could measure the fix.`,
          live,
        );
      }
      // A child recorded before decision 30 ended here; nothing produces it now.
      if (verified.outcome === 'unverifiable') {
        const why = verified.hasBlock === false ? 'has no verify block' : 'has an empty verify block';
        return end(
          'unverifiable',
          `Live at ${deploy.liveSha.slice(0, 7)}, but unverifiable: the finding ${why}, so no check ran. The finding is still fixing.`,
          live,
        );
      }
      return end(verified.outcome, `Verified on production at ${deploy.liveSha.slice(0, 7)}: ${verified.outcome}.`, live);
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      return end('verify-failed', `The verify failed: ${describeError(err)}. The finding is still fixing.`, {
        mergeSha,
        liveSha: deploy.liveSha,
        verifyWorkflowId: verifyId,
      });
    }
  }
}
