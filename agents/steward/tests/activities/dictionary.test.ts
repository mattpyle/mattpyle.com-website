import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { CSPELL_CONFIG } from '../../src/config.js';
import { addWord } from '../../src/lib/dictionary.js';

// The real config file is edited and restored. It is the thing under test —
// `addWord` writes to CSPELL_CONFIG by design, and a fixture copy would not
// prove that the curated sections in the real file survive.
let original: string;

test.before(async () => {
  original = await fs.readFile(CSPELL_CONFIG, 'utf8');
});

test.afterEach(async () => {
  await fs.writeFile(CSPELL_CONFIG, original, 'utf8');
});

test('a new word is appended and reported as added', async () => {
  const result = await addWord('Zzyzx');
  assert.equal(result.added, true);
  const after = await fs.readFile(CSPELL_CONFIG, 'utf8');
  assert.match(after, /^ {2}- Zzyzx$/m);
});

test('the curated sections and their attributions survive', async () => {
  await addWord('Zzyzx');
  const after = await fs.readFile(CSPELL_CONFIG, 'utf8');
  // A global re-sort would scatter these groups and orphan every attribution
  // comment from the word it explains. That is the failure this guards.
  assert.match(after, /# --- Standards, protocols, acronyms ---/);
  assert.match(after, /# --- en-GB collateral[\s\S]*?- testbed[\s\S]*?- anymore/);
  assert.match(after, /deliberate allowance of the American one-word form/);
});

test('a duplicate is a no-op, case-insensitively', async () => {
  const first = await addWord('Zzyzx');
  assert.equal(first.added, true);
  const second = await addWord('zzyzx');
  assert.equal(second.added, false, 'case-insensitive, matching how cspell reads the list');

  const after = await fs.readFile(CSPELL_CONFIG, 'utf8');
  assert.equal((after.match(/^ {2}- [Zz]zyzx$/gm) ?? []).length, 1);
});

test('an existing curated word is recognised as already present', async () => {
  const result = await addWord('Astro');
  assert.equal(result.added, false);
});

test('the machine-added section stays sorted', async () => {
  await addWord('Mango');
  await addWord('Apple');
  await addWord('Zebra');
  const after = await fs.readFile(CSPELL_CONFIG, 'utf8');
  const section = after.slice(after.indexOf('Added via'));
  const words = [...section.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]);

  // Asserted as "sorted and contains the new words", not as an exact list: the
  // section holds whatever has genuinely been dict-added (`Kimi`, as of the
  // Prompt 3c round trip), and pinning the exact contents would make this test
  // fail every time someone legitimately uses the verb.
  for (const w of ['Apple', 'Mango', 'Zebra']) assert.ok(words.includes(w), `${w} was added`);
  assert.deepEqual(
    words,
    [...words].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    'the machine-added section is sorted',
  );
});

test('existing line endings are preserved', async () => {
  // On a CRLF checkout, joining with '\n' would rewrite every line and bury the
  // one-word change in a whole-file diff.
  const crlf = original.includes('\r\n');
  await addWord('Zzyzx');
  const after = await fs.readFile(CSPELL_CONFIG, 'utf8');
  assert.equal(after.includes('\r\n'), crlf, 'line-ending style is unchanged');
});

test('a multi-word argument is refused rather than silently mangled', async () => {
  await assert.rejects(() => addWord('any more'), /not a single word/);
});

test('the file stays valid for cspell after a write', async () => {
  await addWord('Zzyzx');
  const { runCspell } = await import('../../src/activities/cspell.js');
  // If the write broke the YAML, loadSettings throws on an empty dictionary.
  const result = await runCspell('src/content/writing/i-turned-on-a-screen-reader.md');
  assert.equal(result.findings.length, 0, 'the published post is still clean after a dict-add');
});
