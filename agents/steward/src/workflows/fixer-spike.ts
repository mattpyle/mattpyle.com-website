import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

/**
 * `fixerSpikeWorkflow`: one activity, and the PR URL it returns.
 *
 * Deliberately nothing else. The spike exists to learn what `runFixer` costs
 * and how it fails, and every step added here would be a step the fixer build
 * inherits before that is known.
 */

// Duplicated rather than imported from config.ts, as in the sibling workflows:
// config.ts touches `node:path` and `process.env`, neither available in the
// workflow sandbox. The heavy queue is the laptop's alone, which is where the
// checkout, the Claude Code login and the git credentials are.
const QUEUE_HEAVY = 'steward-heavy';

export interface FixerSpikeInput {
  /** Repo-relative path of the handoff, resolved by the CLI. */
  handoffPath: string;
  /** The branch the run creates and pushes, resolved by the CLI. */
  branch: string;
}

// One attempt: a second would spend another model turn on the same handoff and
// force-push over whatever the first left. The heartbeat timeout is what turns
// a dead worker into a failure in a minute rather than in forty-five.
const { runFixer } = wf.proxyActivities<Pick<typeof activities, 'runFixer'>>({
  taskQueue: QUEUE_HEAVY,
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

export async function fixerSpikeWorkflow(input: FixerSpikeInput): Promise<string> {
  const result = await runFixer(input);
  return result.prUrl;
}
