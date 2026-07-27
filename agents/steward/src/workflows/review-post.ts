import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import {
  toolFailurePass,
  type PassKind,
  type PassResult,
  type ReviewReport,
  type ReviewState,
  type ReviewStateResult,
} from '../lib/report.js';
// A pure string filter over `report.ts` types only — safe to import into the
// workflow sandbox. See the module docblock for why the selection has to happen
// here rather than inside the activity.
import { selectEprimeFindings } from '../lib/eprime.js';

// Queue names are duplicated here rather than imported from config.ts on
// purpose: config.ts touches `node:path` and `process.env`, neither of which is
// available in the workflow sandbox.
const QUEUE_LIGHT = 'steward-light';
const QUEUE_HEAVY = 'steward-heavy';

export interface ReviewPostInput {
  slug: string;
  /**
   * Which content collection the slug lives in. Optional so histories written
   * before collections existed replay unchanged — `undefined` resolves to
   * `writing`, which is what those runs actually did.
   */
  collection?: 'writing' | 'changelog';
  /**
   * `gate` (default) reviews an unpublished draft on its way to publication and
   * parks on a human verdict. `audit` reviews already-published content: same
   * fan-out, same report, archived the same way, then completes. No durable
   * wait, no publish leg, and `applyPatches` is refused — editing published
   * content goes through the human's normal git flow with the report as input.
   *
   * **This lives in the input, not in config, and that is now a rule rather than
   * a preference.** `mode` and `collection` both change the workflow's command
   * sequence: an audit emits no durable wait and may fan out against a different
   * file. A flag that changes the sequence must be recorded in history, or
   * flipping it would send every parked review down a branch it never took.
   * Phase 1c part 2 proved this the cheap way — `skipBuildAudit` lived in the
   * input, so adding the build audit to the fan-out did not break the Phase 1b
   * fixture. Had it lived in `config.ts`, it would have broken all of them.
   */
  mode?: 'gate' | 'audit';
  /**
   * Skips the heavy-queue build audit (spec §8.5).
   *
   * Resolved by the *caller*, not here: the workflow sandbox cannot import
   * `config.ts` (it touches `node:path` and `process.env`), so the
   * `ENABLE_BUILD_AUDIT` phase gate and the `--skip-build-audit` CLI flag are
   * both collapsed into this boolean before the workflow starts. Keeping the
   * decision in the input also keeps it *in the history* — a replayed run audits
   * or skips exactly as the original did, regardless of what the flag says now.
   */
  skipBuildAudit?: boolean;
  /**
   * Adds the `ai-tells` editorial pass to the fan-out (spec §8.6, §9.2).
   *
   * In the input for exactly the reason above, and this is the case that makes
   * the rule concrete rather than theoretical. When this was added there was a
   * real `hello-world` review that had been parked in `awaiting_verdict` for 21
   * hours across four structural changes, and two committed replay fixtures.
   * Adding an activity to a `Promise.all` fan-out changes the command sequence,
   * so had this been read from `ENABLE_AI_TELLS` in `config.ts`, flipping that
   * flag to `true` would have sent the parked review — and both fixtures — down
   * a branch their histories never took, breaking all three at once.
   *
   * Because it is an *optional input field*, every history that predates it
   * deserialises it as `undefined` -> `false` and replays down the identical
   * branch. The parked review therefore keeps its 257-event history and stays
   * publishable; the study's new audit runs pass `true` explicitly.
   *
   * Resolved by the caller from `ENABLE_AI_TELLS`, same as `skipBuildAudit`.
   */
  enableAiTells?: boolean;
  /**
   * Adds the `eprime-alternatives` pass after the fan-out (spec §8.6).
   *
   * In the input for the same design-rule-10 reason as every flag above, and the
   * default matters more here than usual: this pass is **on** in `config.ts`,
   * whereas `enableAiTells` is off. An absent field therefore has to resolve to
   * `false`, not to the config default — `input.enableEprimeAlternatives ===
   * true`, never `?? ENABLE_...`. Every history written before this field existed
   * has no such command in it, and defaulting an old history to the *current*
   * config value is precisely how a parked review gets sent down a branch it
   * never took.
   *
   * Resolved by the caller from `ENABLE_EPRIME_ALTERNATIVES`.
   */
  enableEprimeAlternatives?: boolean;
}

