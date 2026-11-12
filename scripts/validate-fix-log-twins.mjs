// Build gate for the fix log's markdown twins.
//
// A twin is converted from the built page, so a change to a component or to the converter can
// quietly break what an agent reads: a table whose label row has one cell, or the rail's facts
// as four loose paragraphs. A reader of the twin gets the page's own outline and facts, and an
// entry's before and after in a form its parser can read. This checks one entry of each shape,
// the first with a measure and the first with changed text, against its own frontmatter.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEntries } from './fix-log-entries.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const entries = readEntries();
assert.ok(entries.length > 0, 'the fixes collection has entries');

function twin(entry) {
  const file = join(root, 'dist', 'client', 'fix-log', `${entry.data.slug}.md`);
  assert.ok(existsSync(file), `no twin was built for ${entry.data.slug}`);
  return readFileSync(file, 'utf8');
}

function headings(markdown) {
  return markdown.split('\n').filter((line) => /^#{1,6} /.test(line));
}

function checkShared(entry, markdown) {
  assert.deepEqual(
    headings(markdown),
    [`# ${entry.data.title}`, '## About this fix', '## What happened', '## Before and after'],
    `${entry.data.slug}: the twin's headings are not the page's outline`,
  );
  assert.match(markdown, /^-\s+fixed: \d{1,2} \w{3} \d{4}$/m, `${entry.data.slug}: the date is not a "fixed: <date>" line`);
  assert.match(markdown, /^-\s+type: .+$/m, `${entry.data.slug}: the type is not a "type: <value>" line`);
}

const withMeasure = entries.find((e) => Array.isArray(e.data.measures) && e.data.measures.length === 1);
const withText = entries.find((e) => e.data.text);
assert.ok(withMeasure, 'no entry holds a measure');
assert.ok(withText, 'no entry holds changed text');

{
  const markdown = twin(withMeasure);
  checkShared(withMeasure, markdown);
  const [m] = withMeasure.data.measures;
  const shown = (value) => (m.quoted ? `“${value}”` : value);
  const escape = (value) => value.replace(/\|/g, '\\|');
  const section = markdown.split('## Before and after')[1];
  assert.ok(section.includes(m.label), `${withMeasure.data.slug}: the label is missing from the twin`);
  const table = section.split('\n').filter((line) => line.startsWith('|'));
  assert.equal(table.length, 3, `${withMeasure.data.slug}: the measure is not a three-line table`);
  assert.equal(table[0].replace(/\s+/g, ' ').trim(), '| Before | After |');
  assert.match(table[1], /^\|\s*---\s*\|\s*---\s*\|$/);
  assert.equal(
    table[2].replace(/\s+/g, ' ').trim(),
    `| ${escape(shown(m.before))} | ${escape(shown(m.after))} |`,
    `${withMeasure.data.slug}: the values are not the entry's before and after`,
  );
}

{
  const markdown = twin(withText);
  checkShared(withText, markdown);
  const section = markdown.split('## Before and after')[1];
  assert.match(section, /^Before · .+$/m, `${withText.data.slug}: no "Before" caption`);
  assert.match(section, /^After · .+$/m, `${withText.data.slug}: no "After" caption`);
  assert.equal(section.split(/\r?\n/).some((line) => line.startsWith('| ')), false, `${withText.data.slug}: changed lines must not be a table`);
}

console.log(`validate-fix-log-twins: ${withMeasure.data.slug} (a measure) and ${withText.data.slug} (changed lines) read correctly as markdown.`);
