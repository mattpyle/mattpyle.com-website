import {
  assembleDeepAudit,
  auditRenderedPage,
  auditSiteFast,
  auditSiteFetchChecks,
} from './activities/agent-audit.js';
import { checkActionUsage, reportRunHealth } from './activities/health.js';
import {
  awaitFixPr,
  findFixPr,
  awaitFixPrMerge,
  awaitPrPreview,
  awaitProductionDeploy,
  closeConflictingFixPr,
  commentOnFixPr,
  readProductionDeploy,
  listOpenFindingWorkflows,
  openFixIssue,
  readFinding,
  readFindingsIndex,
  readFixPr,
  readSiteAutoFix,
  readFindingSettings,
  readVerifyBlock,
  reportPreviewChecks,
  requestFixSlot,
  runningWorkflowIds,
  writeFindingFix,
  writeFindingReturned,
  writeFindingVerdict,
  writeFindingVerification,
} from './activities/findings.js';
import { runFindingChecks } from './activities/verify-finding.js';
import { readRecheckBlock, readSiteHosts, readWatchRun, writeFindingRecheck } from './activities/findings-recheck.js';
import { writeFindingVerdictMeasure } from './activities/findings-verdict-measure.js';
import { watchFinding } from './activities/findings-watch.js';
import { writeFindingLook } from './activities/findings-look.js';
import { commitFixLogEntry, draftFixLogEntry } from './activities/fix-log.js';
import { mergeFixLogConfirmation, openFixLogConfirmation, readFixLogConfirmationChecks } from './activities/fix-log-confirm.js';
import {
  archiveScorecardRun,
  auditLiveUrl,
  mergeScorecardPr,
  publishScorecardRun,
  readPublishedScorecard,
  readScorecardPrChecks,
  resolveAuditUrls,
  resolveRunStamp,
} from './activities/scorecard.js';
import {
  HOSTED_ACTIVITY_CONCURRENCY,
  HOSTED_FAST_ACTIVITY_CONCURRENCY,
  HOSTED_FINDINGS_ACTIVITY_CONCURRENCY,
  HOSTED_FINDINGS_WATCH_ACTIVITY_CONCURRENCY,
  QUEUE_AUDIT,
  QUEUE_AUDIT_FAST,
  QUEUE_FINDINGS,
  QUEUE_FINDINGS_WATCH,
} from './config.js';

/**
 * The hosted worker's registry: for each of its three queues, the task queue,
 * the activities it registers, whether it carries the workflow bundle, and its
 * concurrency cap. Data only.
 *
 * `worker-hosted.ts` builds its three `Worker.create` calls from this list and
 * declares no map of its own, and `tests/lib/hosted-worker-registry.test.ts`
 * builds the same list. That is the point of the module: the entry point calls
 * `main()` at module scope, so a test cannot import it without connecting to
 * Temporal and demanding a GitHub App credential, and a test that reads its text proves
 * only that a name was spelled. This module has no side effects at import, so a
 * wrong map wired to a queue fails a test.
 *
 * It is a list of options and not a `Worker.create` wrapper because the tests
 * must need no connection, and because the entry point keeps its shutdown
 * timings and interceptor in one visible place.
 */
export interface HostedQueue {
  readonly taskQueue: string;
  readonly activities: Record<string, (...args: never[]) => unknown>;
  /** True when this worker also runs the workflow bundle. */
  readonly carriesWorkflows: boolean;
  /** `maxConcurrentActivityTaskExecutions`, from the constant `config.ts` documents. */
  readonly maxConcurrentActivityTaskExecutions: number;
}

/**
 * Exactly the activities the two hosted workflows schedule, and nothing else.
 *
 * `auditSiteWorkflow` → the first four. `scorecardAuditWorkflow` → the rest.
 * Every one of them reaches the site over the network and the repository over
 * the GitHub API; none of them opens a file in the repo. That property is what
 * the whole leg rests on, so it is worth re-checking rather than assuming when
 * this list grows.
 */
const activities = {
  auditSiteFast,
  auditSiteFetchChecks,
  auditRenderedPage,
  assembleDeepAudit,
  resolveAuditUrls,
  resolveRunStamp,
  auditLiveUrl,
  readPublishedScorecard,
  publishScorecardRun,
  readScorecardPrChecks,
  mergeScorecardPr,
  archiveScorecardRun,
  // The scorecard's alerting leg. Both are HTTPS calls that read their
  // configuration from the host's environment — `STEWARD_HEALTHCHECK_BASE` for
  // the ping, and `TEMPORAL_METRICS_API_KEY` for the usage sample's second call,
  // out to Temporal Cloud's metrics endpoint — so they satisfy the "nothing
  // local" rule this list enforces.
  reportRunHealth,
  checkActionUsage,
};

/**
 * The fast queue's whole registry: one activity, and it is the same function the
 * audit workflow schedules on the other queue.
 *
 * Written as its own object rather than as a slice of the map above because the
 * list *is* the contract with the queue. Anything added here becomes work the
 * public MCP endpoint can dispatch straight onto this container with no workflow
 * in between, so growing it is a decision rather than a refactor.
 */
const fastActivities = { auditSiteFast };

