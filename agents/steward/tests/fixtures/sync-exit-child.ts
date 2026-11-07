import { syncFindings, type SyncClient } from '../../src/lib/finding-actions.js';

/**
 * The child process of the exit test in `tests/lib/finding-actions.test.ts`: one
 * successful `syncFindings` against a fake client, with the default `resultMs`,
 * then no `process.exit`. The process ends when nothing holds it, so a timer
 * `syncFindings` left running is what keeps it alive.
 */

let taken = 0;
const recentActions: { action: { type: string; workflow: { workflowId: string; firstExecutionRunId: string } } }[] = [];

const client: SyncClient = {
  schedule: {
    getHandle: () => ({
      describe: async () => ({ info: { numActionsTaken: taken, numActionsSkippedOverlap: 0, recentActions } }),
      trigger: async () => {
        taken += 1;
        recentActions.push({ action: { type: 'startWorkflow', workflow: { workflowId: 'reconcile-run', firstExecutionRunId: 'run-1' } } });
      },
    }),
  },
  workflow: { getHandle: () => ({ result: async () => ({ 'mattpyle-com': { started: 1, signalled: 0, fixed: 0, unchanged: 2 } }) }) },
};

const result = await syncFindings(client, { pollMs: 1 });
console.log(JSON.stringify({ triggered: result.triggered, total: result.total }));
