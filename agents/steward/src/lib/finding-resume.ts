import { WorkflowNotFoundError, WorkflowUpdateFailedError, type Client } from '@temporalio/client';
import { findingWorkflowId } from './findings.js';
import { findingStateQuery, resumeUpdate, type FindingState, type ResumeAccepted } from '../workflows/finding.js';

/**
 * `steward finding resume <key>` (STW-653): one `resume` Update to a finding
 * run parked after its fix PR, which runs the parked stage again: the verify,
 * the merge wait, the deploy wait or the returned write. The workflow's
 * validator decides, so the answer is the run's own state, read when the
 * Update arrives.
 *
 * `steward finding verify` and the console's Verify use it too: a parked run
 * learns that its file was decided elsewhere only from a message, so a verify
 * of a parked finding runs inside its run rather than beside it.
 */

/** A resume the run refused, or a run that cannot take one. The message is the CLI's answer. */
export class ResumeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeRefused';
  }
}

export interface ResumeRequested extends ResumeAccepted {
  workflowId: string;
}

/**
 * The finding's run when it is open and parked, else null. A run that is
 * absent, closed or at any other step is not parked. Errors other than "not
 * found" pass through.
 */
export async function parkedRun(client: Client, site: string, key: string): Promise<FindingState | null> {
  const handle = client.workflow.getHandle(findingWorkflowId(site, key));
  try {
    if ((await handle.describe()).status.name !== 'RUNNING') return null;
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return null;
    throw err;
  }
  const state = await handle.query(findingStateQuery);
  return state.step === 'parked' ? state : null;
}

/**
 * Sends the Update and returns what the run accepted. Throws
 * {@link ResumeRefused} with a plain sentence when there is no run, the run
 * has ended, or its validator refused; any other error passes through.
 */
export async function requestResume(
  client: Client,
  site: string,
  key: string,
  at: string,
  source: 'cli' | 'console' = 'cli',
): Promise<ResumeRequested> {
  const workflowId = findingWorkflowId(site, key);
  const handle = client.workflow.getHandle(workflowId);
  let status: string;
  try {
    status = (await handle.describe()).status.name;
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) throw new ResumeRefused(`No run ${workflowId}, so ${key} has nothing to resume.`);
    throw err;
  }
  if (status !== 'RUNNING') {
    throw new ResumeRefused(`The run ${workflowId} has ended (${status.toLowerCase()}), so ${key} has nothing to resume.`);
  }
  try {
    const accepted = await handle.executeUpdate(resumeUpdate, { args: [{ source, at }] });
    return { ...accepted, workflowId };
  } catch (err) {
    if (err instanceof WorkflowUpdateFailedError) {
      const cause = err.cause instanceof Error ? err.cause.message : err.message;
      throw new ResumeRefused(`Steward did not resume ${key}: ${cause}`);
    }
    throw err;
  }
}

/**
 * What `verify` says of a run parked at a stage other than its verify: a
 * verify would not run there, so it names the commands that move the run.
 */
export function parkedElsewhereLine(key: string, state: FindingState): string {
  const park = state.parked;
  if (!park) return `${key}'s run is parked; \`steward finding status ${key}\` says where.`;
  return `${key}'s run is parked at its ${park.stage}, not its verify, so there is nothing to verify yet: ${park.moves}`;
}

/** What the CLI and the console say after an accepted resume. */
export function resumedLine(key: string, accepted: ResumeAccepted): string {
  const what =
    accepted.stage === 'verify'
      ? 'verifies the fix on production again'
      : accepted.stage === 'merge'
        ? 'waits on the merge again'
        : accepted.stage === 'deploy'
          ? 'waits on the deploy again'
          : 'writes the closed PR back again';
  return `The run ${what}. \`steward finding status ${key}\` shows the step.`;
}
