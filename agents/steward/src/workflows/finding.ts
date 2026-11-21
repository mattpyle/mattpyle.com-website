import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AwaitFixPrMergeOptions, FixIssue, FixPrOutcome } from '../activities/findings.js';
// Pure, no imports of its own: the ID, the paths and the verdict types are the
// same objects the reconciler and the CLI hold.
import {
  PREVIEW_SKIPPED_LINE,
  findingHandoffPath,
  fixBranch,
  fixWorkflowId,
  parsePrUrl,
  previewResultLine,
  verdictMeasureLine,
  verdictMeasurePassed,
  verifyWorkflowId,
  type FindingVerdict,
  type VerdictMeasure,
  type Verification,
  type PreviewChecksReport,
  type PreviewEarlierResult,
  type VerifyOutcome,
} from '../lib/findings.js';
import { dispatchWorkflowId } from '../lib/fix-dispatch.js';
import { fixFindingWorkflow } from './fix-finding.js';
import { releaseSlotSignal, slotGrantSignal } from './fix-dispatch.js';
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
 * **The `record-verdict` Update** (STW-636) is the same gate for a caller that
 * wants the answer: the CLI and the console send it. Its validator refuses a
 * malformed verdict, and one that disagrees with the verdict already taken.
 * Its handler sets the verdict the main body waits on and returns after the
 * write, with the verdict and the commit. The first well-formed verdict by
 * either path stands; a later Update of the same status is answered with it.
 * The handler and its waits issue no command, so the change carries no marker:
 * `finding-parked-before-verdict-update.bin` is the proof.
 *
 * **Settings are read when they are used** (STW-645, 2026-11-21). A run that
 * takes an approved verdict on this code reads `readFindingSettings` right
 * after the verdict write: the site's stop point (`stop_after: verdict` in its
 * `config.yaml`, or a site the worker knows no production origin for, ends the
 * run there), the origin, `auto_fix`, and the finding file's status, kind and
 * the fixer's gate (`fixRefusal`). The input's `stopAfter`, `origin` and
 * `waitsForPerson` are not read on that path, in either direction: a run
 * started as `'verdict'` goes on when the site now fixes findings, and a run
 * started as `'resolved'` ends at its verdict when the site now stops there.
 * The steps:
 *
 * 1. The stop point, at step `reading-settings`. A site that stops ends the
 *    run with the result a `'verdict'` run always had.
 * 2. The measurement at the verdict, below, with the origin just read.
 * 3. The settings again, as the decision. `auto_fix` on and the gate accepting
 *    start the attempt. Anything else parks the run at `waiting-fix` with
 *    `fixAttempts` 0, no slot asked for and no issue tried; a refusal is in
 *    `lastFixError`.
 * 4. Parked with no issue, the run reads the settings again once a day. It
 *    attempts when `auto_fix` is on and the gate accepts, so a flag set after
 *    the verdict, or a finding edited until it passes, needs no signal. It ends
 *    `closed` when the file says `resolved` or `rejected`. The close applies at
 *    `waiting-fix` only, and only to a run that holds no slot and has opened no
 *    issue (and so no PR). A run that has opened an issue reads nothing and
 *    waits for a person's `fix`: the re-read never opens a second issue.
 *
 * A read that fails is retried for up to 30 days ({@link settling}); the run
 * makes no attempt and does not end on a guess while it waits.
 *
 * **Versioned with `patched`.** {@link SETTINGS_AT_USE_PATCH} is read once, on
 * an approved verdict, before anything else. A run with the marker records no
 * `verdict-measure` and no `fixer-auto-fix` marker: it always measures, and
 * `readSiteAutoFix` is not called. Every history recorded before it lacks the
 * marker: a run past its approved verdict replays what follows from its input,
 * `waitsForPerson` included, and a run parked at `waiting-fix` then still
 * waits for a `fix` signal. A rejected verdict reads nothing and records no
 * marker. The fixtures are `finding-waits-for-person-parked-pre.bin` (the old
 * path) and `finding-settings-at-use.bin` (the new one) in
 * `tests/workflows/replay.test.ts`.
 *
 * **`stopAfter`** is where a run without that marker ends.
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
 * **What rides where** (design rule 10). The finding's identity is in the
 * input: the site, the key, the repository and the two paths. The verdict and
 * the fix request are signals or an Update, so the history records who decided
 * what. A setting that can change while a run waits (the stop point, the
 * origin, `auto_fix`, the gate) is the result of an activity scheduled when
 * the run needs it, so the history records the value it acted on and a replay
 * reads that value back. The workflow code itself reads no config and no
 * environment. The input still carries `stopAfter`, the branch, the handoff
 * path, the origin and `waitsForPerson` for histories recorded before
 * {@link SETTINGS_AT_USE_PATCH}, which decide from them.
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
 * and opens a new one. `auto_fix` covers the first attempt only. What follows
 * is the wait of a history without the settings marker. A run started
 * with `waitsForPerson` (a direction, which the gate never accepts) parks at
 * `waiting-fix` with `fixAttempts` 0 and waits for a `fix` signal. Any other
 * run attempts at the verdict and the gate in `openFixIssue` decides: a refusal
 * sets `lastFixError` and parks the run, and the hourly reconciler sends `fix`
 * once the finding passes (a run with no issue is the test, not no attempt).
 *
 * **`waitsForPerson` carries no marker** (2026-10-23). It is a new optional input
 * field read as `=== true`, so a history recorded without it takes the branch it
 * always took, the automatic attempt. A run that has it was started after this
 * shipped and has no earlier history to disagree. The `readSiteAutoFix` call
 * stays where it was, so no command is added, removed or moved. The
 * `finding-opportunity-auto-fix-attempt.bin` fixture in
 * `tests/workflows/replay.test.ts` is an opportunity that made and failed its
 * attempt, recorded before this change, and replays green.
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
 *
 * **Dispatch by surface** (fix-dispatch-by-surface, 2026-10-30). Each attempt
 * now asks the site's `fixDispatchWorkflow` for a slot before it opens its
 * issue: `requestFixSlot` sends the repository paths the finding's cause names,
 * the run parks at `waiting-slot`, and the dispatcher's `slot-grant` signal
 * resumes it. A fix that names a path an in-flight fix names waits until that
 * fix is live, so its PR is cut from a `master` that already has the first.
 * A finding whose cause names no path is granted by the activity itself.
 *
 * The slot is released on every exit from the fix loop: live on production,
 * the PR closed unmerged, a conflict, a failed fix, either timeout, and the run
 * ending for any other reason (the `finally`, outside cancellation). A
 * dispatched attempt's merge wait also reports a PR GitHub computes as
 * conflicting: the run closes it with a comment naming the sibling PR,
 * releases its slot, asks for a new one without waiting for a `fix`, and opens
 * a fresh issue once granted, which closes the last one with the reason.
 *
 * **Versioned with `patched`, per attempt.** {@link FIX_DISPATCH_PATCH} is read
 * after the fix wait of each attempt, as {@link ACTION_ADAPTER_PATCH} is. An
 * attempt recorded before it has no marker and replays straight to
 * `openFixIssue`, with the merge wait it scheduled and no release. A run
 * parked at `waiting-fix` before this shipped takes the slot on its next
 * attempt. The fixture is `finding-pr-closed-before-dispatch.bin` in
 * `tests/workflows/replay.test.ts`.
 *
 * **The preview test** (fix-pr-runs-the-verify-block, 2026-10-31). Once
 * `awaitFixPr` returns the PR, the run reads the finding's `verify:` block and,
 * when it has checks, waits for the PR head's Vercel preview, runs the checks
 * against it, and writes the measured values as one PR comment. A failed check
 * also turns the PR into a draft; "The retest" below says how it can be tested
 * again and un-drafted. The run then waits on the merge as before. The step is `testing-preview`, and
 * `previewResult` holds how it came out in one line.
 *
 * Nothing in it fails the fix. A block that does not read, a preview that does
 * not come in {@link PREVIEW_WAIT}, a worker without the bypass secret
 * (`PreviewBypassMissing`) and a check that does not run are each recorded as
 * unmeasured, with the reason in the comment. The checks still run on
 * production after the merge.
 *
 * **Versioned with `patched`.** {@link PREVIEW_TEST_PATCH} is read per attempt,
 * on the issue path only, right after the PR is known. An attempt recorded
 * before it has no marker and replays straight to the merge wait. The custom
 * fixer's child ran its own preview test and is untouched. The fixture is
 * `finding-pr-closed-before-preview-test.bin` in `tests/workflows/replay.test.ts`.
 *
 * **The retest** (STW-587, 2026-11-10). On the issue path, after a test that
 * found the finding's checks, the merge wait can end in two more ways, and
 * each runs `testOnPreview` again on the same PR and goes back to the wait:
 *
 * 1. A new head commit. The wait passes `retestAfter`, the commit the last
 *    test measured, and `awaitFixPrMerge` returns `pushed` when the open PR's
 *    head is another commit. A test that measured no commit (no preview in
 *    {@link PREVIEW_WAIT}, a failed build) passes nothing, and the next route
 *    is the one left.
 * 2. The `retest` Update, which `steward finding retest` sends. Its validator
 *    refuses, read-only, when the run is not in that merge wait, the finding
 *    has no checks, a test is running or a retest is already asked for. A
 *    refused Update never enters the history. The handler only sets a flag and
 *    returns the PR, the commit last tested and the number the next test gets.
 *
 * The wait races the merge poll against `wf.condition(() => retest.requested)`
 * inside one `CancellationScope`. The condition has no timeout, so it adds no
 * timer command. When the Update wins, the scope cancels the poll. The poll
 * keeps the default cancellation type, `TRY_CANCEL`: the run goes on at once
 * and does not wait for the activity to acknowledge. `awaitFixPrMerge` does not
 * heartbeat, so the cancellation never reaches a running attempt; an attempt
 * in flight finishes its one read (seconds) and its result is dropped, and one
 * waiting out its five-minute retry interval is cancelled by the server. When
 * a merge result and a retest arrive in the same workflow task, the merge
 * wins: the activity's result settles the race as its job is applied, and the
 * condition is evaluated only after every job. The accepted Update then has no
 * test behind it, and the run goes on to the deploy.
 *
 * Each retest schedules a fresh merge wait, so the 30-day merge timeout starts
 * again from the retest.
 *
 * A pass clears the draft only when Steward set it (`reportPreviewChecks`
 * reads who did from the PR's timeline). The comment is rewritten in place,
 * with one line per earlier result. A PR that merges while its last test
 * failed hands that result to the verify child as `previewAtMerge`, and the
 * Verification section says so beside the production result.
 *
 * **No `patched` marker.** No history recorded before this change can reach
 * the new commands. They start only after a merge wait that returned `pushed`
 * or lost to a `retest` Update, and no earlier history holds either: the state
 * did not exist and no handler accepted the Update. Up to that point the run
 * issues the same commands as before. The new `retestAfter` option and the
 * `earlier` and `previewAtMerge` fields change activity and child inputs,
 * which replay does not compare. The race, the scope, the condition and the
 * Update handler issue no command. This is determinism rule 5 in
 * `agents/steward/CLAUDE.md`. The fixture is
 * `finding-preview-passed-before-retest.bin` in `tests/workflows/replay.test.ts`:
 * a run recorded before this change that passed its preview test and waited
 * on the merge. A run whose merge wait was scheduled before this change was
 * scheduled without `retestAfter`, so a push does not retest it; the Update
 * does, once the worker runs this code.
 *
 * **The measurement at the verdict** (STW-589, 2026-11-11). Right after an
 * approved verdict, before `readSiteAutoFix` and so before any slot or issue,
 * the run reads the finding's `verify:` block and runs its checks on
 * production with `runFindingChecks`. Production is still broken then, so the
 * values are a true before. `writeFindingVerdictMeasure` writes them into the
 * finding file as a `## Measured at the verdict` section, in the Verification
 * section's check-line shape. The step is `measuring`, and `verdictMeasure`
 * holds the result in one line for `steward finding status`.
 *
 * 1. A check fails: the section holds the values, and the fix goes on as before.
 * 2. Every check passes: the problem is already gone. The same commit resolves
 *    the finding with a Verification section that says so, as the recheck
 *    does, and the run ends `resolved` with no slot and no issue. A person
 *    reopens it from the dashboard.
 * 3. No checks, a block that does not read, production not answering, or a
 *    check that does not run: the section records the reason, and the fix goes
 *    on. So does a write that fails after its retries, when a check failed or
 *    nothing was measured.
 * 4. The run holds, and no fix starts, in two cases. The write refuses with
 *    `FindingMoved`: a person or another run moved the finding while it was
 *    measured, as when `writeFindingFix` meets a moved finding. Or every check
 *    passed and the write failed: a fix would act on a problem just measured
 *    as gone. The run parks at `waiting-fix` with the reason in `lastFixError`.
 *    A `fix` signal that arrived during `measuring` is dropped then; a person's
 *    later `fix` starts the attempt, and the reconciler closes the run behind a
 *    `resolved` or `rejected` line.
 *
 * It runs once per run, not once per fix attempt: a second attempt after a PR
 * closed unmerged does not measure again. Its activities run on
 * `steward-findings` like the rest, so a batch of verdicts queues its
 * measurements behind that queue's activity concurrency in `hosted-registry.ts`.
 *
 * **Versioned with `patched`.** {@link VERDICT_MEASURE_PATCH} is read once, as
 * the first thing the fix loop does. A history recorded before it has the
 * `fixer-auto-fix` marker and `readSiteAutoFix` next, so it replays straight
 * to them. The fixture is `finding-approved-before-verdict-measure.bin` in
 * `tests/workflows/replay.test.ts`; its docblock holds the probe.
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

/** The `patched` marker of an attempt's slot from `dispatch/<site>` and its conflict re-cut (fix-dispatch-by-surface). */
export const FIX_DISPATCH_PATCH = 'fix-dispatch';

/** The `patched` marker of the preview test between the fix PR and its merge wait (fix-pr-runs-the-verify-block). */
export const PREVIEW_TEST_PATCH = 'fix-preview-test';

/** The `patched` marker of the checks measured on production at an approved verdict (STW-589). */
export const VERDICT_MEASURE_PATCH = 'verdict-measure';

/**
 * The `patched` marker of the settings read at an approved verdict (STW-645):
 * the stop point, `auto_fix` and the fixer's gate come from `readFindingSettings`
 * there, and a parked run reads them again once a day.
 */
export const SETTINGS_AT_USE_PATCH = 'settings-at-use';

/** How often a run parked at `waiting-fix` with no issue reads its settings again. */
const PARKED_REREAD = '1 day';

/**
 * How long a run waits for the fix PR's preview. A Vercel preview takes about
 * three minutes, so half an hour is a preview that is not coming.
 */
const PREVIEW_WAIT = '30 minutes';

/**
 * How long a run waits for its grant before it sends the same request again.
 * The dispatcher reads a re-send as the request it holds; the re-send exists
 * so a dispatcher that ended (terminated by hand, say) is started again and
 * hears of the run.
 */
const SLOT_RESEND = '6 hours';

/** The GitHub deployment environment Vercel's integration posts production to. */
const PRODUCTION_ENVIRONMENT = 'Production';

/** The one Vercel's integration posts a pull request's preview to. */
const PREVIEW_ENVIRONMENT = 'Preview';

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
  /**
   * The stop point the starter knew. A history without the
   * {@link SETTINGS_AT_USE_PATCH} marker ends where this says. A run that takes
   * an approved verdict with the marker reads the stop point then and ignores
   * this. Optional since STW-645: an input that names none is accepted, and
   * the callers still send it for a worker that runs the earlier code.
   */
  stopAfter?: FindingStopAfter;
  /** `sites/<site>/handoffs/<key>.md`. Required for `'resolved'`. */
  handoffPath?: string;
  /** The fixer's branch in the site repository. Required for `'resolved'`. */
  branch?: string;
  /**
   * The production origin every verify check must name. Required for
   * `'resolved'`. Read by a history without the marker; a run with it takes
   * the origin from `readFindingSettings`.
   */
  origin?: string;
  /**
   * Set by the reconciler when the index line's kind is not `defect`: the
   * fixer's gate refuses such a finding, so the run parks at `waiting-fix`
   * without the automatic attempt. Read as `=== true` (determinism rule 3):
   * a history recorded before the field existed made that attempt. Read only
   * by a history without the marker: a run with it asks the gate at the verdict.
   */
  waitsForPerson?: boolean;
}

