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

// Queue names are duplicated here rather than imported from config.ts on
// purpose: config.ts touches `node:path` and `process.env`, neither of which is
// available in the workflow sandbox.
const QUEUE_LIGHT = 'steward-light';
const QUEUE_HEAVY = 'steward-heavy';

export interface ReviewPostInput {
  slug: string;
  collection: 'writing';
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
}

// ---------------------------------------------------------------------------
// Signals and queries (spec §7.2)
// ---------------------------------------------------------------------------

export const approve = wf.defineSignal<[boolean?]>('approve');
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
  // 1 attempt, deliberately (spec §7.4): edits are not idempotent. A retried
  // apply would either fail the uniqueness check on already-replaced text or,
  // worse, re-apply a patch whose `oldText` still matches elsewhere.
  patching: wf.proxyActivities<Pick<typeof activities, 'applyPatchesActivity'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 1 },
  }),
};

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
  | { kind: 'approve'; force: boolean }
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
  let state: ReviewState = 'running';
  let report: ReviewReport | undefined;
  let reportPath: string | undefined;
  let staleReason: string | undefined;

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

  wf.setHandler(approve, (force?: boolean) => {
    pending.push({ kind: 'approve', force: force === true });
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

    const snapshot = await light.snapshot.snapshotDraft(input.slug);
    if (snapshot.frontmatter.draft !== true) {
      throw wf.ApplicationFailure.nonRetryable(
        `${snapshot.file} is already published; the Steward only reviews drafts.`,
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
      guard('frontmatter', () => light.frontmatter.checkFrontmatter(snapshot.file)),
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
        : [guard('build_audit', () => heavy.buildAndAuditDraft(input.slug))]),
      // Phase 2a adds the ai-tells pass behind ENABLE_AI_TELLS.
    ]);

    // Carried across a rereview deliberately. The spec says rereview "replaces
    // the working report", and it does — but `patchesApplied` is a record of
    // what the Steward wrote to the human's file, and losing it on the very
    // signal the apply cycle requires would erase the only in-report evidence
    // that the edits happened at all.
    const patchesApplied = report?.human.patchesApplied;

    report = await light.reporting.synthesizeReport({
      snapshot,
      passes,
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

  await runFanOut();

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

    // approve
    if (report!.overall === 'block' && !decision.force) {
      staleReason =
        'Approve refused: the report has blocking findings. Fix them and send `rereview`, or approve with --force.';
      continue;
    }

    // Design rule 2, belt and braces: the bytes must still be the bytes we reviewed.
    const currentHash = await light.snapshot.currentContentHash(input.slug);
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

    // Publish leg is Phase 2b (config ENABLE_PUBLISH_LEG). Phase 1a records the
    // decision, re-archives, and completes.
    reportPath = (await light.reporting.archiveReport(report!)).reportPath;
    state = 'approved';
    return report!;
  }
}
