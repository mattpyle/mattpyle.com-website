import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import {
  HEALTHCHECK_BASE,
  METRICS_API_KEY,
  IS_TEMPORAL_CLOUD,
  NAMESPACE,
  REPO_ROOT,
  TEMPORAL_ADDRESS,
  WORKER_READY_LOG,
  temporalConnectionOptions,
} from './config.js';
import { hostedRegistry, type HostedQueue } from './hosted-registry.js';
import { assertLighthouseMatchesLock } from './lib/install-state.js';
import { log } from './lib/logger.js';
import {
  ActivityTracker,
  RECYCLE_IDLE_MS,
  shouldRecycle,
  trackActivityExecution,
} from './lib/recycle-policy.js';

/**
 * The **hosted** worker: one process, three queues, no checkout.
 *
 * The third queue, `steward-findings` (2026-09-12), follows the second's shape
 * and is described where it is created in `main()`.
 *
 * This is the entry the Railway container runs (always-on-audit-worker card,
 * leg 2b). `worker.ts` is unchanged in shape and is still what `steward up`
 * starts on Matt's machine — that one registers `steward-light` and `steward-heavy`, plus the
 * two audit queues only against the local dev server, and never
 * `steward-findings`. The two processes do not compete because they claim
 * different queues.
 *
 * ## Why two `Worker`s in one process
 *
 * `steward-audit` takes one activity at a time, which is a correctness rule
 * about Lighthouse rather than a throughput setting (`config.ts`'s
 * `HOSTED_ACTIVITY_CONCURRENCY`). The public `audit_site` tool runs
 * `auditSiteFast` as a standalone activity on this container and a caller holds
 * that call open, so a fast audit on that queue would wait behind a 90-second
 * page render or behind the nightly scorecard's twelve minutes. A second
 * `Worker` on `steward-audit-fast`, registering `auditSiteFast` and nothing
 * else, gives the public tool its own dispatch budget on the same connection and
 * in the same process. Nothing about it is a second deployment: one container,
 * one image, two pollers.
 *
 * ## Why this is a separate file rather than a flag on `worker.ts`
 *
 * `worker.ts` registers `activities/index.js` wholesale. Doing that here would
 * make this worker *claim* `reviewPost`'s tasks — `snapshotDraft`,
 * `applyPatchesActivity`, `buildAndAuditDraft` — and then fail every one of
 * them, because they read drafts out of a working copy this container does not
 * have. A worker that fails tasks is worse than a worker that never claims
 * them: the failures burn the activity's retries and the review dies rather
 * than waiting for the local machine.
 *
 * So the activity maps are written out by hand, in `hosted-registry.ts`, which
 * this file builds its workers from. The audit map is exactly what
 * `workflows/audit-site.ts` and `workflows/scorecard-audit.ts` name, and adding
 * anything to a map is a claim that the new activity needs nothing local. The
 * queue is the enforcement (`config.ts`'s `QUEUE_AUDIT`); the map is the
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
 * The same `unhandledRejection` guard `worker.ts` carries, and for the same
 * reason — `chrome-launcher` can reject detached from anything this codebase
 * awaits, which would otherwise take the whole process down and with it every
 * concurrent audit. Read that file's docblock for the full account.
 *
 * It matters more here than there. On the local machine a crashed worker is a thing
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
  if (!HEALTHCHECK_BASE) {
    log.warn(
      'STEWARD_HEALTHCHECK_BASE is unset — no run-health signals will be sent, so a failed or ' +
        'bad-shaped nightly scorecard, and a dead worker, will pass unnoticed. Set it in the ' +
        "host's environment (on Railway: the service's Variables tab).",
    );
  }
  // Its own warning rather than a clause in that one: the two variables switch
  // off different things, and a worker with alerting configured but no metrics
  // key is a worker whose spend surface is unwatched while every other check
  // looks healthy — which is precisely the state that would otherwise go
  // unnoticed for a month.
  if (!METRICS_API_KEY) {
    log.warn(
      'TEMPORAL_METRICS_API_KEY is unset — the nightly run will not sample Temporal Cloud action ' +
        'usage, so a runaway workflow burning actions will pass unnoticed until somebody opens ' +
        "the Cloud usage page. Set it in the host's environment (on Railway: the service's " +
        'Variables tab).',
    );
  }
}

/**
 * How often the recycle policy is consulted. Cheap — three numbers and a
 * comparison — so the interval is set by how long a recycle may be late, not by
 * what a check costs. Half a minute against a five-minute idle window means the
 * worker exits within about 5.5 minutes of the last activity.
 */