/**
 * How a run ended. `verdict` and `rejected` end at the gate. The verify
 * outcomes end the lifecycle: `resolved`, `reopened`, and `confirmed` for a
 * finding with no checks resolved by its deploy (decision 30). `unverifiable`
 * is a run recorded before that. The two timeouts and `verify-failed` end it
 * with the finding still `fixing`. `closed` is a run parked at `waiting-fix`
 * with no issue whose file was decided elsewhere (STW-645).
 */
export type FindingOutcome =
  | 'verdict'
  | 'rejected'
  | VerifyOutcome
  | 'merge-timeout'
  | 'deploy-timeout'
  | 'verify-failed'
  | 'closed';

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
 * Where the run is. `waiting-verdict` until the verdict, `reading-settings`
 * while an approved run reads its stop point (STW-645), then for a run that
 * goes on one of the lifecycle steps, and `done` when it ends.
 */
export type FindingStep =
  | 'waiting-verdict'
  | 'reading-settings'
  | 'measuring'
  | 'waiting-fix'
  | 'waiting-slot'
  | 'fixing'
  | 'testing-preview'
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
  /**
   * The input's stop point until an approved verdict, then the one the run
   * read (STW-645). Absent from a worker older than the lifecycle, and from a
   * run started with none before its verdict; read it as `'verdict'`.
   */
  stopAfter?: FindingStopAfter;
  step?: FindingStep;
  prUrl?: string | null;
  /** The fix issue of the current or last attempt. Absent from a worker older than the issue path. */
  issueUrl?: string | null;
  /** How many fixes have started, so a watcher tells its own attempt from an earlier one. */
  fixAttempts?: number;
  /** Why the last fix failed, while the run waits for the next `fix`. */
  lastFixError?: string | null;
  /**
   * True while the run is parked at `waiting-fix` because the finding is not a
   * defect, and no attempt has been made. `steward finding status` prints it.
   */
  waitsForPerson?: boolean;
  /**
   * The repository paths the current attempt's slot request named, once the
   * request is sent. `steward finding status` prints them at `waiting-slot`.
   * Absent from a run whose attempts predate the dispatcher.
   */
  slotPaths?: string[];
  /**
   * How the current attempt's preview test came out, in one line. Set when
   * `testing-preview` ends; absent from a run whose attempt predates the test.
   */
  previewResult?: string | null;
  /** The commit the latest preview test measured, or null when it measured none. Absent before STW-587. */
  previewSha?: string | null;
  /** How many preview tests the current attempt has run. Absent before STW-587. */
  previewTests?: number;
  /** True from an accepted `retest` Update until the test it asked for starts. */
  retestRequested?: boolean;
  /**
   * What the checks measured on production at the approved verdict, in one
   * line, with the reason when nothing was measured. Absent before STW-589.
   */
  verdictMeasure?: string | null;
}

