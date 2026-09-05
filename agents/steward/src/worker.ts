import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';
import {
  IS_TEMPORAL_CLOUD,
  NAMESPACE,
  QUEUE_AUDIT,
  QUEUE_AUDIT_FAST,
  QUEUE_HEAVY,
  QUEUE_LIGHT,
  TEMPORAL_ADDRESS,
  SITE_DIR,
  WORKER_READY_LOG,
  temporalConnectionOptions,
} from './config.js';
import { log } from './lib/logger.js';

const workflowsPath = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

/**
 * Found live running the Scorecard's concurrent audit fan-out (spec §9.6's
 * smoke test): `chrome-launcher`'s own `waitUntilReady()` retry-exhausted
 * branch reads `chrome-err.log` with a synchronous `readFileSync` inside an
 * internal `.catch()` continuation that is not part of anything this codebase
 * awaits — when that file is already gone (a race under concurrent Chrome
 * launches, worse on Windows), the resulting rejection is *unhandled* at the
 * Node level and would otherwise crash the entire worker process, taking
 * down every other in-flight activity with it.
 *
 * This is upstream flakiness, not something `audit-engine.ts`'s own
 * try/catch around `launch()`/`kill()` can reach — that code path throws
 * asynchronously, detached from any promise this codebase holds a reference
 * to. Converting a fatal crash into a logged warning is the correct
 * worker-level defence per design rule 4 (a tool failure is a flag, not a
 * silently dropped page, and it must certainly never be a crashed worker):
 * the activity that was mid-flight when this fires will time out and retry
 * normally, rather than every concurrent activity being killed by a Chrome
 * problem with one page.
 */
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'unhandled rejection — logged, not fatal (see worker.ts)');
});

/**
 * One process, every queue (spec §3).
 *
 * The laptop worker polls everything, which is what keeps `steward up` a single
 * command. The split is about who *else* may poll: `steward-audit` carries work
 * with no local dependency, so a hosted worker can serve that queue alone
 * (always-on-audit-worker card) while `reviewPost` and the scorecard's publish
 * leg stay here, where the working copy is.
 *
 * `steward-audit-fast` is here for a different reason: it is the queue the site's
 * public `audit_site` tool starts a standalone `auditSiteFast` on, and serving it
 * from the laptop is what lets `npm run dev` against `steward up` exercise the
 * standalone path rather than only the in-function fallback. No concurrency cap
 * and no recycle: this worker is operator-attended and must never exit
 * mid-session.
 */
async function main() {
  const connection = await NativeConnection.connect(temporalConnectionOptions());

  const common = { connection, namespace: NAMESPACE, workflowsPath, activities };

  const workers = await Promise.all([
    Worker.create({ ...common, taskQueue: QUEUE_LIGHT }),
    Worker.create({ ...common, taskQueue: QUEUE_HEAVY }),
    Worker.create({ ...common, taskQueue: QUEUE_AUDIT }),
    Worker.create({ ...common, taskQueue: QUEUE_AUDIT_FAST }),
  ]);

  log.info(
    {
      queues: [QUEUE_LIGHT, QUEUE_HEAVY, QUEUE_AUDIT, QUEUE_AUDIT_FAST],
      namespace: NAMESPACE,
      address: TEMPORAL_ADDRESS,
      service: IS_TEMPORAL_CLOUD ? 'temporal-cloud' : 'local-dev-server',
      siteDir: SITE_DIR,
    },
    WORKER_READY_LOG,
  );

  await Promise.all(workers.map((w) => w.run()));
}

main().catch((err) => {
  log.error({ err }, 'worker exited');
  process.exit(1);
});
