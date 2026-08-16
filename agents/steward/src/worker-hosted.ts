import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import {
  assembleDeepAudit,
  auditRenderedPage,
  auditSiteFast,
  auditSiteFetchChecks,
} from './activities/agent-audit.js';
import { checkCredentialExpiry, reportRunHealth } from './activities/health.js';
import {
  archiveScorecardRun,
  auditLiveUrl,
  publishScorecardRun,
  readPublishedScorecard,
  resolveAuditUrls,
  resolveRunStamp,
} from './activities/scorecard.js';
import {
  HEALTHCHECK_BASE,
  HOSTED_ACTIVITY_CONCURRENCY,
  IS_TEMPORAL_CLOUD,
  NAMESPACE,
  QUEUE_AUDIT,
  TEMPORAL_ADDRESS,
  WORKER_READY_LOG,
  temporalConnectionOptions,
} from './config.js';
import { log } from './lib/logger.js';

/**
 * The **hosted** worker: one process, one queue, no checkout.
 *
 * This is the entry the Railway container runs (always-on-audit-worker card,
 * leg 2b). `worker.ts` is unchanged and is still what `steward up` starts on
 * Matt's machine — that one registers all three queues, so the laptop can serve
 * everything when it happens to be on, and the two workers do not compete
 * because they claim different queues.
 *
 * ## Why this is a separate file rather than a flag on `worker.ts`
 *
 * `worker.ts` registers `activities/index.js` wholesale. Doing that here would
 * make this worker *claim* `reviewPost`'s tasks — `snapshotDraft`,
 * `applyPatchesActivity`, `buildAndAuditDraft` — and then fail every one of
 * them, because they read drafts out of a working copy this container does not
 * have. A worker that fails tasks is worse than a worker that never claims
 * them: the failures burn the activity's retries and the review dies rather
 * than waiting for the laptop.
 *
 * So the activity map below is written out by hand. It is exactly what
 * `workflows/audit-site.ts` and `workflows/scorecard-audit.ts` name, and adding
 * anything to it is a claim that the new activity needs nothing local. The
 * queue is the enforcement (`config.ts`'s `QUEUE_AUDIT`); this list is the
 * second lock on the same door.
 *
 * ## Host-agnostic on purpose
 *
 * Nothing in this file, or in the Dockerfile beside it, knows what Railway is.
 * The three connection variables come from the environment, which `config.ts`
 * already prefers over `.env`, so the same image runs on Railway today and on
 * Temporal's Serverless Workers later with no code change
 * (audit-worker-on-serverless-workers card). That was the stage-3 card's
 * decision and this is where it has to be honoured.
 */

const workflowsPath = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

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
  archiveScorecardRun,
  // The scorecard's alerting leg. Both are one HTTPS POST to the alerting
  // service and read `STEWARD_HEALTHCHECK_BASE` from the host's environment, so
  // they satisfy the "nothing local" rule this list enforces.
  reportRunHealth,
  checkCredentialExpiry,
};

/**
 * The same `unhandledRejection` guard `worker.ts` carries, and for the same
 * reason — `chrome-launcher` can reject detached from anything this codebase
 * awaits, which would otherwise take the whole process down and with it every
 * concurrent audit. Read that file's docblock for the full account.
 *
 * It matters more here than there. On the laptop a crashed worker is a thing
 * Matt notices; in a container it is a restart loop nobody is watching.
 */
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'unhandled rejection — logged, not fatal (see worker.ts)');
});

/**
 * Fail at boot rather than at 03:30.
 *
 * This worker owns the scorecard's publish and archive legs, which are GitHub
 * API calls now, so a container with no token is a container that runs a
 * twelve-minute audit every night and then throws it away. `gh()` would raise
 * `AuthError` at that point, hours after the deploy that caused it and with
 * nobody reading the logs. A refusal to start is loud, immediate, and visible
 * in Railway's own deploy status.
 *
 * The value is never read here, only its presence — see `config.ts` on secrets.
 */
function assertPublishCredentials(): void {
  if (process.env.GITHUB_TOKEN) return;
  throw new Error(
    'GITHUB_TOKEN is not set. The hosted worker serves the scorecard, whose publish and ' +
      'archive legs write to the repository through the GitHub API. Set it in the host\'s ' +
      'environment (on Railway: the service\'s Variables tab) and redeploy.',
  );
}

