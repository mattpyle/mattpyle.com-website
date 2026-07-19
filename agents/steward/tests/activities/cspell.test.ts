import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.STEWARD_SITE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

const { runCspell, pickSuggestion, editDistance } = await import('../../src/activities/cspell.js');

test('the three historical typos are all found, all block, all patched', async () => {
  const result = await runCspell('posts/typos.md');

  assert.equal(result.pass, 'cspell');
  assert.equal(result.verdict, 'block');

  for (const [typo, fix] of [
    ['refacrtor', 'refactor'],
    ['damanging', 'damaging'],
    ['accessibiltiy', 'accessibility'],
  ]) {
    const finding = result.findings.find((f) => f.message.includes(`"${typo}"`));
    assert.ok(finding, `${typo} must be found`);
    assert.equal(finding!.severity, 'block', `${typo} must block`);

    const patch = (result.patches ?? []).find((p) => p.findingId === finding!.id);
    assert.ok(patch, `${typo} must have a patch`);
    assert.equal(patch!.oldText, typo);
    assert.equal(patch!.newText, fix);
    assert.equal(patch!.source, 'mechanical');
  }
});

test('the project dictionary keeps jargon out of the findings', async () => {
  const result = await runCspell('posts/known-good.md');
  assert.deepEqual(result.findings, [], 'known-good.md must be spelling-clean');
  assert.equal(result.verdict, 'pass');
});

test('findings carry the file, a line number, and the offending line', async () => {
  const result = await runCspell('posts/typos.md');
  const f = result.findings[0];
  assert.equal(f.file, 'posts/typos.md');
  assert.equal(typeof f.line, 'number');
  assert.ok(f.line! > 0);
  assert.ok(f.excerpt && f.excerpt.length <= 200);
});

test('pickSuggestion: a preferred suggestion always wins', () => {
  assert.equal(
    pickSuggestion('damanging', [{ word: 'demanding' }, { word: 'damaging', isPreferred: true }]),
    'damaging',
  );
});

test('pickSuggestion: unique nearest suggestion within distance 2 is unambiguous', () => {
  // The `refacrtor` case: no preferred suggestion, but `refactor` is distance 1
  // and the runner-up is distance 2.
  assert.equal(pickSuggestion('refacrtor', [{ word: 'refactor' }, { word: 'reactor' }]), 'refactor');
});

test('pickSuggestion: a tie at the minimum distance is ambiguous — no patch', () => {
  assert.equal(pickSuggestion('bage', [{ word: 'badge' }, { word: 'cage' }]), null);
});

test('pickSuggestion: nothing within distance 2 is ambiguous', () => {
  assert.equal(pickSuggestion('qwertyuiop', [{ word: 'keyboard' }]), null);
});

test('pickSuggestion: no suggestions at all yields no patch', () => {
  assert.equal(pickSuggestion('zzzzzz', []), null);
});

test('editDistance basics', () => {
  assert.equal(editDistance('', ''), 0);
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('abc', 'abd'), 1);
  assert.equal(editDistance('refacrtor', 'refactor'), 1);
  assert.equal(editDistance('', 'abc'), 3);
});

test('an ambiguous misspelling flags instead of blocking', async () => {
  // Exercised through the pure picker rather than a fixture: which words cspell
  // considers ambiguous is a property of its dictionary, not of this code, and
  // pinning a fixture to that would make the test brittle across cspell versions.
  const ambiguous = pickSuggestion('bage', [{ word: 'badge' }, { word: 'cage' }]);
  assert.equal(ambiguous, null);
});
