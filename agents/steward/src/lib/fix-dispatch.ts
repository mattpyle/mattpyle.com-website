/**
 * The fix dispatcher's rules (fix-dispatch-by-surface), pure so the workflow,
 * the activities and the CLI share one reading and a unit test covers it.
 * Imports nothing: `workflows/fix-dispatch.ts` and `workflows/finding.ts`
 * load it inside the workflow sandbox.
 *
 * A fix holds a **slot** from its grant until its PR is live on production,
 * or until it ends some other way. Two fixes whose findings name a common
 * repository path never hold slots at once, so the second issue opens after
 * the first fix is live and its PR is cut from the new `master`. Fixes that
 * share no path hold slots side by side, as every fix did before.
 */

/** `dispatch/<site>`: one dispatcher per site, since one site's fixes never touch another's repository. */
export function dispatchWorkflowId(site: string): string {
  return `dispatch/${site}`;
}

/** What a `findingWorkflow` asks for: a slot for one fix attempt. */
export interface SlotRequest {
  /** The asking run's workflow ID, `finding/<site>/<key>`. The grant goes back to it. */
  workflowId: string;
  key: string;
  /** The repository paths its finding's cause names, from {@link causePaths}. */
  paths: string[];
  /** The attempt this request is for. A grant or release names it, so a stale one is told apart. */
  ticket: number;
  /** ISO 8601, the asking run's clock. */
  at: string;
}

/** A request the dispatcher holds: waiting, or granted. */
export interface SlotEntry extends SlotRequest {
  /** ISO 8601, the dispatcher's clock, once granted. */
  grantedAt?: string;
}

/** The dispatcher's whole state, and its continue-as-new input. */
export interface DispatchState {
  site: string;
  /** Granted slots, in grant order. */
  holders: SlotEntry[];
  /** Requests not yet granted, in request order. */
  waiters: SlotEntry[];
}

/** The release signal's payload. */
export interface SlotRelease {
  workflowId: string;
  ticket: number;
  /** Why, for the dispatcher's log: `live`, `closed unmerged`, `conflict`, `fix failed`, `ended`. */
  reason: string;
}

/** The grant signal's payload, sent to the asking run. */
export interface SlotGrant {
  ticket: number;
}

/**
 * The line suffix a cause may put on a path: `:81`, `:189-196`, `#L42`,
 * `#L42-L50`. Stripped before the path is judged.
 */
