import { WorkflowNotFoundError, WorkflowUpdateFailedError, type Client } from '@temporalio/client';
import { findingWorkflowId } from './findings.js';
import { measureNowUpdate, type MeasureNowAccepted } from '../workflows/finding.js';

/**
 * `steward finding measure-now <key>` (stage 4): one `measure-now` Update to a
 * finding run watching production, which cancels its pending `watchFinding`
 * and issues it again, so the measurement runs now rather than at the next
 * daily window. The workflow's validator decides.
 */

/** A measurement the run refused, or a run that cannot take one. The message is the CLI's answer. */
export class MeasureNowRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeasureNowRefused';
  }
}

/**
 * Sends the Update and returns what the run accepted. Throws
 * {@link MeasureNowRefused} with a plain sentence when there is no run, the
 * run has ended, or its validator refused; any other error passes through.
 */
export async function requestMeasureNow(
  client: Client,
  site: string,
  key: string,
  at: string,
  source: 'cli' | 'console' = 'cli',
): Promise<MeasureNowAccepted> {
  const workflowId = findingWorkflowId(site, key);
  const handle = client.workflow.getHandle(workflowId);
  let status: string;
  try {
    status = (await handle.describe()).status.name;
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) throw new MeasureNowRefused(`No run ${workflowId}, so ${key} has nothing to measure.`);
    throw err;
  }
  if (status !== 'RUNNING') {
    throw new MeasureNowRefused(`The run ${workflowId} has ended (${status.toLowerCase()}), so ${key} has nothing to measure.`);
  }
  try {
    return await handle.executeUpdate(measureNowUpdate, { args: [{ source, at }] });
  } catch (err) {
    if (err instanceof WorkflowUpdateFailedError) {
      const cause = err.cause instanceof Error ? err.cause.message : err.message;
      throw new MeasureNowRefused(`Steward did not measure ${key}: ${cause}`);
    }
    throw err;
  }
}

/** What the CLI says after an accepted measurement. */
export function measuredNowLine(key: string): string {
  return `The run measures ${key} on production now. \`steward finding status ${key}\` shows the attempt and its last result.`;
}