// ---------------------------------------------------------------------------
// Signals and queries (spec §7.2)
// ---------------------------------------------------------------------------

/**
 * `approve(force?, publish?)`.
 *
 * **`publish` rides on the signal rather than the workflow input, and that is a
 * deliberate refinement of design rule 10 rather than a violation of it.**
 *
 * The rule's point is that a sequence-changing decision must be *recorded in
 * history*, so replay reproduces the decision actually made. Rule 10 says "in
 * the workflow input" because every earlier such flag (`skipBuildAudit`,
 * `collection`, `mode`) is consumed during the fan-out, before any signal
 * exists. The publish gate is different: it is consumed **after the durable
 * wait**, which means for a workflow that is already parked the input is
 * immutable and the decision has not yet been made. Signal payloads are in
 * history too.
 *
 * This is what lets both of the things that pull in opposite directions survive:
 *
 * - The **Phase 1b replay fixture** ends `approve` → `approved_force` →
 *   `WorkflowExecutionCompleted`. Its recorded signal carries one payload, so
 *   `publish` deserialises as `undefined` → `false` → the workflow completes,
 *   matching history exactly. No re-export.
 * - The **live parked `hello-world` review**, started before this field existed
 *   and unable to change its own input, gets a future `approve` carrying
 *   `publish: true` and publishes normally.
 *
 * Had this been a `config.ts` flag, flipping it would have sent the 1b fixture's
 * replay down the publish branch and broken it. Had it been an input field, the
 * parked review could never have published without being restarted — destroying
 * the twenty-hour parked history that is the whole durability demonstration.
 *
 * The CLI resolves `ENABLE_PUBLISH_LEG` into the payload, exactly as it already
 * resolves `ENABLE_BUILD_AUDIT` into the input.
 */
export const approve = wf.defineSignal<[boolean?, boolean?]>('approve');
export const reject = wf.defineSignal<[string]>('reject');
export const applyPatches = wf.defineSignal<[string[]]>('applyPatches');
export const rereview = wf.defineSignal<[]>('rereview');

export const getReviewState = wf.defineQuery<ReviewStateResult>('getReviewState');

// ---------------------------------------------------------------------------
// Activity stubs, routed per queue with the spec §7.4 retry/timeout table.
// ---------------------------------------------------------------------------

const light = {
  snapshot: wf.proxyActivities<Pick<typeof activities, 'snapshotDraft' | 'currentContentHash'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  }),
  frontmatter: wf.proxyActivities<Pick<typeof activities, 'checkFrontmatter'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  }),
  linters: wf.proxyActivities<Pick<typeof activities, 'runCspell' | 'runVale'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 3 },
  }),
  reporting: wf.proxyActivities<Pick<typeof activities, 'synthesizeReport' | 'archiveReport'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 3 },
  }),
  editorial: wf.proxyActivities<Pick<typeof activities, 'editorialPass'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '3 minutes',
    retry: { maximumAttempts: 3, backoffCoefficient: 2 },
  }),
  // Same shape as `editorial` in the §7.4 table — it is the same kind of work
  // (one LLM call, retried on a transient failure), just a different rubric.
  // Kept as its own stub rather than widened into `editorial` so the retry entry
  // is legible per activity rather than shared by name coincidence.
  eprime: wf.proxyActivities<Pick<typeof activities, 'eprimeAlternativesPass'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '3 minutes',
    retry: { maximumAttempts: 3, backoffCoefficient: 2 },
  }),
  // 1 attempt, deliberately (spec §7.4): edits are not idempotent. A retried
  // apply would either fail the uniqueness check on already-replaced text or,
  // worse, re-apply a patch whose `oldText` still matches elsewhere.
  patching: wf.proxyActivities<Pick<typeof activities, 'applyPatchesActivity'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 1 },
  }),
  // 1 attempt + idempotency enforced inside the activity (spec §7.4/§8.7).
  // `nonRetryableErrorTypes` is belt and braces on top of the activity throwing
  // `ApplicationFailure.nonRetryable` directly: a hash mismatch or a rejected
  // credential will never come good by trying again, and retrying a publish is
  // how duplicate PRs get opened.
  publishing: wf.proxyActivities<Pick<typeof activities, 'publishPost'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '5 minutes',
    retry: {
      maximumAttempts: 1,
      nonRetryableErrorTypes: [
        'ContentHashMismatch',
        'AuthError',
        'NotFound',
        'MalformedPost',
        'PostMissing',
        'UnprocessableRequest',
      ],
    },
  }),
  // 1 attempt, because the *workflow* owns the retry (spec §7.4). An activity
  // retry policy would burn its attempts in seconds against a deploy that takes
  // minutes; the sleep/retry loop below is the thing that actually waits.
  verifying: wf.proxyActivities<Pick<typeof activities, 'verifyDeploy' | 'checkPrChecks'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 1 },
  }),
};