const LINE_SUFFIX = /(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/;

/** Segments of letters, digits, `_`, `.`, `-` and the brackets of a route file. No spaces, globs, braces or query strings. */
const PATH_SHAPE = /^[A-Za-z0-9_.[\]-]+(?:\/[A-Za-z0-9_.[\]-]+)+$/;

/**
 * The repository paths a finding's "Cause, from the source" line names: each
 * backticked token, with any line suffix stripped, that is a file path. A file
 * path has a slash, starts and ends with a segment, and either its last segment
 * has a file extension or it has two slashes or more. The second arm keeps
 * extensionless files such as `public/.well-known/mcp-server`, which a cause
 * named on 2026-10-29; a two-segment token with no extension (`text/html`,
 * `cmd/gen-docs`) reads as a MIME type or a directory and is left out. A first
 * segment with a dot that does not start with one is a host
 * (`github.com/...`), not a path. Sorted, without duplicates. No cause, or a
 * cause that names no path, is an empty list.
 *
 * A missed path costs a conflict, which the lifecycle re-cuts; an extra one
 * costs a wait behind a fix that would not have collided. Neither breaks a fix.
 */
export function causePaths(cause: string | null | undefined): string[] {
  if (!cause) return [];
  const paths = new Set<string>();
  for (const match of cause.matchAll(/`([^`]+)`/g)) {
    const token = match[1].trim().replace(LINE_SUFFIX, '');
    if (!PATH_SHAPE.test(token)) continue;
    const segments = token.split('/');
    const first = segments[0];
    if (first.includes('.') && !first.startsWith('.')) continue;
    const last = segments[segments.length - 1];
    const hasExtension = /[^.]\.[A-Za-z0-9]+$/.test(last);
    if (!hasExtension && segments.length < 3) continue;
    paths.add(token);
  }
  return [...paths].sort();
}

function shares(a: string[], b: string[]): string | null {
  for (const path of a) if (b.includes(path)) return path;
  return null;
}

/**
 * Takes a request into the state. A request with the same workflow ID and
 * ticket as an entry already held is a re-send (the asking run's periodic
 * re-request, or an activity retry): the entry stays where it is, and
 * `regrant` says whether its grant should be sent again. Any other request from
 * that workflow ID replaces its earlier entries, held or waiting, and joins the
 * end of the queue.
 */
export function applyRequest(state: DispatchState, request: SlotRequest): { regrant: boolean } {
  const same = (e: SlotEntry) => e.workflowId === request.workflowId && e.ticket === request.ticket;
  if (state.holders.some(same)) return { regrant: true };
  if (state.waiters.some(same)) return { regrant: false };
  state.holders = state.holders.filter((e) => e.workflowId !== request.workflowId);
  state.waiters = state.waiters.filter((e) => e.workflowId !== request.workflowId);
  state.waiters.push({ ...request, paths: [...new Set(request.paths)].sort() });
  return { regrant: false };
}

/**
 * Drops the entry a release names. A release for another ticket is stale (the
 * run has asked again since) and changes nothing. Returns whether it dropped one.
 */
export function applyRelease(state: DispatchState, release: Pick<SlotRelease, 'workflowId' | 'ticket'>): boolean {
  const named = (e: SlotEntry) => e.workflowId === release.workflowId && e.ticket === release.ticket;
  const before = state.holders.length + state.waiters.length;
  state.holders = state.holders.filter((e) => !named(e));
  state.waiters = state.waiters.filter((e) => !named(e));
  return state.holders.length + state.waiters.length !== before;
}

/** Drops every entry of a workflow ID that is no longer running. */
export function dropEnded(state: DispatchState, running: Set<string>): string[] {
  const ended = [...state.holders, ...state.waiters].map((e) => e.workflowId).filter((id) => !running.has(id));
  state.holders = state.holders.filter((e) => running.has(e.workflowId));
  state.waiters = state.waiters.filter((e) => running.has(e.workflowId));
  return [...new Set(ended)];
}

/**
 * What blocks a waiter: the first holder that names one of its paths, or else
 * the first earlier waiter that does. Null when nothing does, so it can be
 * granted. Earlier waiters count so that two requests on one path are granted
 * in request order, never the later one first.
 */
export function slotBlocker(state: DispatchState, workflowId: string): { key: string; path: string; held: boolean } | null {
  const index = state.waiters.findIndex((e) => e.workflowId === workflowId);
  if (index < 0) return null;
  const entry = state.waiters[index];
  for (const holder of state.holders) {
    const path = shares(entry.paths, holder.paths);
    if (path) return { key: holder.key, path, held: true };
  }
  for (const earlier of state.waiters.slice(0, index)) {
    const path = shares(entry.paths, earlier.paths);
    if (path) return { key: earlier.key, path, held: false };
  }
  return null;
}

/**
 * Moves every waiter that nothing blocks to the holders, in request order, and
 * returns them: the grants to send. A waiter with no paths is never blocked.
 */
export function planGrants(state: DispatchState, at: string): SlotEntry[] {
  const granted: SlotEntry[] = [];
  for (let i = 0; i < state.waiters.length; ) {
    const entry = state.waiters[i];
    if (slotBlocker(state, entry.workflowId)) {
      i++;
      continue;
    }
    state.waiters.splice(i, 1);
    const holder = { ...entry, grantedAt: at };
    state.holders.push(holder);
    granted.push(holder);
  }
  return granted;
}

/** One line for `steward finding status` on a run at `waiting-slot`. */
export function waitingSlotLine(state: DispatchState | null, workflowId: string, paths: string[] | undefined): string {
  const named = paths && paths.length > 0 ? paths.join(', ') : 'no path';
  if (!state) return `waiting-slot: names ${named}; the dispatcher did not answer`;
  const blocker = slotBlocker(state, workflowId);
  if (blocker) {
    return `waiting-slot: ${blocker.path}, behind ${blocker.key} (${blocker.held ? 'in flight' : 'queued first'})`;
  }
  if (state.holders.some((e) => e.workflowId === workflowId)) return `waiting-slot: granted, the run is taking it (names ${named})`;
  return `waiting-slot: names ${named}; not in the dispatcher's queue yet`;
}
