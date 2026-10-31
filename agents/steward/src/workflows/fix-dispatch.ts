import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import {
  applyRelease,
  applyRequest,
  dropEnded,
  planGrants,
  type DispatchState,
  type SlotGrant,
  type SlotRelease,
  type SlotRequest,
} from '../lib/fix-dispatch.js';

/**
 * `fixDispatchWorkflow`: one execution per site, `dispatch/<site>`, on
 * `steward-findings` (fix-dispatch-by-surface). It holds the site's in-flight
 * fixes and the repository paths each one's finding names, and grants a fix
 * its slot only when no in-flight fix names one of the same paths.
 *
 * **Why it exists.** On 2026-10-29 thirteen verdicts landed in one commit and
 * thirteen fix issues opened in fifteen seconds, each PR cut from the same
 * `master`. Two pairs edited the same file and conflicted once a sibling
 * merged. Serialising every fix would cost a day per fifteen; serialising only
 * the fixes that name a common path costs nothing for the rest.
 *
 * **The protocol.**
 *
 * 1. A `findingWorkflow` asks through the `requestFixSlot` activity, which
 *    signals with start (determinism rule 11: a long-lived workflow is started
 *    through the worker's client, not as a child). The first request of a
 *    site starts this run.
 * 2. This run grants by signalling the asking run's `slot-grant` with the
 *    request's ticket, in request order per path ({@link planGrants}).
 * 3. The asking run signals `slot-release` on every exit from its fix loop:
 *    live on production, PR closed unmerged, a conflict, a failed fix, a
 *    timeout, or the run ending. A release names its ticket, so a stale one
 *    never drops a newer request.
 * 4. A holder that ends without releasing (terminated, or a bug) is abandoned.
 *    Each hour with anything held, `runningWorkflowIds` asks the server which
 *    holders and waiters still run, and the rest are dropped. A grant whose
 *    signal fails, because the run has ended, is dropped the same way.
 *
 * **Small state, short history.** The state is the two lists and nothing
 * else. Each request, release and grant is one event or two, so the run
 * continues as new when the server suggests it, or past {@link HISTORY_CAP}
 * events, carrying the lists. With
 * nothing held or waiting for a day it completes; the next request starts a
 * fresh run.
 *
 * **Replay.** A new workflow type, so no earlier history has it. Its signals'
 * payloads are the request and the release; nothing reads config.
 */

const QUEUE_FINDINGS = 'steward-findings';

/** How long an empty dispatcher waits for a request before it completes. */
const IDLE_CLOSE = '24 hours';

/** How often a dispatcher with entries checks that their runs still run. */
const SWEEP_EVERY = '1 hour';

/**
 * The history length at which the run continues as new even if the server has
 * not suggested it yet. A request, a grant and a release are about ten events
 * together, so this is a couple of hundred fixes.
 */
const HISTORY_CAP = 2000;

export interface FixDispatchInput {
  site: string;
  /** Carried across continue-as-new. Absent on a fresh start. */
  holders?: DispatchState['holders'];
  waiters?: DispatchState['waiters'];
}

export interface FixDispatchResult {
  site: string;
  /** How many grants this run sent, for the Web UI. */
  granted: number;
}

export const requestSlotSignal = wf.defineSignal<[SlotRequest]>('slot-request');
export const releaseSlotSignal = wf.defineSignal<[SlotRelease]>('slot-release');
/** Sent by the dispatcher to the asking `findingWorkflow`. */
export const slotGrantSignal = wf.defineSignal<[SlotGrant]>('slot-grant');
export const dispatchStateQuery = wf.defineQuery<DispatchState>('dispatch-state');

// The sweep: one short read of each run's status through the worker's client.
const sweeping = wf.proxyActivities<Pick<typeof activities, 'runningWorkflowIds'>>({
  taskQueue: QUEUE_FINDINGS,
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3, initialInterval: '10 seconds' },
});

function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

export async function fixDispatchWorkflow(input: FixDispatchInput): Promise<FixDispatchResult> {
  const state: DispatchState = { site: input.site, holders: input.holders ?? [], waiters: input.waiters ?? [] };
  let dirty = true;
  let granted = 0;
  const regrants: SlotRequest[] = [];

  wf.setHandler(dispatchStateQuery, () => state);
  wf.setHandler(requestSlotSignal, (request) => {
    if (!request || typeof request.workflowId !== 'string' || typeof request.ticket !== 'number' || !Array.isArray(request.paths)) {
      wf.log.warn('ignoring a malformed slot request', { site: input.site });
      return;
    }
    const { regrant } = applyRequest(state, request);
    if (regrant) regrants.push(request);
    dirty = true;
  });
  wf.setHandler(releaseSlotSignal, (release) => {
    if (!release || typeof release.workflowId !== 'string') return;
    if (applyRelease(state, release)) {
      wf.log.info('slot released', { workflowId: release.workflowId, ticket: release.ticket, reason: release.reason });
    }
    dirty = true;
  });

  const grant = async (workflowId: string, ticket: number): Promise<boolean> => {
    try {
      await wf.getExternalWorkflowHandle(workflowId).signal(slotGrantSignal, { ticket });
      return true;
    } catch (err) {
      // The run has ended: its slot is abandoned.
      wf.log.warn('a grant could not be delivered; dropping the run', {
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
      state.holders = state.holders.filter((e) => e.workflowId !== workflowId);
      state.waiters = state.waiters.filter((e) => e.workflowId !== workflowId);
      return false;
    }
  };

  for (;;) {
    const empty = () => state.holders.length === 0 && state.waiters.length === 0;
    const woke = await wf.condition(() => dirty, empty() ? IDLE_CLOSE : SWEEP_EVERY);
    if (!woke) {
      if (empty()) return { site: input.site, granted };
      const ids = [...new Set([...state.holders, ...state.waiters].map((e) => e.workflowId))];
      const running = new Set(await sweeping.runningWorkflowIds(ids));
      const ended = dropEnded(state, running);
      if (ended.length > 0) wf.log.warn('dropped slots of runs that ended without a release', { ended });
      dirty = true;
      continue;
    }
    dirty = false;

    for (const request of regrants.splice(0)) {
      if (state.holders.some((e) => e.workflowId === request.workflowId && e.ticket === request.ticket)) {
        await grant(request.workflowId, request.ticket);
      }
    }
    for (const entry of planGrants(state, nowIso())) {
      if (await grant(entry.workflowId, entry.ticket)) granted++;
      else dirty = true;
    }

    const info = wf.workflowInfo();
    if (!dirty && (info.continueAsNewSuggested || info.historyLength > HISTORY_CAP)) {
      await wf.continueAsNew<typeof fixDispatchWorkflow>({ site: input.site, holders: state.holders, waiters: state.waiters });
    }
  }
}
