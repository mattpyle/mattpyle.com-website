import { WorkflowNotFoundError } from '@temporalio/client';
import { ARGUS_REPO, NAMESPACE, WEB_UI } from '../config.js';
import { readSiteAutoFix } from '../activities/findings.js';
import { approvedNextStep } from './finding-fix.js';
import { findingWorkflowId, type FindingVerdict } from './findings.js';
import {
  findingStateQuery,
  verdictSignal,
  type FindingState,
  type FindingWorkflowResult,
} from '../workflows/finding.js';

/**
 * The one way a verdict reaches a finding run: `steward finding approve|reject`
 * and the `steward console` buttons both call {@link sendFindingVerdict}, so the
 * page and the verbs send one signal payload and read one result.
 *
 * The source stays `cli` for both callers: `findingWorkflow` writes the file
 * only for that source, and a `console` source would need a workflow change
 * deployed first. The console's default approve reason names the console.
 *
 * Nothing here prints or exits. The caller renders the result, and a refusal
 * is a {@link FindingVerdictError} whose message the operator can act on.
 */

/** How long a verdict waits for the workflow to finish writing. */
export const FINDING_VERDICT_POLL_MS = 60_000;

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
  signal(def: typeof verdictSignal, verdict: FindingVerdict): Promise<void>;
  query(def: typeof findingStateQuery): Promise<FindingState>;
  result(): Promise<unknown>;
}

export interface FindingVerdictRequest {
  site: string;
  key: string;
  status: FindingVerdict['status'];
  reason: string;
}

export interface FindingVerdictOptions {
  client: VerdictClient;
  /** Called once the signal is sent, before the wait for the write. */
  onSent?: (workflowId: string) => void;
  /** The site's `auto_fix` flag, for the next-step line after an approval. */
  readAutoFix?: (site: string) => Promise<boolean>;
  pollMs?: number;
  /** The sender's clock, for the verdict's `at`. */
  now?: () => Date;
}

export interface FindingVerdictResult {
  workflowId: string;
  /** The payload this call signalled. */
  sent: FindingVerdict;
  /** The verdict the run recorded. A `file` source means an earlier verdict won and nothing was written. */
  recorded: FindingVerdict;
  commitSha: string | null;
  /** After an approval on a run that stays open: what the run does next. */
  nextStep: string | null;
  /** Set when the `auto_fix` read failed, so the next step is unknown; the verdict is recorded regardless. */
  nextStepError: Error | null;
  webUrl: string;
}

export class FindingVerdictError extends Error {
  /** `no-run`: nothing was sent. `timeout`: the signal is recorded but the write did not finish in time. */
  readonly kind: 'no-run' | 'timeout';
  constructor(kind: 'no-run' | 'timeout', message: string) {
    super(message);
    this.name = 'FindingVerdictError';
    this.kind = kind;
  }
}

/** The signal payload. One function, so no caller can spell it differently. */
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

/**
 * Signals the verdict, waits until the run has written it, and returns what
 * was recorded: the verdict, the commit and the next step.
 */
export async function sendFindingVerdict(
  request: FindingVerdictRequest,
  options: FindingVerdictOptions,
): Promise<FindingVerdictResult> {
  const { site, key, status, reason } = request;
  const pollMs = options.pollMs ?? FINDING_VERDICT_POLL_MS;
  const handle = await openFindingHandle(options.client, site, key);
  const sent = buildFindingVerdict(status, reason, options.now?.() ?? new Date());
  await handle.signal(verdictSignal, sent);
  options.onSent?.(handle.workflowId);

  const deadline = Date.now() + pollMs;
  let state: FindingState | undefined;
  for (;;) {
    const described = await handle.describe();
    if (described.status.name !== 'RUNNING') break;
    state = await handle.query(findingStateQuery);
    if (state.status === 'done') break;
    if (Date.now() > deadline) {
      throw new FindingVerdictError(
        'timeout',
        `Still ${state.status} after ${pollMs / 1000}s. The signal is recorded; ` +
          `check \`steward finding status ${key}\` or the workflow in ${WEB_UI}.`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // A `resolved` run stays open past the verdict, so its state, not its
  // result, carries what was recorded.
  const stillOpen = (await handle.describe()).status.name === 'RUNNING';
  const recorded = stillOpen && state ? state : ((await handle.result()) as FindingWorkflowResult);
  const recordedVerdict = recorded.verdict as FindingVerdict;

  let nextStep: string | null = null;
  let nextStepError: Error | null = null;
  if (stillOpen && recordedVerdict.status === 'approved') {
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
    recorded: recordedVerdict,
    commitSha: recorded.commitSha ?? null,
    nextStep,
    nextStepError,
    webUrl: `${WEB_UI}/namespaces/${NAMESPACE}/workflows/${encodeURIComponent(handle.workflowId)}`,
  };
}