/**
 * Warn, never refuse.
 *
 * A missing `GITHUB_TOKEN` means the nightly run throws its work away, so the
 * worker refuses to start. A missing ping base means the nightly run still works
 * and nobody hears about it if it stops — bad, but strictly better than a
 * monitoring variable being able to take the whole audit tier down. The
 * asymmetry is the point: alerting must never be load-bearing for the thing it
 * watches.
 */
function warnIfUnmonitored(): void {
  if (HEALTHCHECK_BASE) return;
  log.warn(
    'STEWARD_HEALTHCHECK_BASE is unset — no run-health signals will be sent, so a failed or ' +
      'bad-shaped nightly scorecard, and a dead worker, will pass unnoticed. Set it in the ' +
      "host's environment (on Railway: the service's Variables tab).",
  );
}

async function main() {
  assertPublishCredentials();
  warnIfUnmonitored();

  const connection = await NativeConnection.connect(temporalConnectionOptions());

  const worker = await Worker.create({
    connection,
    namespace: NAMESPACE,
    workflowsPath,
    activities,
    taskQueue: QUEUE_AUDIT,
    // One activity at a time, and never more. The SDK's default is 100, which is
    // how two strangers' deep audits came to render simultaneously and corrupt
    // each other's Lighthouse timing marks. `config.ts`'s docblock carries the
    // evidence and the cost this accepts; the short version is that serialising
    // the cheap activities behind a page render is the price of the render
    // activities working at all.
    //
    // Workflow tasks are a separate budget (`maxConcurrentWorkflowTaskExecutions`,
    // untouched), so a queued run's workflow still progresses and still answers
    // the progress query while somebody else's render holds the activity slot.
    maxConcurrentActivityTaskExecutions: HOSTED_ACTIVITY_CONCURRENCY,
    // Stop polling on SIGTERM, then give in-flight work 20 seconds before
    // cancelling it. **No `process.on('SIGTERM')` handler here on purpose**: the
    // SDK Runtime already installs one for SIGINT/SIGTERM/SIGQUIT/SIGUSR2, and a
    // hand-rolled handler that calls `process.exit()` pre-empts the drain it was
    // meant to perform.
    //
    // 20 seconds is sized against the host, not against the work. A page render
    // can take 90s, so this is never long enough to finish one — and it does not
    // need to be. A cancelled `auditRenderedPage` is retried by the server and
    // the pages already done are in workflow history, which is exactly the
    // per-page durability leg 2 bought. What the grace period buys is the
    // cheaper case: an activity seconds from returning gets to return.
    shutdownGraceTime: '20 seconds',
    // The guarantee that a redeploy actually completes. Without it a wedged
    // Chrome could hold the process past the platform's own kill deadline, and
    // the restart reads as a crash rather than a deploy.
    shutdownForceTime: '40 seconds',
  });

  log.info(
    {
      queues: [QUEUE_AUDIT],
      namespace: NAMESPACE,
      address: TEMPORAL_ADDRESS,
      service: IS_TEMPORAL_CLOUD ? 'temporal-cloud' : 'local-dev-server',
      activities: Object.keys(activities),
      hosted: true,
      // In the ready line for the same reason `alerting` is: it is a fact a
      // deploy can change, and the operator reading this line after a deploy is
      // the person who would otherwise find out from a corrupted report.
      activityConcurrency: HOSTED_ACTIVITY_CONCURRENCY,
      // Named in the ready line because the operator reads this line after every
      // deploy, and "alerting is off" is precisely the fact a deploy can change
      // by accident (a variable dropped from the Variables tab) and that nothing
      // else would ever announce.
      alerting: HEALTHCHECK_BASE ? 'configured' : 'OFF',
    },
    WORKER_READY_LOG,
  );

  await worker.run();
  log.info({ queues: [QUEUE_AUDIT] }, 'steward hosted worker drained and stopped');
}

main().catch((err) => {
  log.error({ err }, 'hosted worker exited');
  process.exit(1);
});
