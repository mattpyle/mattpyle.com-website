/**
 * Splits a sentence on its backticked terms, for the check descriptions on /steward and /audit.
 *
 * Returns SEGMENTS, not markup. The template writes the `<code>` itself, which is what lets an
 * Astro scoped style reach it — an element injected with set:html carries no scope attribute — and
 * every segment still renders as text, so a `<` or an `&` inside one is escaped as before.
 *
 * NO TOP-LEVEL SIDE EFFECTS — this is imported at build time.
 */

/**
 * @typedef {{ text: string, code: boolean }} InlineSegment
 */

// A code span is a PAIR: a backtick, at least one character that is not a backtick, a backtick.
// An unmatched backtick and an empty pair match nothing, so they stay literal text.
const CODE_SPAN_PATTERN = /`([^`]+)`/g;

/**
 * Split text into plain and code segments, in order, with no empty segments.
 *
 * @param {string} text
 * @returns {InlineSegment[]}
 */
export function splitInlineCode(text) {
  /** @type {InlineSegment[]} */
  const segments = [];
  let cursor = 0;

  for (const match of text.matchAll(CODE_SPAN_PATTERN)) {
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), code: false });
    segments.push({ text: match[1], code: true });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), code: false });
  return segments;
}
