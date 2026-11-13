/**
 * The one rule for what counts as an audit's workflow id.
 *
 * `auditWorkflowIdFor` in the Steward workspace writes `steward-audit-<host>-<tier>-<suffix>`.
 * Matched by its prefix rather than by the whole scheme: this guard exists so a caller who passes
 * an arbitrary string gets a plain "no such audit" instead of a Temporal lookup, and re-encoding
 * the id scheme here would be the hand-copy the deep-contract entry exists to avoid.
 *
 * Shared by `/mcp` (through `mcp-temporal.mjs`) and `/a2a` (through `a2a-audit-skill.mjs`), so the
 * two routes cannot disagree about it. Pure, with no imports, so tests load it without Temporal.
 */
const TASK_ID_PATTERN = /^steward-audit-[A-Za-z0-9.-]{1,240}$/;

export function isAuditTaskId(id) {
  return typeof id === 'string' && TASK_ID_PATTERN.test(id);
}
