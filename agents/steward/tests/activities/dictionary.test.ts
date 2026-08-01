import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A byte-for-byte copy of the real `cspell.shared.yaml`, not a fixture: these
// tests exist to prove the curated sections, the attribution comments and the
// checkout's line endings in the *real* file survive an `addWord`, so a
// hand-written stand-in would prove nothing. What the copy buys is isolation.
//
// `node --test` runs test files in parallel processes. Writing the real file
// here raced `cspell.test.ts` reading it, and the reader caught it mid-write
// with an empty wordlist — `runCspell`'s own guard then threw "The shared
// dictionary loaded with no words" on a branch touching neither file (card:
// cspell-test-isolation-flake). Nothing under test writes the repo's real
// dictionary any more.
//
// Set before importing config, same as scorecard-archive.test.ts: CSPELL_CONFIG
// is resolved once, at module evaluation.
const REAL_CSPELL_CONFIG = fileURLToPath(new URL('../../../../cspell.shared.yaml', import.meta.url));
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-dictionary-'));
const tmpConfig = path.join(tmpDir, 'cspell.shared.yaml');
await fs.copyFile(REAL_CSPELL_CONFIG, tmpConfig);
process.env.STEWARD_CSPELL_CONFIG = tmpConfig;

const { CSPELL_CONFIG } = await import('../../src/config.js');
const { addWord } = await import('../../src/lib/dictionary.js');

// Belt and braces: if the override ever stops being read, the tests below would
// silently go back to writing the repo's real dictionary. Fail loudly instead.
assert.equal(CSPELL_CONFIG, tmpConfig, 'STEWARD_CSPELL_CONFIG was not honoured');

let original: string;

test.before(async () => {
  original = await fs.readFile(CSPELL_CONFIG, 'utf8');
});

test.afterEach(async () => {
  await fs.writeFile(CSPELL_CONFIG, original, 'utf8');
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
  // one-word change in a whole-file diff. `copyFile` is byte-for-byte, so the
  // temp copy carries the checkout's real line-ending style into this test.
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
  // `runCspell` reads CSPELL_CONFIG too, so it reads the temp copy — the point
  // of this test is that the file this suite just wrote is still loadable.
  const result = await runCspell('src/content/writing/accessibility-and-ai.md');
  assert.equal(result.findings.length, 0, 'the published post is still clean after a dict-add');
});
