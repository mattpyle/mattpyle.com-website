import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';
import { NAMESPACE, QUEUE_HEAVY, QUEUE_LIGHT, TEMPORAL_ADDRESS, SITE_DIR, WORKER_READY_LOG } from './config.js';
import { log } from './lib/logger.js';

const workflowsPath = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

/**
 * One process, both queues (spec §3). The split exists so a future local/cloud
 * worker separation is a config change rather than a rewrite; today the heavy
 * queue has no activities registered against it beyond the shared set.
 */
async function main() {
  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });

  const common = { connection, namespace: NAMESPACE, workflowsPath, activities };

  const workers = await Promise.all([
    Worker.create({ ...common, taskQueue: QUEUE_LIGHT }),
    Worker.create({ ...common, taskQueue: QUEUE_HEAVY }),
  ]);

  log.info(
    { queues: [QUEUE_LIGHT, QUEUE_HEAVY], namespace: NAMESPACE, address: TEMPORAL_ADDRESS, siteDir: SITE_DIR },
    WORKER_READY_LOG,
  );

  await Promise.all(workers.map((w) => w.run()));
}

main().catch((err) => {
  log.error({ err }, 'worker exited');
  process.exit(1);
});
