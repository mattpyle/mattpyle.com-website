import * as wf from '@temporalio/workflow';
import type { FixFindingInput, FixFindingResult, FixFindingState } from '../../src/workflows/fix-finding.js';

/**
 * A `fixFindingWorkflow` that opens a PR at once, for the `steward finding fix`
 * tests. The real child is covered by its own suite; these tests are about who
 * starts it. Registered on the heavy queue under the real type name, so
 * `findingWorkflow` starts it as its child.
 */

export const STUB_PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/501';

const stateQuery = wf.defineQuery<FixFindingState>('state');

export async function fixFindingWorkflow(input: FixFindingInput): Promise<FixFindingResult> {
  wf.setHandler(stateQuery, () => ({ site: input.site, key: input.key, step: 'opening', prUrl: null }));
  return {
    site: input.site,
    key: input.key,
    prUrl: STUB_PR,
    draft: false,
    branch: input.branch,
    commitSha: 'c-fix',
    filesChanged: [],
    handoffCommitSha: null,
    findingCommitSha: null,
    run: {
      exitCode: 0,
      timedOut: false,
      model: null,
      numTurns: null,
      costUsd: null,
      handoffCostUsd: null,
      permissionDenials: [],
      timingsMs: { worktree: 0, install: 0, claude: 0, checks: 0, push: 0, total: 0 },
      checks: [],
    },
  };
}