/** The `fix` signal's payload: who asked, and when. `reconcile` is the hourly pass unparking a run (decision 31). */
export interface FixRequest {
  source: 'cli' | 'reconcile';
  /** ISO 8601, the sender's clock. */
  at: string;
}

/** The `retest` Update's payload: who asked, and when (STW-587). */
export interface RetestRequest {
  source: 'cli';
  /** ISO 8601, the sender's clock. */
  at: string;
}

/** What an accepted `retest` Update returns, so the CLI answers from one call. */
export interface RetestAccepted {
  prUrl: string;
  /** The commit the last test measured, or null when it measured none. */
  testedSha: string | null;
  /** The number the test it asked for will have: 2 for the first retest. */
  test: number;
}

/**
 * What the `record-verdict` Update returns (STW-636): the verdict the run
 * recorded and its commit, read after the write.
 */
export interface VerdictRecorded {
  /** The recorded verdict. It is the earlier one when `first` is false. */
  verdict: FindingVerdict;
  /** The commit that wrote it, or null when nothing was written (a file verdict, or a file that already carried it). */
  commitSha: string | null;
  /** True when this Update's verdict is the one recorded; false when an earlier verdict of the same status stands. */
  first: boolean;
  /**
   * The stop point the run was started with (`'resolved'` when it named none),
   * so the caller knows whether an approved run may go on. The run reads the
   * site's stop point after this answer (STW-645), and that read decides.
   */
  stopAfter: FindingStopAfter;
}

