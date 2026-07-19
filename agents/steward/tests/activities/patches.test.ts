import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Patches are applied under SITE_DIR, and this test writes real files — so it
// gets a throwaway site root of its own rather than the shared fixtures dir.
const siteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-patches-'));
process.env.STEWARD_SITE_DIR = siteDir;

const { applyOne, countOccurrences, applyPatchesActivity } = await import(
  '../../src/activities/patches.js'
);
const { sha256 } = await import('../../src/activities/snapshot.js');
import type { PatchProposal, ReviewReport } from '../../src/lib/report.js';

const REL = 'src/content/writing/fixture.md';

function patch(overrides: Partial<PatchProposal> = {}): PatchProposal {
  return {
    id: 'patch-1',
    findingId: 'cspell-1',
    file: REL,
    oldText: 'damanging',
    newText: 'damaging',
    rationale: 'typo',
    source: 'mechanical',
    ...overrides,
  };
}

function report(patches: PatchProposal[]): ReviewReport {
  return {
    schemaVersion: 1,
    slug: 'fixture',
    file: REL,
    contentSha256: 'a'.repeat(64),
    reviewedAt: new Date().toISOString(),
    workflowId: 'wf',
    runId: 'run',
    passes: [],
    patches,
    overall: 'block',
    summary: 's',
    human: {},
    publish: {},
  };
}

async function writePost(content: string): Promise<void> {
  const abs = path.join(siteDir, REL);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function readPost(): Promise<string> {
  return fs.readFile(path.join(siteDir, REL), 'utf8');
}

// ---------------------------------------------------------------------------
// Exact-match uniqueness — the safety property of the whole patch format.
// ---------------------------------------------------------------------------

test('1 match: applied', () => {
  const out = applyOne('a damanging result', patch());
  assert.equal(out, 'a damaging result');
});

test('0 matches: loud failure, never a no-op', () => {
  assert.throws(
    () => applyOne('nothing to see here', patch()),
    /was not found/,
  );
});

test('0 matches: the error points at the likely cause (file changed since review)', () => {
  assert.throws(() => applyOne('nothing here', patch()), /changed since the review/);
});

test('2+ matches: loud failure, refuses to guess which site to edit', () => {
  assert.throws(
    () => applyOne('damanging and damanging again', patch()),
    /occurs 2 times/,
  );
});

test('2+ matches: the error says it is refusing rather than picking one', () => {
  assert.throws(() => applyOne('x damanging y damanging z', patch()), /Refusing to guess/);
});

test('countOccurrences counts non-overlapping matches', () => {
  assert.equal(countOccurrences('aaa', 'a'), 3);
  assert.equal(countOccurrences('aaaa', 'aa'), 2); // non-overlapping
  assert.equal(countOccurrences('abc', 'z'), 0);
  assert.equal(countOccurrences('abc', ''), 0);
});

test('replacement is literal — $& in newText is inserted, not treated as a backreference', () => {
  // String.replace(str, str) expands `$&` to the matched text, so a naive
  // implementation turns this into "AXB". Regression test for a real bug.
  const out = applyOne('cost is X', patch({ oldText: 'X', newText: 'A$&B' }));
  assert.equal(out, 'cost is A$&B');
});

test('replacement is literal — $` and $\' and $1 are inserted verbatim too', () => {
  assert.equal(applyOne('a X b', patch({ oldText: 'X', newText: "$`" })), "a $` b");
  assert.equal(applyOne('a X b', patch({ oldText: 'X', newText: "$'" })), "a $' b");
  assert.equal(applyOne('a X b', patch({ oldText: 'X', newText: '$1' })), 'a $1 b');
});

// ---------------------------------------------------------------------------
// The activity: selection, atomicity, and the resulting hash.
// ---------------------------------------------------------------------------

test('applies only the patches the human selected, by ID', async () => {
  await writePost('one damanging two refacrtor three');
  const patches = [
    patch({ id: 'patch-1', oldText: 'damanging', newText: 'damaging' }),
    patch({ id: 'patch-2', oldText: 'refacrtor', newText: 'refactor' }),
  ];

  const result = await applyPatchesActivity({ report: report(patches), patchIds: ['patch-2'] });

  assert.deepEqual(result.applied, ['patch-2']);
  // patch-1 was NOT selected, so its typo must survive untouched.
  assert.equal(await readPost(), 'one damanging two refactor three');
});

test('applies several selected patches in one pass', async () => {
  await writePost('one damanging two refacrtor three');
  const patches = [
    patch({ id: 'patch-1', oldText: 'damanging', newText: 'damaging' }),
    patch({ id: 'patch-2', oldText: 'refacrtor', newText: 'refactor' }),
  ];

  await applyPatchesActivity({ report: report(patches), patchIds: ['patch-1', 'patch-2'] });
  assert.equal(await readPost(), 'one damaging two refactor three');
});

test('returns a hash computed identically to snapshotDraft, so the stale check agrees', async () => {
  await writePost('a damanging result');
  const result = await applyPatchesActivity({
    report: report([patch()]),
    patchIds: ['patch-1'],
  });

  const onDisk = await fs.readFile(path.join(siteDir, REL));
  assert.equal(result.contentSha256, sha256(onDisk));
});

test('the hash actually changes — this is what makes the review stale', async () => {
  await writePost('a damanging result');
  const before = sha256(await fs.readFile(path.join(siteDir, REL)));
  const result = await applyPatchesActivity({ report: report([patch()]), patchIds: ['patch-1'] });
  assert.notEqual(result.contentSha256, before);
});

test('a failing patch writes nothing — the set is all-or-nothing', async () => {
  const original = 'one damanging two';
  await writePost(original);
  const patches = [
    patch({ id: 'patch-1', oldText: 'damanging', newText: 'damaging' }),
    patch({ id: 'patch-2', oldText: 'not-in-the-file', newText: 'x' }),
  ];

  await assert.rejects(
    applyPatchesActivity({ report: report(patches), patchIds: ['patch-1', 'patch-2'] }),
    /was not found/,
  );

  // patch-1 would have succeeded on its own. The file must be untouched anyway,
  // or a half-applied set leaves the post matching neither hash.
  assert.equal(await readPost(), original);
});

test('an unknown patch ID fails and lists what is available', async () => {
  await writePost('a damanging result');
  await assert.rejects(
    applyPatchesActivity({ report: report([patch()]), patchIds: ['patch-99'] }),
    /No patch "patch-99".*Available: patch-1/s,
  );
});

test('an empty selection is refused rather than treated as "apply all"', async () => {
  await writePost('a damanging result');
  await assert.rejects(
    applyPatchesActivity({ report: report([patch()]), patchIds: [] }),
    /No patch IDs were given/,
  );
});

test('patches spanning multiple files are refused', async () => {
  await writePost('a damanging result');
  const patches = [
    patch({ id: 'patch-1' }),
    patch({ id: 'patch-2', file: 'src/content/writing/other.md', oldText: 'x', newText: 'y' }),
  ];
  await assert.rejects(
    applyPatchesActivity({ report: report(patches), patchIds: ['patch-1', 'patch-2'] }),
    /span multiple files/,
  );
});
