import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
// Pure, no imports of its own: the ID, the paths and the verdict types are the
// same objects the reconciler and the CLI hold.
import type { FindingVerdict } from '../lib/findings.js';

/**
 * `findingWorkflow`: one execution per finding, `finding/<site>/<key>`, that
 * waits for Matt's verdict (findings-loop design, decisions 16 to 19).
 *
 * The gate is the `verdict` signal, and it has two senders. `steward finding
 * approve|reject` sends it with source `cli`, and this workflow writes the
 * verdict into the finding file and its index line. The hourly reconciler sends
 * it with source `file` when the verdict is already in the file (Discord through
 * Argus, or an edit in Obsidian), and this workflow writes nothing. Either way it
 * completes with the verdict as its result.
 *
 * **What rides where** (design rule 10). The repository, the two paths and the
 * stop point are in the input, so an open workflow keeps the arguments it was
 * started with whatever config says later. The verdict, its reason and its source
 * are in the signal, so the history records who decided what. Nothing here reads
 * config or the environment.
 *
 * **`stopAfter`** is `'verdict'` in phase 2, the only value this code knows. A
 * later phase (handoff generation, verification) starts new executions with a
 * later stop point rather than teaching open ones a new ending, so no workflow
 * started today ever replays through code it never ran.
 */

// Duplicated from config.ts rather than imported, for the reason
// scorecard-audit.ts gives: config.ts touches `node:path` and `process.env`.
const QUEUE_FINDINGS = 'steward-findings';

export type FindingStopAfter = 'verdict';

export interface FindingWorkflowInput {
  site: string;
  key: string;
  /** `owner/name` of the findings repository. */
  repo: string;
  /** `sites/<site>/findings/<key>.md` */
  findingPath: string;
  /** `sites/<site>/findings/INDEX.md` */
  indexPath: string;
  stopAfter: FindingStopAfter;
}

export interface FindingWorkflowResult {
  site: string;
  key: string;
  verdict: FindingVerdict;
  /** The last commit the write made, when the verdict came by CLI and changed the files. */
  commitSha: string | null;
}

export interface FindingState {
  site: string;
  key: string;
  status: 'waiting' | 'writing' | 'done';
  verdict: FindingVerdict | null;
  commitSha: string | null;
}

export const verdictSignal = wf.defineSignal<[FindingVerdict]>('verdict');
export const findingStateQuery = wf.defineQuery<FindingState>('state');

/**
 * Five attempts with backoff, because the retryable failure here is a real one:
 * Argus pushing to the same repository between the read and the write, which
 * GitHub answers with 409 and the next attempt resolves from a fresh read. The
 * rest are permanent and named so they fail on the first attempt.
 */
const writing = wf.proxyActivities<Pick<typeof activities, 'writeFindingVerdict'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthError', 'NotFound', 'UnprocessableRequest', 'FindingMissing', 'FindingMalformed'],
  },
});

function isVerdict(value: unknown): value is FindingVerdict {
  const v = value as FindingVerdict;
  return (
    typeof v === 'object' &&
    v !== null &&
    (v.status === 'approved' || v.status === 'rejected') &&
    (v.source === 'cli' || v.source === 'file') &&
    typeof v.reason === 'string' &&
    typeof v.at === 'string'
  );
}

export async function findingWorkflow(input: FindingWorkflowInput): Promise<FindingWorkflowResult> {
  if (input.stopAfter !== 'verdict') {
    throw wf.ApplicationFailure.nonRetryable(
      `stopAfter "${String(input.stopAfter)}" is not a stop point this workflow knows.`,
      'UnknownStopPoint',
    );
  }

  const state: FindingState = {
    site: input.site,
    key: input.key,
    status: 'waiting',
    verdict: null,
    commitSha: null,
  };

  wf.setHandler(findingStateQuery, () => state);

  // The first well-formed verdict wins. A later one (the reconciler catching up
  // on a verdict the CLI already delivered, or a second CLI call) is logged and
  // dropped: the record is what was decided first, and a signal cannot reopen it.
  wf.setHandler(verdictSignal, (verdict) => {
    if (!isVerdict(verdict)) {
      wf.log.warn('ignoring a malformed verdict signal', { key: input.key });
      return;
    }
    if (state.verdict) {
      wf.log.info('ignoring a later verdict; the first one stands', {
        key: input.key,
        first: `${state.verdict.status}/${state.verdict.source}`,
        later: `${verdict.status}/${verdict.source}`,
      });
      return;
    }
    state.verdict = verdict;
  });

  await wf.condition(() => state.verdict !== null);
  const verdict = state.verdict as unknown as FindingVerdict;

  if (verdict.source === 'cli') {
    state.status = 'writing';
    const written = await writing.writeFindingVerdict({
      repo: input.repo,
      site: input.site,
      key: input.key,
      findingPath: input.findingPath,
      indexPath: input.indexPath,
      status: verdict.status,
      reason: verdict.reason,
      at: verdict.at,
      source: verdict.source,
    });
    state.commitSha = written.commitSha;
  }

  state.status = 'done';
  return { site: input.site, key: input.key, verdict, commitSha: state.commitSha };
}