/** The failure type of a `record-verdict` Update whose write failed or was cancelled. */
export const VERDICT_WRITE_FAILED = 'VerdictWriteFailed';
const VERDICT_CANCELLED = 'The run was cancelled before the verdict was written.';

export const verdictSignal = wf.defineSignal<[FindingVerdict]>('verdict');
/**
 * The verdict as an Update (STW-636): the validator refuses at once, and the
 * handler returns after the write. The name differs from the Signal's.
 * Rollback: a run whose history holds an accepted `record-verdict` Update
 * needs a worker that has this handler.
 */
export const verdictUpdate = wf.defineUpdate<VerdictRecorded, [FindingVerdict]>('record-verdict');
export const retestUpdate = wf.defineUpdate<RetestAccepted, [RetestRequest]>('retest');
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
  Pick<
    typeof activities,
    | 'writeFindingVerdict'
    | 'writeFindingReturned'
    | 'writeFindingFix'
    | 'openFixIssue'
    | 'readSiteAutoFix'
    | 'requestFixSlot'
    | 'closeConflictingFixPr'
    | 'writeFindingVerdictMeasure'
  >
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

// The preview test's reads: the finding and its block. A block that does not
// validate and a finding that moved are not mended by a retry.
const readingChecks = wf.proxyActivities<Pick<typeof activities, 'readFinding' | 'readVerifyBlock'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'FindingMissing', 'FindingMalformed', 'VerifyBlockInvalid'],
  },
});

// The preview wait: every 30 seconds for up to half an hour. A failed build
// (`PreviewFailed`) is a permanent answer. A rejected credential is one more
// poll, as in the merge wait.
const previewing = wf.proxyActivities<Pick<typeof activities, 'awaitPrPreview'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: PREVIEW_WAIT,
  retry: {
    initialInterval: '30 seconds',
    backoffCoefficient: 1,
    nonRetryableErrorTypes: [...GITHUB_PERMANENT_FOR_WAITS, 'PreviewFailed', 'FindingMalformed'],
  },
});

// The verifier's policy, for the same reason: what is retried is the preview
// answering 5xx while it warms. A broken check and a worker with no bypass
// secret are not mended by a retry.
const checking = wf.proxyActivities<Pick<typeof activities, 'runFindingChecks'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '15 seconds',
    backoffCoefficient: 4,
    nonRetryableErrorTypes: ['VerifyCheckBroken', 'PreviewBypassMissing'],
  },
});

// The measurement at the verdict: production, with the recheck's policy. Twelve
// browser checks take about eight minutes, so the bound leaves room for
// Chrome's launch. A check whose own expression does not run is not mended by
// a retry; production answering 5xx is retried once.
const measuring = wf.proxyActivities<Pick<typeof activities, 'runFindingChecks'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2, initialInterval: '30 seconds', nonRetryableErrorTypes: ['VerifyCheckBroken'] },
});

// The comment and the draft: both safe to repeat, so five attempts with backoff.
const reporting = wf.proxyActivities<Pick<typeof activities, 'reportPreviewChecks'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [...GITHUB_PERMANENT, 'FindingMalformed'],
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

