import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * `steward report` with nothing in the archive.
 *
 * The old message said "run `steward review <slug>` first" whatever the file
 * was. `review` is gate mode and refuses anything without `draft: true`, so on a
 * published post that instruction cannot work — you follow it, get a second
 * refusal, and have to already know `audit` exists. These pin the three states
 * apart, including `missing`, which used to be silently advised as if it were a
 * published post.
 *
 * `SITE_DIR` is resolved from the environment when `config.ts` is first
 * imported, so the fixture root has to exist and be set before the module graph
 * loads.
 */

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-report-'));
process.env.STEWARD_SITE_DIR = ROOT;

const { describeMissingReport, readPostState } = await import('../../src/lib/read-report.js');

const WRITING = path.join(ROOT, 'src', 'content', 'writing');

before(async () => {
  await fs.mkdir(WRITING, { recursive: true });
  await fs.writeFile(
    path.join(WRITING, 'a-draft.md'),
    '---\ntitle: "A draft"\ndraft: true\n---\n\nBody.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(WRITING, 'published.md'),
    '---\ntitle: "Published"\ndraft: false\n---\n\nBody.\n',
    'utf8',
  );
  // `draft` omitted entirely, which the writing schema allows and which means
  // published — the state a `draft === true` test would get right by accident.
  await fs.writeFile(
    path.join(WRITING, 'no-draft-key.md'),
    '---\ntitle: "No draft key"\n---\n\nBody.\n',
    'utf8',
  );
});

after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

test('the three states are read off the file, not guessed', async () => {
  assert.equal(await readPostState('writing', 'a-draft'), 'draft');
  assert.equal(await readPostState('writing', 'published'), 'published');
  assert.equal(await readPostState('writing', 'no-draft-key'), 'published');
  assert.equal(await readPostState('writing', 'never-existed'), 'missing');
});

test('a published post is sent to `audit`, never to the verb that refuses it', async () => {
  const message = describeMissingReport('writing', 'published', 'published');
  assert.match(message, /steward audit writing published/);
  // The whole defect: `review` must not be the instruction here.
  assert.doesNotMatch(message, /run `steward review/);
  // …but the distinction is stated, so the reader learns why rather than just
  // being handed a different command.
  assert.match(message, /gate mode/);
  assert.match(message, /draft: true/);
});

test('a draft is sent to `review`, with `audit` named for after it publishes', async () => {
  const message = describeMissingReport('writing', 'a-draft', 'draft');
  assert.match(message, /steward review a-draft/);
  assert.match(message, /steward audit writing a-draft/);
});

test('a slug with no post says so, rather than advising a command for a file that is not there', async () => {
  const message = describeMissingReport('changelog', 'typo-slug', 'missing');
  assert.match(message, /no post at/);
  assert.match(message, /src[\\/]content[\\/]changelog[\\/]typo-slug\.md/);
  // The two-shapes-for-one-concept trap, named where it bites: `report` takes
  // the collection as a flag while `audit` takes it positionally.
  assert.match(message, /--collection/);
});

test('every state explains that `score` archives somewhere else', async () => {
  // A piece can have been scored by the study and still have no report, which
  // looks exactly like a broken archive.
  for (const state of ['draft', 'published'] as const) {
    const message = describeMissingReport('writing', 'a-draft', state);
    assert.match(message, /_study/, state);
    assert.match(message, /reviews\/<collection>\/<slug>\//, state);
  }
});
