import { WorkflowNotFoundError, WorkflowUpdateFailedError } from '@temporalio/client';
import { ARGUS_REPO, NAMESPACE, WEB_UI } from '../config.js';
import { readSiteAutoFix } from '../activities/findings.js';
import { approvedNextStep } from './finding-fix.js';
import { findingWorkflowId, type FindingVerdict } from './findings.js';
import { VERDICT_WRITE_FAILED, verdictUpdate, type VerdictRecorded } from '../workflows/finding.js';

/**
 * The one way a person's verdict reaches a finding run: `steward finding
 * approve|reject` and the `steward console` buttons both call
 * {@link sendFindingVerdict}, so the page and the verbs send one payload and
 * read one result.
 *
 * The verdict goes as the `record-verdict` Update (STW-636). The run's
 * validator refuses a verdict it cannot take, and the Update returns after the
 * run has written the verdict, so one call carries the answer and nothing here
 * polls. The `verdict` Signal stays for the reconciler and `steward finding fix`.
 *
 * The source stays `cli` for both callers: `findingWorkflow` writes the file
 * only for that source, and a `console` source would need a workflow change
 * deployed first. The console's default approve reason names the console.
 *
 * Nothing here prints or exits. The caller renders the result, and a refusal
 * is a {@link FindingVerdictError} whose message the operator can act on.
 */

/** How long a verdict waits: for a worker to accept it, then for the run to write it. */
export const FINDING_VERDICT_WAIT_MS = 60_000;

/** The verb's default approve reason, as it always was. */
export const CLI_APPROVE_REASON = 'Approved by Matt via steward finding approve.';

/** The console's default approve reason: the reason text is where a console verdict is told apart. */
export const CONSOLE_APPROVE_REASON = 'Approved by Matt via steward console.';

/** The part of a Temporal `Client` this module uses, so a test can hand it a fake. */
export interface VerdictClient {
  workflow: {
    getHandle(workflowId: string): VerdictHandle;
  };
}

export interface VerdictHandle {
  workflowId: string;
  describe(): Promise<{ status: { name: string } }>;
  startUpdate(
    def: typeof verdictUpdate,
    options: { args: [FindingVerdict]; waitForStage: 'ACCEPTED' },
  ): Promise<{ result(): Promise<VerdictRecorded> }>;
}

export interface FindingVerdictRequest {
  site: string;
  key: string;
  status: FindingVerdict['status'];
  reason: string;
}

export interface FindingVerdictOptions {
  client: VerdictClient;
  /** The site's `auto_fix` flag, for the next-step line after an approval. */
  readAutoFix?: (site: string) => Promise<boolean>;
  /** The bound on each wait: for the acceptance, then for the write. */
  waitMs?: number;
  /** The sender's clock, for the verdict's `at`. */
  now?: () => Date;
}

export interface FindingVerdictResult {
  workflowId: string;
  /** The payload this call sent. */
  sent: FindingVerdict;
  /** The verdict the run recorded. It is an earlier one when `first` is false. */
  recorded: FindingVerdict;
  /** False when an earlier verdict of the same status already stood, so this call wrote nothing. */
  first: boolean;
  commitSha: string | null;
  /** After an approval on a run that stays open: what the run does next. */
  nextStep: string | null;
  /** Set when the `auto_fix` read failed, so the next step is unknown; the verdict is recorded regardless. */
  nextStepError: Error | null;
  webUrl: string;
}

/**
 * - `no-run`: there is no open run; nothing was sent.
 * - `refused`: the run's validator refused the verdict; nothing was recorded.
 * - `old-worker`: the run's worker has no `record-verdict` handler; nothing was recorded.
 * - `unaccepted`: no worker took the verdict in time. It is not recorded yet, and a worker that
 *   returns may still take it, so the message says to check before sending it again.
 * - `timeout`: the run accepted the verdict and is still writing it.
 * - `write-failed`: the run accepted the verdict and its write failed or was cancelled.
 */
export type FindingVerdictErrorKind = 'no-run' | 'refused' | 'old-worker' | 'unaccepted' | 'timeout' | 'write-failed';

export class FindingVerdictError extends Error {
  readonly kind: FindingVerdictErrorKind;
  constructor(kind: FindingVerdictErrorKind, message: string) {
    super(message);
    this.name = 'FindingVerdictError';
    this.kind = kind;
  }
}

/** The verdict payload. One function, so no caller can spell it differently. */
export function buildFindingVerdict(
  status: FindingVerdict['status'],
  reason: string,
  at: Date = new Date(),
): FindingVerdict {
  return { status, reason, source: 'cli', at: at.toISOString() };
}

/**
 * The open workflow for one finding, or a refusal. A closed or missing
 * workflow is the same answer to the operator: there is nothing to send a
 * verdict to, and `steward finding list` shows what there is.
 */
