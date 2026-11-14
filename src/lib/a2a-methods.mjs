/**
 * The A2A endpoint's JSON-RPC methods, written once, with the short phrase each is described by.
 *
 * Four surfaces name these methods in a sentence: the endpoint description in the A2A digest
 * (scripts/generate-a2a-digest.mjs), the unknown-method error (src/lib/a2a-responder.mjs) and the
 * census legend (src/lib/activity-summary.mjs) are all built from this list. The two hand-written
 * ones, public/agents.md and the A2A line in src/pages/llms.txt.ts, are checked against it by
 * tests/change-kinds-a2a-methods.test.mjs. The description drifted twice when it was a literal.
 *
 * Its own module, with no imports, because the digest generator and the legend module are plain
 * build-time code that must not pull in the responder and the skills behind it (the CI base
 * worktree runs the generators with no `npm ci`; see tests/generator-imports.test.mjs).
 * src/lib/a2a-responder.mjs re-exports A2A_METHODS, and a test ties these names to the
 * constants the responder dispatches on.
 *
 * `phrase` is what the method is for, written to follow "<name> for ". SendMessage has none: it is
 * the method the endpoint is for, and the sentences name it bare.
 *
 * NO TOP-LEVEL SIDE EFFECTS and no imports.
 */

export const A2A_METHOD_PHRASES = Object.freeze([
  Object.freeze({ name: 'SendMessage', phrase: null }),
  Object.freeze({ name: 'GetTask', phrase: 'polling a Task' }),
  Object.freeze({ name: 'CancelTask', phrase: 'closing a consultant session' }),
]);

/** The method names, in their 1.0 spelling. */
export const A2A_METHODS = Object.freeze(A2A_METHOD_PHRASES.map((method) => method.name));

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** `3` -> `three`. @param {number} count */
export function countWord(count) {
  return COUNT_WORDS[count] ?? String(count);
}

/** `a, b and c`. @param {string[]} items */
export function joinAnd(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The endpoint description's method clause: `SendMessage; GetTask for polling a Task; ...`. */
export function methodsClause() {
  return A2A_METHOD_PHRASES.map(({ name, phrase }) => (phrase ? `${name} for ${phrase}` : name)).join('; ');
}

/** The unknown-method error's method list: `"A", "B" for polling a Task, and "C" for ...`. */
export function methodsQuoted() {
  const items = A2A_METHOD_PHRASES.map(({ name, phrase }) => (phrase ? `"${name}" for ${phrase}` : `"${name}"`));
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** The legend's subject: `SendMessage, GetTask and CancelTask`. */
export function methodsPlain() {
  return joinAnd([...A2A_METHODS]);
}
