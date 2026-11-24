import assert from 'node:assert/strict';
import test from 'node:test';
import { scanTree } from '../scripts/check-inline-tag-wrapping.mjs';

/**
 * No source line break in an `.astro` file sits against an inline tag.
 *
 * `compressHTML` drops whitespace that holds a newline at an element boundary, so a line that ends
 * in `</code>` with text on the next line, or ends in a word with `<code>` opening the next line,
 * renders the two words joined ("get_auditspends"). The rule and its known gap are documented in
 * scripts/check-inline-tag-wrapping.mjs; tests/check-inline-tag-wrapping.test.mjs tests the rule.
 * Fix a failure by keeping the tag and the text beside it on one source line.
 */
test('no line break in an .astro template joins a word to an inline tag', () => {
  const found = scanTree();
  const report = found.map(({ file, line, previous, current }) => `${file}:${line}\n    ${previous}\n    ${current}`);
  assert.deepEqual(report, [], `line breaks that lose their space in the built HTML:\n${report.join('\n')}`);
});
