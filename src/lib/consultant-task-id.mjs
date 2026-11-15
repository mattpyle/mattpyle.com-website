/**
 * The one rule for what counts as a Steward session's workflow id and a turn's task id, and the
 * names the site calls the model's workflow by. "The consultant" is that workflow's name in the
 * code (agents/consultant/).
 *
 * The session id is minted here, by this site, never taken from a caller: `a2a-consultant-` and a
 * random UUID. The pattern is the whole UUID, so a caller's string that does not match never
 * reaches Temporal. Same role as src/lib/audit-task-id.mjs for the audit skill.
 *
 * | Id | What it is |
 * |---|---|
 * | `a2a-consultant-<uuid>` | The session: its Temporal workflow id, and the A2A `contextId` of every response. |
 * | `a2a-consultant-<uuid>-t<N>` | The task for turn N of that session. |
 *
 * Until 2026-11-15 a session was one task, and its task id was the bare session id. A bare id is
 * still accepted wherever a task id is, and stands for the session's latest turn.
 *
 * The three names are hand-copied from `agents/consultant/src/names.ts` and `config.ts`, because the
 * site imports nothing from that package (it would pull the harness into the function bundle).
 * tests/a2a-consultant-skill.test.mjs reads both files and holds the copies equal.
 *
 * Pure, with no imports, so the census in src/lib/agent-hits.mjs and the router can load it.
 */

/** The workflow type a session is started by. `AGENT_NAME` in agents/consultant/src/names.ts. */
export const CONSULTANT_WORKFLOW_TYPE = 'AuditConsultant';

/** The consultant worker's queue. `DEFAULT_TASK_QUEUE` in agents/consultant/src/config.ts. */
export const CONSULTANT_TASK_QUEUE = 'audit-consultant';

/** The consultant's caps-and-counts Query. `SESSION_QUERY` in agents/consultant/src/names.ts. */
export const CONSULTANT_SESSION_QUERY = 'consultant_session';

export const CONSULTANT_ID_PREFIX = 'a2a-consultant-';

const TASK_ID_PATTERN =
  /^(a2a-consultant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-t([1-9][0-9]{0,2}))?$/;

/**
 * A task id split into its session and its turn, or null for anything else. `turn` is null for a
 * bare session id.
 *
 * @returns {{ sessionId: string, turn: number | null } | null}
 */
export function parseConsultantTaskId(id) {
  const match = typeof id === 'string' ? TASK_ID_PATTERN.exec(id) : null;
  return match ? { sessionId: match[1], turn: match[2] === undefined ? null : Number(match[2]) } : null;
}

/** Whether `id` names a session's task: a turn's id, or the bare session id. */
export function isConsultantTaskId(id) {
  return parseConsultantTaskId(id) !== null;
}

/** Whether `id` is a bare session id: the workflow id, and the `contextId`. */
export function isConsultantSessionId(id) {
  return parseConsultantTaskId(id)?.turn === null;
}

/** The task id of one turn of a session. */
export function consultantTurnTaskId(sessionId, turn) {
  return `${sessionId}-t${turn}`;
}

/** @param {string} uuid a random UUID from the caller's runtime */
export function consultantTaskIdFor(uuid) {
  return `${CONSULTANT_ID_PREFIX}${String(uuid).toLowerCase()}`;
}
