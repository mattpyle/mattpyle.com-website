import { parseWorkerRole } from './worker-role.js';

/**
 * What the hosted image runs (`npm run worker:hosted`, the Dockerfile's CMD).
 *
 * It reads `STEWARD_WORKER_ROLE` and loads the entry for that role, and nothing
 * else: `worker-hosted.ts` for the credentialed worker and the public-audit
 * worker, `discord/main.ts` for the Discord service. Each entry starts itself
 * at import.
 *
 * The split is a dynamic import on purpose. `worker-hosted.ts` imports the
 * worker's native bridge and every activity map at module scope, and the
 * Discord service needs neither: it holds a Temporal client and an HTTP
 * listener. A mistyped role throws here, before either entry loads.
 */
const role = parseWorkerRole(process.env);

if (role === 'discord') {
  await import('./discord/main.js');
} else {
  await import('./worker-hosted.js');
}
