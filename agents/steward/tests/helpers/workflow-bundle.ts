import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));

let bundle: Promise<WorkflowBundleWithSourceMap> | undefined;

/**
 * The compiled workflow code every workflow test and replay in this process shares.
 *
 * Pass it as `workflowBundle` in place of `workflowsPath` on `Worker.create` and
 * `Worker.runReplayHistory`. A `workflowsPath` makes the SDK run webpack over all of
 * `src/workflows` on every call: 240 compilations in a full run, 103 s of summed
 * compile time, for a bundle that is the same every time. Built once per process, the
 * 19 replays took 3 s instead of 12 s with every assertion kept.
 *
 * The cache is per process because `node --test` gives each test file its own process,
 * and a cache across them would need an artefact on disk and a rule for when it is stale.
 * The workflows are the real ones and the options are the ones the files passed before
 * (`workflowsPath`, `bundlerOptions: {}`), so a test sees the same code as it did.
 *
 * Not for the tests that bundle a stub (`tests/cli/finding-status-cli.test.ts`,
 * `tests/console/verdict-shared.test.ts`): they compile a different file.
 */
export function workflowBundle(): Promise<WorkflowBundleWithSourceMap> {
  bundle ??= bundleWorkflowCode({ workflowsPath });
  return bundle;
}
