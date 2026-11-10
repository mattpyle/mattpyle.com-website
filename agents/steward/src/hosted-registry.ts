import {
  assembleDeepAudit,
  auditRenderedPage,
  auditSiteFast,
  auditSiteFetchChecks,
} from './activities/agent-audit.js';
import { checkActionUsage, reportRunHealth } from './activities/health.js';
import {
  awaitFixPr,
  awaitFixPrMerge,
  awaitPrPreview,
  awaitProductionDeploy,
  closeConflictingFixPr,
  readProductionDeploy,
  listFixableFindings,
  listOpenFindingWorkflows,
  listSites,
  openFixIssue,
  readFinding,
  readFindingsIndex,
  readFixPr,
  readSiteAutoFix,
  readVerifyBlock,
  reportPreviewChecks,
  requestFixSlot,
  runningWorkflowIds,
  startFindingWorkflow,
  writeFindingFix,
  writeFindingReturned,
  writeFindingVerdict,
  writeFindingVerification,
} from './activities/findings.js';
import { runFindingChecks } from './activities/verify-finding.js';
import { readRecheckBlock, readSiteHosts, writeFindingRecheck } from './activities/findings-recheck.js';
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
  QUEUE_AUDIT,
  QUEUE_AUDIT_FAST,
  QUEUE_FINDINGS,
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
 * twenty-three findings activities and the recheck's three,
 * plus `reportRunHealth` because the reconciler pings its check from this
 * queue. GitHub API calls against the findings repository, the fix issue, the
 * fix PR, the lifecycle's three waits, the conflicting PR's close, the fix
 * PR's preview wait and its comment and draft write, and the blockless
 * verify's one production read against the site repository; a
 * visibility list, a workflow start, a dispatcher signal and a status sweep
 * through the worker's own client; and the verifier's checks: fetch against
 * production and this image's Chromium for `selector` and `js`, as the deep
 * audit uses it. None opens a local file in the repository, so the "nothing
 * local" rule above holds for this map too.
 */
const findingsActivities = {
  listSites,
  readFindingsIndex,
  readFinding,
  writeFindingVerdict,
  writeFindingReturned,
  readSiteAutoFix,
  openFixIssue,
  awaitFixPr,
  writeFindingFix,
  awaitFixPrMerge,
  awaitPrPreview,
  awaitProductionDeploy,
  readProductionDeploy,
  listOpenFindingWorkflows,
  listFixableFindings,
  startFindingWorkflow,
  readFixPr,
  readVerifyBlock,
  runFindingChecks,
  writeFindingVerification,
  reportPreviewChecks,
  requestFixSlot,
  runningWorkflowIds,
  closeConflictingFixPr,
  reportRunHealth,
  // The recheck (STW-543): GitHub reads and one commit per changed finding.
  readSiteHosts,
  readRecheckBlock,
  writeFindingRecheck,
};

/**
 * The three queues, in the order the ready line lists them: audit, fast,
 * findings. A fresh object each call, so a caller cannot mutate the shared one.
 *
 * The audit queue's cap of one is a correctness rule about Lighthouse
 * (`config.ts`'s `HOSTED_ACTIVITY_CONCURRENCY`); the fast queue's four is a
 * throughput choice for a public, synchronous tool, since nothing there launches
 * Chrome. The findings queue carries the workflow bundle because both its
 * workflows run on it, and a verdict write must not wait behind a 90-second page
 * render on the audit queue. The fast queue carries none, so it can never be
 * given a deep audit.
 */
export function hostedRegistry(): readonly [HostedQueue, HostedQueue, HostedQueue] {
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
  ];
}
