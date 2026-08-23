import assert from 'node:assert/strict';
import test from 'node:test';
import { findOffences, templateOf } from '../scripts/check-inline-tag-wrapping.mjs';

/** @param {string[]} lines */
const template = (lines) => lines.join('\n');

const OFFENDING_PARAGRAPH = [
  '<p>',
  '  The map of this site,',
  '  <a href="/llms.txt">llms.txt</a>, written for machines.',
  '</p>',
];

const STYLE_BLOCK = ['<style>', '  p { margin: 0 }', '</style>'];

test('a real offence is reported with the line the reader will find it on', () => {
  const found = findOffences(template(['---', 'const title = "x";', '---', '', ...OFFENDING_PARAGRAPH]));
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 7);
  assert.match(found[0].current, /llms\.txt/);
});

// The regression this file exists for. Before the fix the style mask was a plain text match, so it
// opened on the comment's mention and ran to the real block's closing tag, blanking the offence in
// between: the script reported clean on a file that had one.
test('a comment naming the style tag does not mask the offences below it', () => {
  const found = findOffences(
    template([
      '---',
      'const title = "x";',
      '---',
      '',
      '{/*',
      '  Scoped styles: the <style> block below owns this layout.',
      '*/}',
      ...OFFENDING_PARAGRAPH,
      '',
      ...STYLE_BLOCK,
    ])
  );
  assert.equal(found.length, 1);
  assert.match(found[0].current, /llms\.txt/);
});

test('an HTML comment naming the style tag masks nothing either', () => {
  const found = findOffences(
    template(['<!-- the <style> block below owns this layout -->', ...OFFENDING_PARAGRAPH, '', ...STYLE_BLOCK])
  );
  assert.equal(found.length, 1);
});

test('a real style block is still excluded, and blanking keeps every line number', () => {
  const source = template(['<p>Prose.</p>', ...STYLE_BLOCK, '<p>More prose.</p>']);
  const lines = templateOf(source).split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[1], '');
  assert.equal(lines[2], '');
  assert.equal(lines[3], '');
  assert.equal(lines[4], '<p>More prose.</p>');
});

test('a style element with an attribute is excluded too', () => {
  const blanked = templateOf(template(['<style is:global>', '  p { margin: 0 }', '</style>']));
  assert.equal(blanked.trim(), '');
});

test('prose inside a comment is not checked, because it never reaches the page', () => {
  assert.deepEqual(findOffences(template(['{/*', ...OFFENDING_PARAGRAPH, '*/}'])), []);
});
