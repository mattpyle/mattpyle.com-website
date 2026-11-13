/**
 * The one rule for what counts as an audit-consultant session's workflow id, and the names the
 * site calls the consultant by.
 *
 * The id is minted here, by this site, never taken from a caller: `a2a-consultant-` and a random
 * UUID. The pattern is the whole UUID, so a caller's string that does not match never reaches
 * Temporal. Same role as src/lib/audit-task-id.mjs for the audit skill.
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
  /^a2a-consultant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isConsultantTaskId(id) {
  return typeof id === 'string' && TASK_ID_PATTERN.test(id);
}

/** @param {string} uuid a random UUID from the caller's runtime */
export function consultantTaskIdFor(uuid) {
  return `${CONSULTANT_ID_PREFIX}${String(uuid).toLowerCase()}`;
}