async function openFindingHandle(client: VerdictClient, site: string, key: string): Promise<VerdictHandle> {
  const id = findingWorkflowId(site, key);
  const handle = client.workflow.getHandle(id);
  let running = false;
  try {
    running = (await handle.describe()).status.name === 'RUNNING';
  } catch (err) {
    if (!(err instanceof WorkflowNotFoundError)) throw err;
  }
  if (!running) {
    throw new FindingVerdictError('no-run', `No open workflow ${id}. \`steward finding list\` shows the open ones.`);
  }
  return handle;
}

const TIMED_OUT = Symbol('timed out');

/** The promise's value, or {@link TIMED_OUT} after `ms`. One timer, no loop. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  // A promise that loses the race still settles; its rejection is not this call's.
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The run's own sentence out of an Update failure. */
function updateFailure(err: WorkflowUpdateFailedError): { message: string; type: string | null } {
  const cause = err.cause as (Error & { type?: string | null }) | undefined;
  return { message: cause?.message ?? err.message, type: cause?.type ?? null };
}

/**
 * Sends the verdict as the `record-verdict` Update and returns what the run
 * recorded: the verdict, the commit and the next step. The Update returns
 * after the run's write, so there is no poll.
 */
export async function sendFindingVerdict(
  request: FindingVerdictRequest,
  options: FindingVerdictOptions,
): Promise<FindingVerdictResult> {
  const { site, key, status, reason } = request;
  const waitMs = options.waitMs ?? FINDING_VERDICT_WAIT_MS;
  const handle = await openFindingHandle(options.client, site, key);
  const sent = buildFindingVerdict(status, reason, options.now?.() ?? new Date());
  const check = `Check \`steward finding status ${key}\` or the workflow in ${WEB_UI}.`;

  // A failed Update, as the refusal the operator reads. The handler fails only
  // with `VERDICT_WRITE_FAILED`, so any other Update failure is a refusal:
  // the validator's, or the SDK's for a run with no handler.
  const refusal = (err: unknown): unknown => {
    if (err instanceof WorkflowNotFoundError) {
      return new FindingVerdictError('no-run', `No open workflow ${handle.workflowId}. \`steward finding list\` shows the open ones.`);
    }
    if (!(err instanceof WorkflowUpdateFailedError)) return err;
    const { message, type } = updateFailure(err);
    if (type === VERDICT_WRITE_FAILED) {
      return new FindingVerdictError('write-failed', `The run accepted the verdict and did not record it: ${message} ${check}`);
    }
    if (/^No registered handler for update\b/.test(message)) {
      return new FindingVerdictError(
        'old-worker',
        'The worker serving this run predates the verdict Update; nothing was recorded. Retry once the worker is deployed.',
      );
    }
    return new FindingVerdictError('refused', `Refused: ${message} Nothing was recorded.`);
  };

  // `startUpdate` returns once a worker has accepted or refused the Update. A
  // refusal is thrown by `result()`, at once; so a `result()` still pending at
  // the bound belongs to an accepted Update.
  let update: { result(): Promise<VerdictRecorded> } | typeof TIMED_OUT;
  try {
    update = await within(handle.startUpdate(verdictUpdate, { args: [sent], waitForStage: 'ACCEPTED' }), waitMs);
  } catch (err) {
    throw refusal(err);
  }
  if (update === TIMED_OUT) {
    throw new FindingVerdictError(
      'unaccepted',
      `No worker took the verdict in ${waitMs / 1000}s. It is not recorded yet; a worker that returns may still take it. ${check}`,
    );
  }
  let recorded: VerdictRecorded | typeof TIMED_OUT;
  try {
    recorded = await within(update.result(), waitMs);
  } catch (err) {
    throw refusal(err);
  }
  if (recorded === TIMED_OUT) {
    throw new FindingVerdictError(
      'timeout',
      `The run accepted the verdict and is still writing it after ${waitMs / 1000}s. ${check}`,
    );
  }

  let nextStep: string | null = null;
  let nextStepError: Error | null = null;
  // A `resolved` run stays open past an approval.
  if (recorded.first && recorded.stopAfter === 'resolved' && recorded.verdict.status === 'approved') {
    // The verdict is recorded by now, so a failed read changes this line, not the outcome.
    const readAutoFix = options.readAutoFix ?? ((s: string) => readSiteAutoFix({ repo: ARGUS_REPO, site: s }));
    try {
      nextStep = approvedNextStep(key, await readAutoFix(site));
    } catch (err) {
      nextStepError = err instanceof Error ? err : new Error(String(err));
    }
  }

  return {
    workflowId: handle.workflowId,
    sent,
    recorded: recorded.verdict,
    first: recorded.first,
    commitSha: recorded.commitSha,
    nextStep,
    nextStepError,
    webUrl: `${WEB_UI}/namespaces/${NAMESPACE}/workflows/${encodeURIComponent(handle.workflowId)}`,
  };
}
