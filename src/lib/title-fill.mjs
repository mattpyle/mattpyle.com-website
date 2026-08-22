/**
 * Splits a post title into the plain part and the trailing phrase that wears the
 * hero fill (docs/projects/redesign/design-export/README.md §4).
 *
 * The design's example fills an editorial choice — "screen readers" out of
 * "Accessibility, AI, and testing with screen readers" — and no rule can read an
 * author's mind. This is the deterministic approximation, and it has two guards
 * that exist for concrete reasons:
 *
 *   1. A one- or two-letter last word ("…every single problem in") reads as a
 *      mistake when it is the only thing painted, so the phrase extends to the
 *      word before it.
 *   2. The fill span is `white-space: nowrap` — it has to be, or the painted
 *      block breaks across lines — so a long phrase would push the page
 *      sideways on a narrow screen instead of wrapping. Past FILL_MAX_CHARS the
 *      title renders with no fill at all. 14 characters is what fits inside a
 *      320px viewport at the post H1's smallest size (34px): the a11y suite's
 *      reflow row is what this number is answering to.
 */

const SHORT_WORD_CHARS = 3;
const FILL_MAX_CHARS = 14;

/**
 * @param {string} title
 * @returns {{ head: string, fill: string | null }} `fill` is null when the title
 *   takes no fill; `head` is then the whole title.
 */
export function splitTitleFill(title) {
  const words = title.trim().split(/\s+/);
  if (words.length < 2) return { head: title, fill: null };

  let take = 1;
  if (words[words.length - 1].length <= SHORT_WORD_CHARS && words.length > 2) take = 2;

  const fill = words.slice(words.length - take).join(' ');
  if (fill.length > FILL_MAX_CHARS) return { head: title, fill: null };

  return { head: words.slice(0, words.length - take).join(' '), fill };
}
