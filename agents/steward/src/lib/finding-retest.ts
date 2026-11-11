import { WorkflowNotFoundError, WorkflowUpdateFailedError, type Client } from '@temporalio/client';
import { findingWorkflowId } from './findings.js';
import { retestUpdate, type RetestAccepted } from '../workflows/finding.js';

/**
 * `steward finding retest <key>` (STW-587): one `retest` Update to the
 * finding's lifecycle run, which tests the open fix PR's head on its preview
 * again. The workflow's validator decides, so the answer is the run's own
 * state, read when the Update arrives and not before it.
 */

/** A retest the run refused, or a run that cannot take one. The message is the CLI's answer. */
export class RetestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetestRefused';
  }
}

export interface RetestRequested extends RetestAccepted {
  workflowId: string;
}

/**
 * Sends the Update and returns what the run accepted. Throws
 * {@link RetestRefused} with a plain sentence when there is no run, the run has
 * ended, or its validator refused; any other error is a transport failure and
 * passes through.
 */
export async function requestRetest(client: Client, site: string, key: string, at: string): Promise<RetestRequested> {
  const workflowId = findingWorkflowId(site, key);
  const handle = client.workflow.getHandle(workflowId);
  let status: string;
  try {
    status = (await handle.describe()).status.name;
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      throw new RetestRefused(`No run ${workflowId}, so ${key} has no open fix PR to test.`);
    }
    throw err;
  }
  if (status !== 'RUNNING') {
    throw new RetestRefused(`The run ${workflowId} has ended (${status.toLowerCase()}), so ${key} has no open fix PR to test.`);
  }
  try {
    const accepted = await handle.executeUpdate(retestUpdate, { args: [{ source: 'cli', at }] });
    return { ...accepted, workflowId };
  } catch (err) {
    if (err instanceof WorkflowUpdateFailedError) {
      const cause = err.cause instanceof Error ? err.cause.message : err.message;
      throw new RetestRefused(`Steward did not test ${key} again: ${cause}`);
    }
    throw err;
  }
}