const RECYCLE_CHECK_MS = 30_000;

/**
 * Watch the worker and shut it down once the recycle policy says to.
 *
 * The timers are `unref`'d so this loop can never be the reason the process
 * stays alive: if the worker stops for any other reason, nothing here holds the
 * event loop open. `triggered` resolves only for a real recycle; the caller
 * races it against `worker.run()` and calls `stop()` on either outcome.
 *
 * `shutdown()` and not `process.exit()`: the point of exiting cleanly is that
 * in-flight work drains first, and the SDK's shutdown is the only thing that
 * does that. The policy already refuses to fire with work in flight, so the
 * drain is normally instant; the grace period is the belt for the case where an
 * activity started in the moments after the check.
 */
function watchForRecycle(
  workers: Worker[],
  tracker: ActivityTracker,
): { triggered: Promise<boolean>; stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const triggered = new Promise<boolean>((resolve) => {
    timer = setInterval(() => {
      // Every worker, because they share this process's memory and this
      // process's exit. One still starting up, or already draining, is a moment
      // the policy cannot read, so the check waits for the next tick.
      if (workers.some((worker) => worker.getState() !== 'RUNNING')) return;
      const decision = shouldRecycle(tracker.state(), Date.now());
      if (!decision.recycle) return;
      clearInterval(timer);
      log.info(
        {
          reason: decision.reason,
          idleWindowMs: RECYCLE_IDLE_MS,
          // The number this whole change exists for. Read it next to Railway's
          // memory metric: this is the process, that is the cgroup, and the gap
          // between them is page cache the restart also releases.
          rssBytes: process.memoryUsage().rss,
        },
        'hosted worker recycling: draining, then exiting 0 for a fresh container',
      );
      for (const worker of workers) worker.shutdown();
      resolve(true);
    }, RECYCLE_CHECK_MS);
    timer.unref();
  });
  return {
    triggered,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

async function main() {
  // Before the first poll; see the same guard in `worker.ts`.
  const lighthouse = assertLighthouseMatchesLock(REPO_ROOT);
  assertPublishCredentials();
  warnIfUnmonitored();

  const connection = await NativeConnection.connect(temporalConnectionOptions());

  const tracker = new ActivityTracker();

  const [audit, fast, findings] = hostedRegistry();
  const queues = () => [audit.taskQueue, fast.taskQueue, findings.taskQueue];

  /**
   * One `Worker` per registry entry: the queue, its activity map, the workflow
   * bundle if the entry carries it, and its cap. Everything below is what the
   * registry leaves to the entry point because it is about this process, not
   * about a queue.
   *
   * Stop polling on SIGTERM, then give in-flight work 20 seconds before
   * cancelling it. **No `process.on('SIGTERM')` handler here on purpose**: the
   * SDK Runtime already installs one for SIGINT/SIGTERM/SIGQUIT/SIGUSR2, and a
   * hand-rolled handler that calls `process.exit()` pre-empts the drain it was
   * meant to perform.
   *
   * 20 seconds is sized against the host, not against the work. A page render
   * can take 90s, so this is never long enough to finish one — and it does not
   * need to be. A cancelled `auditRenderedPage` is retried by the server and
   * the pages already done are in workflow history, which is exactly the
   * per-page durability leg 2 bought. What the grace period buys is the
   * cheaper case: an activity seconds from returning gets to return.
   *
   * The 40-second force time is the guarantee that a redeploy actually
   * completes. Without it a wedged Chrome could hold the process past the
   * platform's own kill deadline, and the restart reads as a crash rather than
   * a deploy.
   *
   * The interceptor is the only reason these workers have one: the recycle
   * policy needs to know when a browser activity ran and when the last activity
   * finished, and the activities themselves are shared with the local worker,
   * which must never recycle. Observing from out here keeps them ignorant of
   * hosting. All three share one tracker because one process exits once, and the
   * in-flight count has to see every queue or it would exit mid-activity.
   */
  const createWorker = (entry: HostedQueue) =>
    Worker.create({
      connection,
      namespace: NAMESPACE,
      ...(entry.carriesWorkflows ? { workflowsPath } : {}),
      activities: entry.activities,
      taskQueue: entry.taskQueue,
      // The SDK's default is 100, which is how two strangers' deep audits came to
      // render simultaneously and corrupt each other's Lighthouse timing marks.
      // `config.ts`'s docblocks carry the evidence and the cost of each cap.
      // Workflow tasks are a separate budget (`maxConcurrentWorkflowTaskExecutions`,
      // untouched), so a queued run's workflow still progresses and still answers
      // the progress query while somebody else's render holds the activity slot.
      maxConcurrentActivityTaskExecutions: entry.maxConcurrentActivityTaskExecutions,
      shutdownGraceTime: '20 seconds',
      shutdownForceTime: '40 seconds',
      interceptors: { activity: [trackActivityExecution(tracker)] },
    });

  // The audit queue: the serial one, and the workflow bundle for the audit and
  // scorecard workflows.
  const worker = await createWorker(audit);
  // The public MCP endpoint's queue: no workflows, no browser, its own budget.
  const fastWorker = await createWorker(fast);
  // The findings gate's queue: `findingWorkflow`, `reconcileFindingsWorkflow` and
  // their activities, with its own `Worker` so a verdict write never waits
  // behind a page render.
  const findingsWorker = await createWorker(findings);

  log.info(
    {
      queues: queues(),
      lighthouse,
      namespace: NAMESPACE,
      address: TEMPORAL_ADDRESS,
      service: IS_TEMPORAL_CLOUD ? 'temporal-cloud' : 'local-dev-server',
      activities: Object.keys(audit.activities),
      fastActivities: Object.keys(fast.activities),
      findingsActivities: Object.keys(findings.activities),
      hosted: true,
      // In the ready line for the same reason `alerting` is: it is a fact a
      // deploy can change, and the operator reading this line after a deploy is
      // the person who would otherwise find out from a corrupted report.
      activityConcurrency: audit.maxConcurrentActivityTaskExecutions,
      fastActivityConcurrency: fast.maxConcurrentActivityTaskExecutions,
      findingsActivityConcurrency: findings.maxConcurrentActivityTaskExecutions,
      // Named in the ready line because the operator reads this line after every
      // deploy, and "alerting is off" is precisely the fact a deploy can change
      // by accident (a variable dropped from the Variables tab) and that nothing
      // else would ever announce.
      alerting: HEALTHCHECK_BASE ? 'configured' : 'OFF',
      // Beside `alerting` and for the same reason: a variable dropped from the
      // Variables tab switches this check off silently, and the ready line after
      // a deploy is the only place that fact ever surfaces.
      actionUsage: METRICS_API_KEY ? 'configured' : 'OFF',
    },
    WORKER_READY_LOG,
  );

  // All three, and the process lives exactly as long as the set. `Promise.all`
  // rather than a race: a worker that stops on its own (a SIGTERM from a deploy,
  // a fatal error) has to take the other one down with it, or the container
  // would sit half-serving a queue with nobody watching.
  const running = Promise.all([worker.run(), fastWorker.run(), findingsWorker.run()]);
  const workers = [worker, fastWorker, findingsWorker];
  const stopAll = () => {
    for (const each of workers) if (each.getState() === 'RUNNING') each.shutdown();
  };
  running.catch(stopAll);
  const recycle = watchForRecycle(workers, tracker);
  // Whichever comes first: the policy asking for a recycle, or the workers
  // stopping for their own reasons.
  const recycled = await Promise.race([recycle.triggered, running.then(() => false)]);
  recycle.stop();
  stopAll();
  await running;
  log.info(
    { queues: queues() },
    'steward hosted worker drained and stopped',
  );
  // Exit 0 and not 1. `main().catch` below exits 1, so the code is what tells a
  // platform restart-on-failure from this deliberate one, and the recycle line
  // above is what tells an operator reading the deploy log the same thing.
  if (recycled) process.exit(0);
}

main().catch((err) => {
  log.error({ err }, 'hosted worker exited');
  process.exit(1);
});