/**
 * How many times the workflow re-checks the live origin before parking, and how
 * long it waits between attempts. Ten attempts at 90s spans ~15 minutes, which
 * comfortably covers a Vercel production deploy (usually 1–3 minutes) plus the
 * human noticing the PR and merging it — without spinning forever if they went
 * to lunch instead.
 */
const VERIFY_MAX_ATTEMPTS = 10;
const VERIFY_INTERVAL = '90 seconds';

export const HEAVY_ACTIVITY_OPTIONS = {
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '15 minutes',
  // The activity runs a background heartbeat pump every 5s precisely so this
  // can stay tight through a multi-minute `npm ci` / build.
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
} as const;

const heavy = wf.proxyActivities<Pick<typeof activities, 'buildAndAuditDraft'>>(
  HEAVY_ACTIVITY_OPTIONS,
);

// ---------------------------------------------------------------------------

/**
 * Deterministic "now" inside the workflow.
 *
 * Spec §7.4 says to use `workflow.now()`. That API does not exist in the
 * TypeScript SDK — calling it fails the workflow task with
 * `wf.now is not a function`. The TS SDK instead *patches* `Date` inside the
 * workflow sandbox, so `new Date()` here is already replay-safe and returns the
 * workflow-time clock rather than wall time. This helper exists so the
 * non-obvious fact is stated once instead of implied at three call sites.
 */
function workflowNow(): string {
  return new Date().toISOString();
}

/**
 * Digs the real error out of a failed activity.
 *
 * A thrown activity arrives at the workflow wrapped in an `ActivityFailure`
 * whose own message is the useless constant "Activity task failed"; the thing
 * that actually broke is one or more `cause` links down. Reporting the wrapper
 * would put "Activity task failed" in the review report, which tells the author
 * nothing about which tool died or why.
 */
function describeActivityError(err: unknown): string {
  let current: unknown = err;
  let best = '';
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.message && current.message !== 'Activity task failed') best = current.message;
    current = (current as Error).cause;
  }
  return best || (err instanceof Error ? err.message : String(err));
}

type Decision =
  | { kind: 'approve'; force: boolean; publish: boolean }
  | { kind: 'reject'; reason: string }
  | { kind: 'applyPatches'; ids: string[] }
  | { kind: 'rereview' };

/**
 * The `reviewPost` workflow (spec §7).
 *
 * Phase 1a scope: fan-out over the mechanical passes, synthesize, archive, then
 * park indefinitely on a human signal. `approve` records the decision and
 * completes — the publish leg is gated off (config `ENABLE_PUBLISH_LEG`).
 *
 * Everything here is orchestration only: no I/O, no randomness, no Node imports
 * (design rule 4 / spec §7.4). Timestamps go through `workflowNow()`.
 */
