/**
 * Count words and list joining, written once for every sentence that is built from a source list.
 *
 * Used by the A2A method sentences (src/lib/a2a-methods.mjs), the skill and tool counts in the A2A
 * digest (scripts/generate-a2a-digest.mjs) and the tests under tests/change-kinds-*.test.mjs, so
 * "three" has one spelling. A2A_METHODS re-exports both from src/lib/a2a-methods.mjs.
 *
 * NO TOP-LEVEL SIDE EFFECTS and no imports: the digest generator runs with no `npm ci`
 * (tests/generator-imports.test.mjs).
 */

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** `3` -> `three`. @param {number} count */
export function countWord(count) {
  return COUNT_WORDS[count] ?? String(count);
}

/** `a, b and c`. @param {string[]} items */
export function joinAnd(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
