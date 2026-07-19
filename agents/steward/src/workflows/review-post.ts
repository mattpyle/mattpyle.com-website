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
  /** Phase 1a escape hatch while §8.5 is unbuilt. Currently always effectively true. */
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
  linters: wf.proxyActivities<Pick<typeof activities, 'runCspell'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 3 },
  }),
  reporting: wf.proxyActivities<Pick<typeof activities, 'synthesizeReport' | 'archiveReport'>>({
    taskQueue: QUEUE_LIGHT,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 3 },
  }),
};

// Declared now so the heavy queue is exercised (and visibly wired) from Phase 1a
// even though buildAndAuditDraft itself lands in Phase 1c.
export const HEAVY_ACTIVITY_OPTIONS = {
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
} as const;

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
  let pending: Decision | undefined;

  wf.setHandler(getReviewState, (): ReviewStateResult => ({
    state,
    overall: report?.overall,
    summary: report?.summary,
    reportPath,
    staleReason,
    pendingPatches: report?.patches.map((p) => ({ id: p.id, rationale: p.rationale })),
  }));

  wf.setHandler(approve, (force?: boolean) => {
    pending = { kind: 'approve', force: force === true };
  });
  wf.setHandler(reject, (reason: string) => {
    pending = { kind: 'reject', reason };
  });
  wf.setHandler(applyPatches, (ids: string[]) => {
    pending = { kind: 'applyPatches', ids };
  });
  wf.setHandler(rereview, () => {
    pending = { kind: 'rereview' };
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
      guard('frontmatter', () => light.frontmatter.checkFrontmatter(snapshot.file)),
      // Phase 1b adds runVale + editorialPass here; Phase 1c adds
      // buildAndAuditDraft on the heavy queue, gated on `skipBuildAudit`.
    ]);

    report = await light.reporting.synthesizeReport({
      snapshot,
      passes,
      workflowId: wf.workflowInfo().workflowId,
      runId: wf.workflowInfo().runId,
    });

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
    await wf.condition(() => pending !== undefined);
    const decision = pending!;
    pending = undefined;

    if (decision.kind === 'rereview') {
      await runFanOut();
      continue;
    }

    if (decision.kind === 'applyPatches') {
      // Phase 1b. Refuse explicitly rather than silently ignoring the signal.
      staleReason = 'applyPatches is not implemented until Phase 1b. Edit the file by hand, then send `rereview`.';
      continue;
    }

    if (decision.kind === 'reject') {
      report!.human = {
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