export async function reviewPost(input: ReviewPostInput): Promise<ReviewReport> {
  // Resolved once, here, from the input only. Both default to what a
  // pre-existing history actually did, which is what makes those histories
  // replay unchanged (see ReviewPostInput.mode).
  const collection = input.collection ?? 'writing';
  const mode = input.mode ?? 'gate';

  let state: ReviewState = 'running';
  let report: ReviewReport | undefined;
  let reportPath: string | undefined;
  let staleReason: string | undefined;
  /**
   * Set once the PR is open. Its presence is what distinguishes "approve means
   * publish this" from "approve means resume the verification of something
   * already published" — see the resume branch below.
   */
  let publishInfo: { branch: string; prUrl: string; title: string } | undefined;

  /**
   * Decisions awaiting processing, oldest first.
   *
   * This is a FIFO queue rather than a single slot because signal handlers run
   * to completion as they arrive, but the main loop only drains between awaits.
   * Two signals delivered in quick succession — or any signal arriving while
   * `runFanOut()` is mid-flight during a rereview — landed on the same variable,
   * and the first was silently overwritten and never processed. Handlers push;
   * the loop shifts.
   */
  const pending: Decision[] = [];

  wf.setHandler(getReviewState, (): ReviewStateResult => ({
    state,
    overall: report?.overall,
    summary: report?.summary,
    reportPath,
    staleReason,
    pendingPatches: report?.patches.map((p) => ({ id: p.id, rationale: p.rationale })),
  }));

  wf.setHandler(approve, (force?: boolean, publish?: boolean) => {
    pending.push({ kind: 'approve', force: force === true, publish: publish === true });
  });
  wf.setHandler(reject, (reason: string) => {
    pending.push({ kind: 'reject', reason });
  });
  wf.setHandler(applyPatches, (ids: string[]) => {
    pending.push({ kind: 'applyPatches', ids });
  });
  wf.setHandler(rereview, () => {
    pending.push({ kind: 'rereview' });
  });

  /** Steps 1–3: snapshot, fan out, synthesize, archive. */
  async function runFanOut(): Promise<void> {
    state = 'running';
    staleReason = undefined;

    const snapshot = await light.snapshot.snapshotDraft(input.slug, collection);
    // The gate-mode refusal is unchanged, deliberately. Audit mode is the only
    // thing that may look at published content, and it is opt-in per review via
    // the input — so no config change and no default can ever quietly turn the
    // gate into something that reviews live posts.
    if (mode === 'gate' && snapshot.frontmatter.draft !== true) {
      throw wf.ApplicationFailure.nonRetryable(
        `${snapshot.file} is already published; Steward only reviews drafts in gate mode. ` +
          `To review published content, run an audit instead.`,
        'NotADraft',
      );
    }

    // A failed check yields a synthetic flag rather than failing the workflow.
    const guard = async (pass: PassKind, run: () => Promise<PassResult>): Promise<PassResult> => {
      try {
        return await run();
      } catch (err) {
        return toolFailurePass(pass, describeActivityError(err), workflowNow());
      }
    };

    const passes = await Promise.all([
      guard('cspell', () => light.linters.runCspell(snapshot.file)),
      guard('vale', () => light.linters.runVale(snapshot.file)),
      guard('frontmatter', () =>
        light.frontmatter.checkFrontmatter(snapshot.file, collection, mode),
      ),
      guard('claims_structure', () =>
        light.editorial.editorialPass(snapshot.file, 'claims-structure'),
      ),
      // The build audit runs on the heavy queue alongside the light passes
      // rather than after them: it is by far the longest pass (a full `npm ci`
      // plus an Astro production build plus two browser runs), so serialising it
      // would add its whole duration to every review for no benefit.
      //
      // `guard` applies here too, and matters more than elsewhere: a broken
      // build environment — a failed `npm ci`, a missing Chrome — must degrade
      // to a visible tool-failure flag on one pass, not take down a review whose
      // other four passes have real findings in them.
      ...(input.skipBuildAudit
        ? []
        : [guard('build_audit', () => heavy.buildAndAuditDraft(input.slug, collection))]),
      // The ai-tells pass (spec §8.6/§9.2). Appended LAST in the array on
      // purpose: the fan-out's command order is the replay contract, so a new
      // activity added at the end is the least disruptive position, and every
      // history that predates the flag simply has no such command.
      ...(input.enableAiTells
        ? [guard('ai_tells', () => light.editorial.editorialPass(snapshot.file, 'ai-tells'))]
        : []),
    ]);

    // ---- eprime-alternatives: a dependent pass, run AFTER the fan-out --------
    //
    // This pass consumes Vale's output, so it cannot join the `Promise.all`
    // above without creating a dependency inside a parallel fan-out. It is
    // appended as a separate awaited step instead, for the same reason the
    // ai-tells entry sits last in the array: **the fan-out's command order is
    // the replay contract.** Adding an activity after the array leaves every
    // recorded command sequence intact and simply appends one more; reordering
    // or restructuring the array would not, and would strand every parked
    // review. Do not "tidy" this into the fan-out.
    //
    // Skipped entirely when Vale found no E-Prime instances, so a post that does
    // not need this makes no API call and costs nothing. That decision is
    // derived from an activity *result already in history*, so it replays
    // identically.
    if (input.enableEprimeAlternatives === true) {
      const eprimeFindings = selectEprimeFindings(passes);
      if (eprimeFindings.length > 0) {
        passes.push(
          await guard('eprime_alternatives', () =>
            light.eprime.eprimeAlternativesPass({ file: snapshot.file, eprimeFindings }),
          ),
        );
      }
    }

    // Carried across a rereview deliberately. The spec says rereview "replaces
    // the working report", and it does — but `patchesApplied` is a record of
    // what Steward wrote to the human's file, and losing it on the very
    // signal the apply cycle requires would erase the only in-report evidence
    // that the edits happened at all.
    const patchesApplied = report?.human.patchesApplied;

    report = await light.reporting.synthesizeReport({
      snapshot,
      passes,
      mode,
      workflowId: wf.workflowInfo().workflowId,
      runId: wf.workflowInfo().runId,
    });

    if (patchesApplied?.length) {
      report.human = { ...report.human, patchesApplied };
    }

    // Archived at verdict time, not only after publish: rejected reviews are
    // data too (spec §7.3 step 3).
    reportPath = (await light.reporting.archiveReport(report)).reportPath;
    state = 'awaiting_verdict';
  }

  /**
   * The deploy-verification loop (spec §7.3 step 5).
   *
   * Returns `true` when production agrees the post is live — the only thing
   * allowed to declare a publish complete (design rule 7). Returns `false` when
   * attempts are exhausted, having parked the workflow back on the durable wait
   * with an explanatory message.
   *
   * **Exhaustion is the expected outcome, not the error case.** Steward does
   * not merge; a human does. Until they do, every attempt fails for a perfectly
   * good reason, and the workflow's job is to say so clearly and wait rather
   * than to fail.
   */
  async function runVerification(): Promise<boolean> {
    state = 'verifying_deploy';
    staleReason = undefined;

    for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt++) {
      const result = await light.verifying.verifyDeploy({
        slug: input.slug,
        collection,
        title: publishInfo!.title,
      });

      report!.publish = {
        ...report!.publish,
        deployVerified: result.deployVerified,
        verification: result.verification,
      };

      if (result.deployVerified) {
        reportPath = (await light.reporting.archiveReport(report!)).reportPath;
        state = 'published';
        return true;
      }

      // Before sleeping another 90 seconds, ask whether waiting can ever work.
      //
      // `verifyDeploy` polls PRODUCTION, which only goes green after a human
      // merges — and nobody merges a PR whose CI is red. So a failing check
      // makes all ten attempts certain to fail, and the operator sees a silent
      // fifteen-minute wait instead of the broken build GitHub already knows
      // about. Observed on the first real publish, and the reason this exists:
      // a slow success and a guaranteed failure must not look identical.
      //
      // Parked, never failed. A red check is operator-fixable and then perfectly
      // resumable — failing the workflow here would destroy the durable state
      // over something a two-minute fix resolves.
      const checks = await light.verifying.checkPrChecks(publishInfo!.branch);
      if (checks.state === 'failing') {
        state = 'publishing';
        staleReason =
          `PR CI is FAILING — merge is blocked, so waiting cannot succeed. ` +
          `Failing: ${checks.failing.join(', ')}. ` +
          `PR: ${publishInfo!.prUrl}. ` +
          `Fix the cause, then send \`approve\` again to resume verification. ` +
          `(Stopped after attempt ${attempt} of ${VERIFY_MAX_ATTEMPTS} rather than polling production for nothing.)`;
        reportPath = (await light.reporting.archiveReport(report!)).reportPath;
        return false;
      }

      if (attempt < VERIFY_MAX_ATTEMPTS) await wf.sleep(VERIFY_INTERVAL);
    }

    // Parked, not failed. State goes back to `publishing` — the PR is open and
    // the publish is genuinely incomplete, and calling it `awaiting_verdict`
    // would suggest the verdict is still owed when it was given long ago.
    const failed = report!.publish.verification?.filter((v) => !v.ok).map((v) => v.check) ?? [];
    state = 'publishing';
    staleReason =
      `PR open, awaiting merge: ${publishInfo!.prUrl}. ` +
      `Verification against production did not pass after ${VERIFY_MAX_ATTEMPTS} attempts ` +
      `(still failing: ${failed.join(', ') || 'none recorded'}). ` +
      `This is the expected state until the PR is merged — Steward never merges. ` +
      `Merge it, then send \`approve\` again to resume verification.`;
    reportPath = (await light.reporting.archiveReport(report!)).reportPath;
    return false;
  }

  await runFanOut();

  // -------------------------------------------------------------------------
  // Audit mode stops here.
  //
  // There is no verdict to wait for: the content is already published, so there
  // is nothing to gate and nothing to approve. The report is the entire
  // deliverable, and it has just been archived. Parking would leave a workflow
  // running forever waiting for a signal that has no meaning.
  //
  // Any decision signalled during the fan-out is discarded with the queue, and
  // that includes `applyPatches` — patches still appear in the report, but the
  // Steward does not write to published content. That edit goes through the
  // human's normal git flow, with the report as input.
  // -------------------------------------------------------------------------
  if (mode === 'audit') {
    state = 'audited';
    return report!;
  }

  // -------------------------------------------------------------------------
  // Durable wait. No timeout — this may sit for weeks, and surviving a worker
  // restart while parked here is the whole demonstration.
  // -------------------------------------------------------------------------
  for (;;) {
    await wf.condition(() => pending.length > 0);
    const decision = pending.shift()!;

    if (decision.kind === 'rereview') {
      await runFanOut();
      continue;
    }

    if (decision.kind === 'applyPatches') {
      state = 'applying_patches';
      // Clear any reason left by an earlier decision before starting this one.
      // Without this, a CLI polling for "state moved or a reason appeared"
      // returns instantly on the *previous* signal's message and reports a
      // stale outcome for a signal that is still in flight.
      staleReason = undefined;
      try {
        const applied = await light.patching.applyPatchesActivity({
          report: report!,
          patchIds: decision.ids,
        });

        report!.human = { ...report!.human, patchesApplied: applied.applied };

        // Applying a patch necessarily changes the bytes, so the review is now
        // pinned to content that no longer exists on disk (design rule 2). The
        // workflow says so itself rather than waiting for the approve-time hash
        // check to discover it — the human needs to know a `rereview` is owed
        // the moment the edit lands, not when their approve gets refused.
        state = 'stale';
        staleReason = `Applied ${applied.applied.join(', ')} to ${applied.file}. The file has changed, so this review is stale — send \`rereview\` to re-run the checks against the new bytes.`;
      } catch (err) {
        // A failed apply is not a failed workflow: the uniqueness guard refusing
        // to guess is a *correct* outcome the human needs to read and act on.
        // Park back on the verdict with the reason rather than dying.
        state = 'awaiting_verdict';
        staleReason = `Patch application failed and nothing was written: ${describeActivityError(err)}`;
      }
      continue;
    }

    if (decision.kind === 'reject') {
      // Spread, don't replace: `patchesApplied` may already be recorded here,
      // and a decision must not erase the record of what was written to disk.
      report!.human = {
        ...report!.human,
        decision: 'rejected',
        reason: decision.reason,
        decidedAt: workflowNow(),
      };
      reportPath = (await light.reporting.archiveReport(report!)).reportPath;
      state = 'rejected';
      return report!;
    }

    // ---- approve --------------------------------------------------------
    //
    // **Resume, not re-publish.** If a PR is already open, a repeat `approve` is
    // the documented way to say "I have merged it, carry on" (§8.7's
    // park-on-unmerged-PR behaviour). It is an *idempotent resume*: the workflow
    // goes straight back to verifying the live origin.
    //
    // Two things it deliberately does NOT do:
    //
    // 1. **It does not re-run `publishPost`.** After a merge, resetting the
    //    branch to base finds nothing to commit and the merged PR is closed, so
    //    a re-publish would try to open a second PR and get a 422 for its
    //    trouble — turning a successful publish into a hard failure at the last
    //    step.
    // 2. **It ignores the signal's `publish` payload entirely.** That decision
    //    was consumed once, at the first approve, and is already in history. A
    //    resume signal carrying `publish: false` must not be read as
    //    "un-publish" — there is no such operation, the commit is on the default
    //    branch, and the only honest thing to do is keep verifying. Re-evaluating
    //    the payload here would also make the outcome depend on which flag
    //    happened to be set at resume time, which is the exact class of bug
    //    design rule 10 exists to prevent.
    //
    // The block/force and content-hash gates are skipped for the same reason:
    // they guard the transition *into* publishing, which already happened.
    if (publishInfo) {
      if (await runVerification()) return report!;
      continue;
    }

    if (report!.overall === 'block' && !decision.force) {
      staleReason =
        'Approve refused: the report has blocking findings. Fix them and send `rereview`, or approve with --force.';
      continue;
    }

    // Design rule 2, belt and braces: the bytes must still be the bytes we reviewed.
    const currentHash = await light.snapshot.currentContentHash(input.slug, collection);
    if (currentHash !== report!.contentSha256) {
      state = 'stale';
      staleReason =
        currentHash === null
          ? 'Approve refused: the post file no longer exists.'
          : `Approve refused: the file changed since it was reviewed (reviewed ${report!.contentSha256.slice(0, 12)}, on disk ${currentHash.slice(0, 12)}). Send \`rereview\`.`;
      continue;
    }

    report!.human = {
      ...report!.human,
      decision: decision.force ? 'approved_force' : 'approved',
      decidedAt: workflowNow(),
    };
    staleReason = undefined;

    // Without the publish leg, an approve records the decision and completes.
    // This is the branch every history written before Phase 2 took, and the
    // branch the Phase 1b replay fixture still takes (its recorded `approve`
    // carries no `publish` payload).
    if (!decision.publish) {
      reportPath = (await light.reporting.archiveReport(report!)).reportPath;
      state = 'approved';
      return report!;
    }

    // ---- Publish leg (spec §7.3 step 5, §8.7, §8.8) ----------------------
    state = 'publishing';
    let published: { branch: string; prUrl: string; title: string };
    try {
      published = await light.publishing.publishPost({ report: report! });
    } catch (err) {
      // Park, don't die. `publishPost` runs with `maximumAttempts: 1`, so an
      // expired GITHUB_TOKEN, a misconfigured remote, or one transient 5xx threw
      // straight out of the workflow — taking the whole durable review with it,
      // including every finding and the human's decision. That is the incident
      // design rule 12 exists to prevent (spec §303-324), and every neighbouring
      // failure path here already parks: a failed patch apply and a red PR check
      // both land back on the wait with an explanation.
      //
      // `awaiting_verdict` rather than `publishing`: no PR exists, so unlike the
      // post-publish verification parks there is nothing open to merge, and the
      // approve is genuinely still owed once the cause is fixed. Re-sending
      // `approve` re-runs this leg — the activity's own idempotency guard
      // (spec §8.7) is what makes that safe rather than a duplicate-PR machine.
      state = 'awaiting_verdict';
      staleReason =
        `Publish failed and no PR was opened: ${describeActivityError(err)}. ` +
        `The review is intact and still approved-pending — fix the cause ` +
        `(credentials and remote are the usual ones) and send \`approve\` again.`;
      reportPath = (await light.reporting.archiveReport(report!)).reportPath;
      continue;
    }
    publishInfo = published;
    report!.publish = {
      ...report!.publish,
      branch: published.branch,
      prUrl: published.prUrl,
    };
    // Archive as soon as the PR exists. If verification then parks for a week,
    // the PR URL is already durable on disk rather than only in workflow memory.
    reportPath = (await light.reporting.archiveReport(report!)).reportPath;

    if (await runVerification()) return report!;
    continue;
  }
}