// The settings read (STW-645): the stop point, `auto_fix` and the gate, from the
// findings repository. It is a wait, not a write: a run that cannot read its
// settings makes no guess, so the read retries with backoff up to a quarter of
// an hour apart for up to 30 days, a rejected credential included, and the
// pending activity shows in `steward finding status`. Only then does the run fail.
const settling = wf.proxyActivities<Pick<typeof activities, 'readFindingSettings'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '30 days',
  retry: {
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumInterval: '15 minutes',
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

/** An activity that refused because a person or another run moved the finding. */
function isFindingMoved(err: unknown): boolean {
  return err instanceof wf.ActivityFailure && err.cause instanceof wf.ApplicationFailure && err.cause.type === 'FindingMoved';
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
  if (input.stopAfter !== undefined && input.stopAfter !== 'verdict' && input.stopAfter !== 'resolved') {
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
    // `state.stopAfter` is the input's until a run reads its own (STW-645).
    const accepting =
      state.stopAfter === 'resolved' &&
      state.verdict?.status === 'approved' &&
      (state.step === 'waiting-verdict' ||
        state.step === 'reading-settings' ||
        state.step === 'measuring' ||
        state.step === 'waiting-fix');
    if (!accepting) {
      wf.log.info('ignoring a fix signal', { key: input.key, step: state.step, at: request?.at });
      return;
    }
    fix.requested = true;
  });

  // The dispatcher's grant counts only for the request the run is waiting on.
  // A grant for an earlier ticket (an attempt already released) is dropped.
  const slot: Slot = { ticket: 0, granted: false, active: false, dispatched: false };
  wf.setHandler(slotGrantSignal, (grant) => {
    if (slot.active && grant?.ticket === slot.ticket) slot.granted = true;
  });

  // The retest (STW-587). `open` is set by the merge wait alone, so the
  // validator refuses everywhere else; the handler only sets the flag.
  const retest: Retest = { open: false, requested: false, prUrl: null, testedSha: null };
  wf.setHandler(
    retestUpdate,
    (): RetestAccepted => {
      retest.requested = true;
      state.retestRequested = true;
      return { prUrl: retest.prUrl as string, testedSha: retest.testedSha, test: (state.previewTests ?? 0) + 1 };
    },
    {
      validator: (request: RetestRequest): void => {
        const refusal = retestRefusal(state, retest, request);
        if (refusal) throw new Error(refusal);
      },
    },
  );

  // The verdict as an Update (STW-636). One rule for a verdict by either
  // path: the first well-formed one to reach the run stands. A later one of
  // the same status is answered with the first; a later one of the other
  // status is refused here, where the Signal handler above drops it.
  //
  // The handler starts no activity: it sets the verdict the main body waits
  // on, so a verdict by Update issues the commands a verdict by Signal does.
  // It returns once the verdict is recorded (`state.status` is `done`), not
  // while it is in flight (`state.verdict` set, the write not yet back), and
  // fails when the write fails. Neither wait issues a command.
  const write: { failed: string | null } = { failed: null };
  wf.setHandler(
    verdictUpdate,
    async (verdict): Promise<VerdictRecorded> => {
      const first = state.verdict === null;
      if (first) state.verdict = verdict;
      try {
        await wf.condition(() => state.status === 'done' || write.failed !== null);
      } catch (err) {
        // The handler runs in the run's own scope, so a cancelled run ends this wait too.
        if (!wf.isCancellation(err)) throw err;
        throw wf.ApplicationFailure.nonRetryable(VERDICT_CANCELLED, VERDICT_WRITE_FAILED);
      }
      if (state.status !== 'done') {
        throw wf.ApplicationFailure.nonRetryable(write.failed as string, VERDICT_WRITE_FAILED);
      }
      return { verdict: state.verdict as FindingVerdict, commitSha: state.commitSha, first, stopAfter: input.stopAfter ?? 'resolved' };
    },
    {
      validator: (verdict: FindingVerdict): void => {
        const refusal = verdictRefusal(state, verdict);
        if (refusal) throw new Error(refusal);
      },
    },
  );

  await wf.condition(() => state.verdict !== null);
  const verdict = state.verdict as unknown as FindingVerdict;

  if (verdict.source === 'cli') {
    state.status = 'writing';
    let written;
    try {
      written = await writing.writeFindingVerdict({
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
    } catch (err) {
      // A waiting Update is answered before the run ends on the failure.
      write.failed = wf.isCancellation(err)
        ? VERDICT_CANCELLED
        : `The verdict was not written: ${describeError(err)}`;
      await wf.CancellationScope.nonCancellable(() => wf.condition(wf.allHandlersFinished));
      throw err;
    }
    state.commitSha = written.commitSha;
  }
  state.status = 'done';
  // A waiting Update returns before the run can close on the next lines.
  await wf.condition(wf.allHandlersFinished);

  const base = { site: input.site, key: input.key, verdict, commitSha: state.commitSha };

  // Settings at use (STW-645). An approved verdict that arrives on this code
  // reads the site's stop point here, whatever the input says. A history
  // recorded before the marker replays the lines below it, from its input. A
  // rejected verdict ends at the gate either way, so it reads nothing and
  // records no marker.
  if (verdict.status === 'approved' && wf.patched(SETTINGS_AT_USE_PATCH)) {
    state.step = 'reading-settings';
    const settings = await settling.readFindingSettings({
      repo: input.repo,
      site: input.site,
      key: input.key,
      findingPath: input.findingPath,
    });
    state.stopAfter = settings.stopAfter;
    if (settings.stopAfter !== 'resolved' || !settings.origin) {
      state.step = 'done';
      return base;
    }
    const atUse: Required<FindingWorkflowInput> = {
      ...input,
      stopAfter: 'resolved',
      origin: settings.origin,
      handoffPath: input.handoffPath ?? findingHandoffPath(input.site, input.key),
      branch: input.branch ?? fixBranch(input.key),
      waitsForPerson: false,
    };
    return await lifecycle(atUse, state, base, fix, slot, retest, true);
  }

  if (input.stopAfter === 'verdict') {
    state.step = 'done';
    return base;
  }
  if (verdict.status === 'rejected') {
    state.step = 'done';
    return { ...base, outcome: 'rejected', note: 'Rejected at the gate.' };
  }
  if (input.stopAfter !== 'resolved') {
    // Not reached: an approved verdict on an input with no stop point took the marker above.
    state.step = 'done';
    return base;
  }

  return await lifecycle(input as Required<FindingWorkflowInput>, state, base, fix, slot, retest, false);
}

/**
 * The retest's shared state. `open` while the merge wait can take a retest:
 * the issue path, after a test that found checks. `prUrl` and `testedSha` are
 * what the handler returns.
 */
interface Retest {
  open: boolean;
  requested: boolean;
  prUrl: string | null;
  testedSha: string | null;
}

/**
 * Why a `record-verdict` Update is refused, in a sentence the CLI prints, or
 * null to accept it. Read-only. A verdict that agrees with the one already
 * taken is accepted, so a retry after a lost reply is harmless.
 */
function verdictRefusal(state: FindingState, verdict: FindingVerdict): string | null {
  if (!isVerdict(verdict)) return 'The verdict is malformed.';
  if (state.verdict && state.verdict.status !== verdict.status) {
    return `A verdict is already recorded: ${state.verdict.status} (source ${state.verdict.source}).`;
  }
  return null;
}

/**
 * Why a `retest` Update is refused, in a sentence the CLI prints, or null to
 * accept it. Read-only: a validator issues no command and changes nothing.
 */
function retestRefusal(state: FindingState, retest: Retest, request: RetestRequest): string | null {
  if (!request || request.source !== 'cli' || typeof request.at !== 'string') return 'The retest request is malformed.';
  if (state.stopAfter !== 'resolved') return 'This run ends at the verdict, so it has no fix PR to test.';
  if (state.step === 'testing-preview') return `A preview test of ${state.prUrl ?? 'the fix PR'} is running now.`;
  if (state.step !== 'waiting-merge' || !state.prUrl) {
    return `The finding has no open fix PR: the run is at ${state.step ?? 'an unknown step'}.`;
  }
  if (state.previewResult === PREVIEW_SKIPPED_LINE) return 'The finding has no checks, so there is nothing to test.';
  if (!retest.open) return `The run cannot test ${state.prUrl} again: it has no preview test on this attempt.`;
  if (retest.requested) return `A retest of ${state.prUrl} is already asked for.`;
  return null;
}

/** What one preview test found, as the merge wait reads it. */
interface PreviewOutcome {
  /** The commit measured, or null when none was. */
  sha: string | null;
  /** False for a finding with no checks: nothing to test, now or later. */
  hasChecks: boolean;
  /** True when the checks ran and at least one failed. */
  failed: boolean;
  /** The result line, as `previewResult` holds it before any comment error. */
  line: string;
}

/**
 * The current attempt's slot. `active` from the request until the release,
 * granted or not; `dispatched` when the dispatcher holds it, so the release
 * goes there.
 */
interface Slot {
  ticket: number;
  granted: boolean;
  active: boolean;
  dispatched: boolean;
}

/**
 * Fix, merge, deploy, verify, looping back to the fix wait when a PR closes
 * unmerged or a fix fails, and straight to a new slot when a dispatched PR
 * conflicts.
 */
async function lifecycle(
  input: Required<FindingWorkflowInput>,
  state: FindingState,
  base: Pick<FindingWorkflowResult, 'site' | 'key' | 'verdict' | 'commitSha'>,
  fix: { requested: boolean },
  slot: Slot,
  retest: Retest,
  /** True for a run that took the {@link SETTINGS_AT_USE_PATCH} marker at its verdict. */
  atUse: boolean,
): Promise<FindingWorkflowResult> {
  let fixAttempts = 0;
  const end = (outcome: FindingOutcome, note: string, extra: Partial<FindingWorkflowResult> = {}): FindingWorkflowResult => {
    state.step = 'done';
    return { ...base, outcome, note, prUrl: state.prUrl ?? null, fixAttempts, ...extra };
  };
  const workflowId = wf.workflowInfo().workflowId;

  /**
   * Asks for this attempt's slot and waits for the grant. A finding that names
   * no path is granted by the activity. A grant that has not come in
   * {@link SLOT_RESEND} is asked for again with the same ticket.
   */
  const takeSlot = async (ticket: number): Promise<void> => {
    slot.ticket = ticket;
    slot.granted = false;
    slot.active = true;
    slot.dispatched = false;
    const request = {
      repo: input.repo,
      site: input.site,
      key: input.key,
      findingPath: input.findingPath,
      workflowId,
      ticket,
      at: nowIso(),
    };
    const requested = await writing.requestFixSlot(request);
    state.slotPaths = requested.paths;
    if (!requested.dispatched) return;
    slot.dispatched = true;
    while (!(await wf.condition(() => slot.granted, SLOT_RESEND))) {
      const again = await writing.requestFixSlot({ ...request, at: nowIso() });
      // The cause no longer names a path: nothing to wait for.
      if (!again.dispatched) return;
    }
  };

  /** Gives the slot back. A no-op when none is held; a dispatcher that is gone has nothing to release. */
  const release = async (reason: string): Promise<void> => {
    if (!slot.active) return;
    slot.active = false;
    slot.granted = false;
    if (!slot.dispatched) return;
    try {
      await wf
        .getExternalWorkflowHandle(dispatchWorkflowId(input.site))
        .signal(releaseSlotSignal, { workflowId, ticket: slot.ticket, reason });
    } catch (err) {
      wf.log.warn('the slot release did not reach the dispatcher', { key: input.key, reason, error: describeError(err) });
    }
  };

  /**
   * The preview test (fix-pr-runs-the-verify-block). Never throws except for
   * cancellation: whatever stops it is recorded as an unmeasured preview, and
   * the merge wait goes on. `earlier` holds this PR's earlier results for the
   * comment, empty on the first test. The result says what the merge wait
   * needs: the commit measured, whether the finding has checks, and whether
   * one failed.
   */
  const testOnPreview = async (prUrl: string, earlier: PreviewEarlierResult[]): Promise<PreviewOutcome> => {
    state.step = 'testing-preview';
    state.previewResult = null;
    state.retestRequested = false;
    state.previewTests = (state.previewTests ?? 0) + 1;
    const report = async (result: PreviewChecksReport): Promise<PreviewOutcome> => {
      const line = previewResultLine(result);
      state.previewResult = line;
      state.previewSha = result.sha;
      try {
        await reporting.reportPreviewChecks({ ...result, key: input.key, earlier });
      } catch (err) {
        if (wf.isCancellation(err)) throw err;
        state.previewResult = `${line} (the PR comment failed: ${describeError(err)})`;
      }
      const failed = result.results !== null && result.results.some((row) => !row.pass);
      return { sha: result.sha, hasChecks: true, failed, line };
    };
    const unmeasured = (note: string, sha: string | null = null): Promise<PreviewOutcome> =>
      report({ prUrl, sha, results: null, note });

    let checks;
    try {
      const finding = await readingChecks.readFinding(input.repo, input.findingPath);
      checks = (
        await readingChecks.readVerifyBlock({
          repo: input.repo,
          findingPath: input.findingPath,
          findingText: finding.text,
          origin: input.origin,
        })
      ).checks;
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      return await unmeasured(`The finding's checks could not be read: ${describeError(err)}.`);
    }
    if (checks.length === 0) {
      state.previewResult = PREVIEW_SKIPPED_LINE;
      state.previewSha = null;
      return { sha: null, hasChecks: false, failed: false, line: PREVIEW_SKIPPED_LINE };
    }

    let preview;
    try {
      preview = await previewing.awaitPrPreview({ prUrl, environment: PREVIEW_ENVIRONMENT });
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      return await unmeasured(
        isTimeout(err) ? `No ${PREVIEW_ENVIRONMENT} deployment of the PR head was ready within ${PREVIEW_WAIT}.` : describeError(err),
      );
    }

    let results;
    try {
      results = (await checking.runFindingChecks({ key: input.key, checks, previewOrigin: preview.origin })).results;
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      return await unmeasured(`The checks did not run on ${preview.origin}: ${describeError(err)}.`, preview.sha);
    }

    return await report({ prUrl, sha: preview.sha, results, note: null });
  };

  /**
   * The merge wait with a retest beside it (STW-587): the poll races the
   * `retest` Update in one cancellation scope. The loser is cancelled: the
   * condition silently, the poll with a `RequestCancelActivityTask` when the
   * Update wins. Each loser's rejection is caught here, so none goes unhandled.
   */
  const mergeOrRetest = async (prUrl: string, options: AwaitFixPrMergeOptions): Promise<FixPrOutcome | 'retest'> => {
    retest.open = true;
    try {
      return await wf.CancellationScope.cancellable(async () => {
        const merge = merging.awaitFixPrMerge(prUrl, options);
        const asked = wf.condition(() => retest.requested).then(() => 'retest' as const);
        try {
          return await Promise.race([merge, asked]);
        } finally {
          merge.catch(() => undefined);
          asked.catch(() => undefined);
          wf.CancellationScope.current().cancel();
        }
      });
    } finally {
      retest.open = false;
    }
  };

  /**
   * The checks on production at the approved verdict (STW-589). Never throws
   * except for cancellation. `resolved` when every check passed and the write
   * resolved the finding. `hold` when the write refused because the finding is
   * no longer approved and unresolved, or when every check passed and the write
   * failed: a fix then would act on a moved finding, or on a problem just
   * measured as gone. `fix` for everything else, which goes on as before.
   */
  const measureAtVerdict = async (): Promise<'resolved' | 'hold' | 'fix'> => {
    state.step = 'measuring';
    const unmeasured = (reason: string): VerdictMeasure => ({ at: nowIso(), workflowId, rows: null, reason });
    let measure: VerdictMeasure | null = null;
    let checks;
    try {
      const finding = await readingChecks.readFinding(input.repo, input.findingPath);
      checks = (
        await readingChecks.readVerifyBlock({
          repo: input.repo,
          findingPath: input.findingPath,
          findingText: finding.text,
          origin: input.origin,
        })
      ).checks;
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      measure = unmeasured(`its checks could not be read: ${describeError(err)}`);
    }
    if (!measure && checks) {
      if (checks.length === 0) measure = unmeasured('the finding has no checks');
      else {
        try {
          const run = await measuring.runFindingChecks({ key: input.key, checks });
          measure = { at: run.ranAt, workflowId, rows: run.results, reason: null };
        } catch (err) {
          if (wf.isCancellation(err)) throw err;
          measure = unmeasured(`the checks did not run on production: ${describeError(err)}`);
        }
      }
    }
    const taken = measure as VerdictMeasure;
    const line = verdictMeasureLine(taken);
    state.verdictMeasure = line;
    const passed = verdictMeasurePassed(taken);
    const verification: Verification | null = passed
      ? { status: 'resolved', at: taken.at, workflowId, source: 'finding', rows: taken.rows ?? [], atVerdict: true }
      : null;
    try {
      await writing.writeFindingVerdictMeasure({
        repo: input.repo,
        key: input.key,
        findingPath: input.findingPath,
        indexPath: input.indexPath,
        measure: taken,
        ...(verification ? { verification } : {}),
      });
    } catch (err) {
      if (wf.isCancellation(err)) throw err;
      if (isFindingMoved(err)) {
        // As a fix whose write meets a moved finding: no automatic attempt,
        // and the run parks at `waiting-fix` with the reason.
        state.verdictMeasure = `${line} (not written: the finding moved)`;
        state.lastFixError = describeError(err);
        return 'hold';
      }
      state.verdictMeasure = `${line} (not written: ${describeError(err)})`;
      if (passed) {
        // Every check passed but the resolve did not land: no fix for a problem that is gone.
        state.lastFixError = `Every check passed at the verdict, but the resolve was not written: ${describeError(err)}`;
        return 'hold';
      }
      return 'fix';
    }
    return passed ? 'resolved' : 'fix';
  };

  /**
   * The fix wait of a run that reads its settings at use (STW-645). Null when
   * an attempt should start; the run's result when the wait closed it.
   *
   * A person's `fix` starts an attempt at once, and the gate in `openFixIssue`
   * decides, as it always did.
   *
   * **A run that has opened an issue** waits for that `fix` and nothing else.
   * Its issue, and the PR it may have, are a person's to retry or close, so the
   * run reads nothing, attempts nothing on its own and is never closed here:
   * no second issue is opened behind the first.
   *
   * **A run with no issue** reads `readFindingSettings` and then again every
   * {@link PARKED_REREAD}. It holds no slot here: every exit from an attempt
   * releases it before the loop comes back. Each read can end the wait two ways:
   *
   * 1. The file says `resolved` or `rejected`: a verify, a recheck or a verdict
   *    given elsewhere decided the finding, and the run ends `closed`.
   * 2. `auto_fix` is on and the gate accepts: the attempt starts. Not for a run
   *    held at the verdict, which stays a person's.
   *
   * The first read is the decision at the verdict. A run whose attempt failed
   * before any issue opened rests one interval first, so a failure that
   * repeats is retried daily, not in a loop.
   */
  const waitAtUse = async (held: boolean): Promise<FindingWorkflowResult | null> => {
    if (fix.requested) return null;
    if (state.issueUrl || slot.active) {
      await wf.condition(() => fix.requested);
      return null;
    }
    let rested = fixAttempts === 0;
    for (;;) {
      if (rested) {
        const settings = await settling.readFindingSettings({
          repo: input.repo,
          site: input.site,
          key: input.key,
          findingPath: input.findingPath,
        });
        if (settings.status === 'resolved' || settings.status === 'rejected') {
          return end('closed', `Closed while it waited for a fix: the finding file says ${settings.status}.`);
        }
        if (fix.requested) return null;
        const refusal = settings.refusal ? `${input.key} does not go to the fixer: ${settings.refusal}.` : null;
        if (!held) {
          if (settings.autoFix && refusal === null) return null;
          // The reason the run waits, where `steward finding status` reads it. A failed attempt's own error stays.
          if (refusal !== null || fixAttempts === 0) state.lastFixError = refusal;
          state.waitsForPerson = refusal !== null && settings.kind !== 'defect' && settings.kind !== 'opportunity';
        }
      }
      if (await wf.condition(() => fix.requested, PARKED_REREAD)) return null;
      rested = true;
    }
  };

  try {
    return await fixLoop();
  } finally {
    // Every other exit: a failure, or a cancellation, which the release must outlive.
    if (slot.active) await wf.CancellationScope.nonCancellable(() => release('ended'));
  }

  async function fixLoop(): Promise<FindingWorkflowResult> {
    // Once per run, before any slot or issue (STW-589). A history recorded
    // before it has the auto-fix marker here and replays without it.
    let heldAtVerdict = false;
    // A run that reads its settings at use carries that marker in place of
    // this one and of the auto-fix one: it always measures, and never reads the flag here.
    if (atUse || wf.patched(VERDICT_MEASURE_PATCH)) {
      const measured = await measureAtVerdict();
      if (measured === 'resolved') {
        return end('resolved', `Resolved at the verdict: ${state.verdictMeasure}, so no fix was opened.`);
      }
      if (measured === 'hold') {
        heldAtVerdict = true;
        fix.requested = false;
      }
    }

    // A history without the settings marker: the flag is read once, here, and kept.
    let autoFix = false;
    if (!atUse && wf.patched(AUTO_FIX_PATCH)) {
      autoFix = await writing.readSiteAutoFix({ repo: input.repo, site: input.site });
    }

    // The last attempt's issue, and why it ended: the next attempt closes it with that.
    let lastIssue: { url: string; reason: string } | null = null;
    // Set when a conflicting PR was closed: the next attempt starts without a `fix`.
    let recut = false;

    for (;;) {
      state.step = 'waiting-fix';
      if (!recut && atUse) {
        const closed = await waitAtUse(heldAtVerdict && fixAttempts === 0);
        if (closed) return closed;
      } else if (!recut) {
        const parked = input.waitsForPerson === true && fixAttempts === 0;
        if (parked) state.waitsForPerson = true;
        // A finding held at the verdict waits for a person, or for the reconciler to close the run.
        const held = heldAtVerdict && fixAttempts === 0;
        if (parked || held || !(autoFix && fixAttempts === 0)) await wf.condition(() => fix.requested);
      }
      recut = false;
      state.waitsForPerson = false;
      fix.requested = false;
      fixAttempts++;
      state.fixAttempts = fixAttempts;

      // Per attempt: an attempt recorded before the dispatcher replays without it.
      const dispatched = wf.patched(FIX_DISPATCH_PATCH);
      state.step = dispatched ? 'waiting-slot' : 'fixing';
      let prUrl: string;
      let viaIssue = false;
      try {
        if (dispatched) {
          await takeSlot(fixAttempts);
          state.step = 'fixing';
        }
        if (wf.patched(ACTION_ADAPTER_PATCH)) {
          viaIssue = true;
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
        await release('fix failed');
        continue;
      }
      state.prUrl = prUrl;
      state.lastFixError = null;

      // Per attempt, and only for the PR the Action opened: the custom fixer's
      // child ran its own preview test.
      const earlier: PreviewEarlierResult[] = [];
      state.previewTests = 0;
      let tested: PreviewOutcome | null = null;
      if (viaIssue && wf.patched(PREVIEW_TEST_PATCH)) tested = await testOnPreview(prUrl, earlier);

      state.step = 'waiting-merge';
      let merge;
      let reportConflict = dispatched;
      try {
        for (;;) {
          // The retest (STW-587): only after a test that found checks. No
          // marker; the docblock's "The retest" says why.
          if (tested?.hasChecks) {
            retest.prUrl = prUrl;
            retest.testedSha = tested.sha;
            retest.requested = false;
            const waited = await mergeOrRetest(prUrl, {
              ...(reportConflict ? { reportConflict: true } : {}),
              ...(tested.sha ? { retestAfter: tested.sha } : {}),
            });
            if (waited === 'retest' || waited.state === 'pushed') {
              earlier.push({ sha: tested.sha, line: tested.line });
              tested = await testOnPreview(prUrl, earlier);
              state.step = 'waiting-merge';
              continue;
            }
            merge = waited;
          } else {
            merge = reportConflict ? await merging.awaitFixPrMerge(prUrl, { reportConflict: true }) : await merging.awaitFixPrMerge(prUrl);
          }
          if (merge.state !== 'conflicting') break;
          let closed;
          try {
            closed = await writing.closeConflictingFixPr(prUrl);
          } catch (err) {
            if (wf.isCancellation(err)) throw err;
            // It could not be closed: leave it to a person, and wait on it as before.
            state.lastFixError = `${prUrl} conflicts and could not be closed: ${describeError(err)}`;
            reportConflict = false;
            continue;
          }
          // Merged or closed since the read: the next read says which.
          if (!closed.closed) continue;
          const sibling = closed.siblings.length > 0 ? ` with ${closed.siblings.join(', ')}` : '';
          if (lastIssue) lastIssue.reason = `${prUrl} conflicted${sibling} and was closed; the fix is re-cut from the new master`;
          break;
        }
      } catch (err) {
        if (isTimeout(err)) {
          await release('merge timeout');
          return end('merge-timeout', `${prUrl} was not merged or closed within 30 days. The finding is still fixing.`);
        }
        throw err;
      }

      if (merge.state === 'conflicting') {
        await release('conflict');
        recut = true;
        continue;
      }

      if (merge.state === 'closed') {
        await release('closed unmerged');
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
          await release('deploy timeout');
          return end(
            'deploy-timeout',
            `Production did not serve ${mergeSha.slice(0, 7)} within 24 hours. The finding is still fixing.`,
            { mergeSha },
          );
        }
        throw err;
      }
      // Live: the next fix on these paths can be cut from this master.
      await release('live');

      state.step = 'verifying';
      const at = nowIso();
      const verifyId = verifyWorkflowId(input.site, input.key, at);
      const verifyQueue = wf.patched(VERIFIER_HOSTED_PATCH) ? QUEUE_FINDINGS : QUEUE_HEAVY;
      // A merge over a failed last preview test: the Verification section says so.
      const previewAtMerge = tested?.failed ? `${tested.line}, at ${tested.sha ? tested.sha.slice(0, 7) : 'no commit'}` : null;
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
              ...(previewAtMerge ? { previewAtMerge } : {}),
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
}
