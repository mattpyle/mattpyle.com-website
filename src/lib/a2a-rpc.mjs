/**
 * The JSON-RPC envelope this endpoint speaks, shared by both of its skills.
 *
 * Extracted from src/lib/a2a-responder.mjs when the audit skill arrived, because the two skills
 * now build errors in two files and an error shape that differs between them is a client-visible
 * inconsistency in one endpoint. Nothing here knows what a skill is; it knows what section 9.5
 * says an error looks like.
 *
 * PURE, like everything else under this endpoint: no I/O, no clock, no randomness.
 */

import { createHash } from 'node:crypto';

export const DOMAIN = 'www.mattpyle.com';

export const AGENT_CARD_URL = `https://${DOMAIN}/.well-known/agent-card.json`;

/**
 * The codes this endpoint returns.
 *
 * The first four are JSON-RPC's own. `taskNotFound` is A2A's, from the binding's error-code
 * mapping table: `TaskNotFoundError` is `-32001`. `serverError` is `-32000`, the first of the
 * implementation-defined range and outside the block A2A reserved (`-32001`..`-32009`), used for
 * the one refusal that is neither the caller's request being wrong nor the server being broken —
 * a rate limit. It is the same code /mcp answers a refused audit with, so a caller hitting the
 * shared budget from either protocol reads the same number. `taskNotCancelable` (-32002) and
 * `unsupportedOperation` (-32004) are A2A's `TaskNotCancelableError` and
 * `UnsupportedOperationError`, which the consultant skill answers a closed or busy task with.
 */
export const ERROR_CODES = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  serverError: -32000,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupportedOperation: -32004,
});

export function errorResponse(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

/** `google.rpc.ErrorInfo`, the shape section 9.5 asks `error.data`'s members to carry. */
export function errorInfo(reason, metadata) {
  return {
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: DOMAIN,
    ...(metadata ? { metadata } : {}),
  };
}

/** `google.rpc.BadRequest`, for an error that can name the field that was wrong. */
export function badRequest(violations) {
  return { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: violations };
}

/**
 * The first non-empty `text` in a Message's parts, or null.
 *
 * A 1.0 TextPart is `{ "text": "..." }`; the 0.x one was `{ "kind": "text", "text": "..." }`.
 * Reading the member directly accepts both without a discriminator branch.
 */
export function readText(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.parts)) return null;
  for (const part of message.parts) {
    if (part && typeof part === 'object' && typeof part.text === 'string' && part.text.trim() !== '') {
      return part.text;
    }
  }
  return null;
}

/**
 * The context id of a Task whose caller named none: the same value on every call for one task.
 *
 * This endpoint stores nothing between calls, so it cannot look up the id it gave a task the
 * first time. It used to mint a fresh one on every response, so one session read as six
 * conversations across six calls, and a client that groups by context saw them as unrelated.
 * A hash of the task id needs no storage and no randomness. It is shaped like a UUID because
 * that is what every other context id here looks like, and it is not a UUID of any version.
 *
 * @param {string} taskId
 * @returns {string}
 */
export function contextIdForTask(taskId) {
  const hex = createHash('sha256').update(`a2a-context:${taskId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
