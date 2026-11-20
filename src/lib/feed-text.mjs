/**
 * Escapes a plain-text value for an RSS `<description>`. A feed reader parses a description as
 * HTML and a title as text, so a description is escaped here and a title is not.
 * rss() then escapes every field for XML: a source `&` is served as `&amp;amp;`, and that is correct.
 *
 * Apply it once, to plain text only. A second pass shows the reader a literal `&amp;`.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