/**
 * The findings queue's registry (findings-loop design, decisions 18, 26, 29
 * and 30, fix-dispatch-by-surface and fix-pr-runs-the-verify-block): the
 * twenty-three findings activities, the recheck's three, the verdict
 * measurement's one, the look's one (stage 5) and the fix log entry's two, plus `reportRunHealth` because the recheck pings its check
 * from this queue. GitHub API calls against the findings repository, the fix issue, the
 * fix PR, the lifecycle's three waits, the conflicting PR's close, the fix
 * PR's preview wait and its comment and draft write, and the blockless
 * verify's one production read against the site repository; a
 * visibility list, a dispatcher signal-with-start and a status sweep
 * through the worker's own client; and the verifier's checks: fetch against
 * production and this image's Chromium for `selector` and `js`, as the deep
 * audit uses it; and the fix log draft's model call (STW-710), which needs
 * `ANTHROPIC_API_KEY` on this worker and fails non-retryably without it. None
 * opens a local file in the repository, so the "nothing local" rule above
 * holds for this map too.
 */
const findingsActivities = {
  readFindingsIndex,
  readFinding,
  writeFindingVerdict,
  writeFindingReturned,
  readSiteAutoFix,
  readFindingSettings,
  openFixIssue,
  awaitFixPr,
  findFixPr,
  writeFindingFix,
  awaitFixPrMerge,
  awaitPrPreview,
  awaitProductionDeploy,
  readProductionDeploy,
  listOpenFindingWorkflows,
  readFixPr,
  readVerifyBlock,
  runFindingChecks,
  writeFindingVerification,
  reportPreviewChecks,
  requestFixSlot,
  runningWorkflowIds,
  closeConflictingFixPr,
  commentOnFixPr,
  reportRunHealth,
  // The recheck (STW-543): GitHub reads and one commit per changed finding.
  readSiteHosts,
  readRecheckBlock,
  writeFindingRecheck,
  // The recheck on a site that watches: one describe of a finding's run.
  readWatchRun,
  // The measurement at an approved verdict (STW-589): one commit.
  writeFindingVerdictMeasure,
  // The look (stage 5): one commit that resolves a finding Argus saw fixed.
  writeFindingLook,
  // The fix log entry (STW-710): the model draft, and one commit to the fix PR's branch.
  draftFixLogEntry,
  commitFixLogEntry,
  openFixLogConfirmation,
  readFixLogConfirmationChecks,
  mergeFixLogConfirmation,
};

/**
 * The watch queue's whole registry (stage 4): one activity, `watchFinding`,
 * which a watching `findingWorkflow` schedules. GitHub API calls against the
 * findings repository and the verifier's checks on production, as
 * `runFindingChecks` makes them, so the "nothing local" rule holds.
 */
const watchActivities = { watchFinding };

/**
 * The four queues, in the order the ready line lists them: audit, fast,
 * findings, watch. A fresh object each call, so a caller cannot mutate the shared one.
 *
 * The audit queue's cap of one is a correctness rule about Lighthouse
 * (`config.ts`'s `HOSTED_ACTIVITY_CONCURRENCY`); the fast queue's four is a
 * throughput choice for a public, synchronous tool, since nothing there launches
 * Chrome. The findings queue carries the workflow bundle because both its
 * workflows run on it, and a verdict write must not wait behind a 90-second page
 * render on the audit queue. The fast queue carries none, so it can never be
 * given a deep audit. The watch queue carries none either: its one activity
 * can launch Chromium, so its cap of one keeps a burst of watchers off the
 * findings queue's two slots.
 */
export function hostedRegistry(): readonly [HostedQueue, HostedQueue, HostedQueue, HostedQueue] {
  return [
    {
      taskQueue: QUEUE_AUDIT,
      activities,
      carriesWorkflows: true,
      maxConcurrentActivityTaskExecutions: HOSTED_ACTIVITY_CONCURRENCY,
    },
    {
      taskQueue: QUEUE_AUDIT_FAST,
      activities: fastActivities,
      carriesWorkflows: false,
      maxConcurrentActivityTaskExecutions: HOSTED_FAST_ACTIVITY_CONCURRENCY,
    },
    {
      taskQueue: QUEUE_FINDINGS,
      activities: findingsActivities,
      carriesWorkflows: true,
      maxConcurrentActivityTaskExecutions: HOSTED_FINDINGS_ACTIVITY_CONCURRENCY,
    },
    {
      taskQueue: QUEUE_FINDINGS_WATCH,
      activities: watchActivities,
      carriesWorkflows: false,
      maxConcurrentActivityTaskExecutions: HOSTED_FINDINGS_WATCH_ACTIVITY_CONCURRENCY,
    },
  ];
}

/**
 * The public-audit role's queues (STW-610): `steward-audit` and
 * `steward-audit-fast`, and nothing else. A fresh object each call.
 *
 * The audit queue registers the four activities `auditSiteWorkflow` schedules
 * and `auditSiteFast`, which the workflow also uses. The scorecard's activities
 * and the findings queue belong to the credentialed role. The audit queue
 * carries the narrowed workflow bundle (`workflows/public-audit.ts`); the fast
 * queue carries none, as in the default role. Caps are the default role's.
 */
export function publicRegistry(): readonly [HostedQueue, HostedQueue] {
  return [
    {
      taskQueue: QUEUE_AUDIT,
      activities: { auditSiteFast, auditSiteFetchChecks, auditRenderedPage, assembleDeepAudit },
      carriesWorkflows: true,
      maxConcurrentActivityTaskExecutions: HOSTED_ACTIVITY_CONCURRENCY,
    },
    {
      taskQueue: QUEUE_AUDIT_FAST,
      activities: fastActivities,
      carriesWorkflows: false,
      maxConcurrentActivityTaskExecutions: HOSTED_FAST_ACTIVITY_CONCURRENCY,
    },
  ];
}
