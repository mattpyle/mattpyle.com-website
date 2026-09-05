import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { cleanupPublishedTwin, type CleanupResult } from '../../src/lib/cleanup.js';

const exec = promisify(execFile);

/**
 * `steward cleanup` against a post that travelled with more than its markdown.
 *
 * The failure this covers: before 2026-09-04 the publish commit carried one
 * file, so cleanup only ever had one twin to remove. Now the same commit
 * carries the asset folder, the `public/` files, the dictionary and the
 * regenerated `src/data/` files, and every one of them is in the incoming
 * merge's way in the author's checkout — `git pull` refuses on the first one it
 * would overwrite, which is the hero image, not the post.
 *
 * A real throwaway origin and clone, for the same reason `cleanup.test.ts` uses
 * them: the behaviour is git's.
 */

const POST = 'src/content/writing/temp-post.md';
const SLUG = 'temp-post';
const HERO = 'src/assets/writing/temp-post/hero.png';
const VIDEO = 'public/video/demo.mp4';
const DICTIONARY = 'cspell.shared.yaml';
/**
 * The generated file the publish commit regenerates.
 *
 * Its twin in the author's checkout is made by any local `npm run dev`, which
 * runs the same generator over a content tree that now holds the published post
 * — so the checkout ends up tracked-and-modified at a path the incoming merge
 * also changes, and `git pull` refuses.
 */
const PAGE_PATHS = 'src/data/page-paths.mjs';

const DRAFT = [
  '---',
  'title: "A draft"',
  'draft: true',
  'hero: ../../assets/writing/temp-post/hero.png',
  '---',
  '',
  '<Video src="/video/demo.mp4" />',
  '',
].join('\n');
const PUBLISHED = DRAFT.replace('draft: true', 'draft: false');

const HERO_BYTES = 'hero-bytes\n';
const VIDEO_BYTES = 'video-bytes\n';
const DICT_BEFORE = 'words:\n  - astro\n';
const DICT_AFTER = 'words:\n  - astro\n  - webmcp\n';
const PAGE_PATHS_BEFORE = 'export const PAGE_PATHS = [];\n';
const PAGE_PATHS_AFTER = "export const PAGE_PATHS = ['/writing/temp-post'];\n";

let base: string;
let origin: string;
let repo: string;
let reviewedSha: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function write(root: string, rel: string, body: string) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
}

/**
 * A bare origin whose tip carries the published post *and its payload*, and a
 * clone one commit behind it holding untracked twins of all of it plus the
 * locally-edited dictionary a `dict-add` left behind.
 */
async function makeFixture(): Promise<void> {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-cleanup-payload-'));
  origin = path.join(base, 'origin.git');
  repo = path.join(base, 'repo');

  const seed = path.join(base, 'seed');
  await fs.mkdir(seed, { recursive: true });
  await git(seed, 'init', '-b', 'master');
  await git(seed, 'config', 'user.email', 'test@example.com');
  await git(seed, 'config', 'user.name', 'Test');
  await write(seed, 'README.md', 'seed\n');
  await write(seed, DICTIONARY, DICT_BEFORE);
  await write(seed, PAGE_PATHS, PAGE_PATHS_BEFORE);
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'initial');
  await git(base, 'clone', '--bare', seed, origin);

  await git(base, 'clone', origin, repo);
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');

  // The publish commit, as it looks since the payload change: the post, its
  // asset, its public file, the dictionary the review's `dict-add` touched, and
  // the `src/data/` file the publish leg's generators rewrote.
  await git(seed, 'remote', 'add', 'origin', origin);
  await write(seed, POST, PUBLISHED);
  await write(seed, HERO, HERO_BYTES);
  await write(seed, VIDEO, VIDEO_BYTES);
  await write(seed, DICTIONARY, DICT_AFTER);
  await write(seed, PAGE_PATHS, PAGE_PATHS_AFTER);
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'chore(steward): publish temp-post');
  await git(seed, 'push', 'origin', 'master');

  // The author's checkout: the draft and its assets untracked, the dictionary
  // tracked and edited by `dict-add`, and `page-paths.mjs` tracked and rewritten
  // by a local `npm run dev` to the same bytes the publish committed.
  await write(repo, POST, DRAFT);
  await write(repo, HERO, HERO_BYTES);
  await write(repo, VIDEO, VIDEO_BYTES);
  await write(repo, DICTIONARY, DICT_AFTER);
  await write(repo, PAGE_PATHS, PAGE_PATHS_AFTER);
  reviewedSha = createHash('sha256').update(Buffer.from(DRAFT, 'utf8')).digest('hex');
}

function run() {
  return cleanupPublishedTwin({ repoDir: repo, relPath: POST, slug: SLUG, reviewedSha256: reviewedSha });
}

/** File contents with line endings normalised to LF. */
async function read(rel: string): Promise<string> {
  return (await fs.readFile(path.join(repo, rel), 'utf8')).replace(/\r\n/g, '\n');
}

function refusal(result: CleanupResult) {
  assert.equal(result.ok, false, 'expected a refusal');
  assert.ok(!result.ok);
  return result.refusal;
}

beforeEach(makeFixture);

after(async () => {
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
});

test('removes every untracked twin the publish carried, then fast-forwards', async () => {
  const result = await run();

  assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.deleted, true);
  assert.deepEqual(result.companionsDeleted.sort(), [HERO, VIDEO].sort());
  assert.deepEqual(result.companionsRestored.sort(), [DICTIONARY, PAGE_PATHS].sort());
  assert.equal(result.pulled, true);

  // Origin's copies are what is on disk afterwards, and nothing is left dirty.
  // Line endings are normalised because this machine checks out with
  // `core.autocrlf`, which is the checkout's business rather than cleanup's.
  assert.equal(await read(POST), PUBLISHED);
  assert.equal(await read(HERO), HERO_BYTES);
  assert.equal(await read(DICTIONARY), DICT_AFTER);
  assert.equal(await read(PAGE_PATHS), PAGE_PATHS_AFTER);
  assert.equal(await git(repo, 'status', '--porcelain'), '', 'checkout should be clean');
});

test('without the companion sweep the fast-forward would have refused', async () => {
  // The claim the sweep rests on, asserted rather than assumed: git will not
  // move past an untracked file the incoming commit also adds.
  await assert.rejects(
    () => exec('git', ['pull', '--ff-only', 'origin', 'master'], { cwd: repo }),
    /would be overwritten|local changes/i,
  );
});

test('refuses when a companion on disk differs from the published copy', async () => {
  await write(repo, HERO, 'edited-after-the-publish\n');

  const r = refusal(await run());
  assert.equal(r.guard, 'lossless');
  assert.match(r.why, /hero\.png/);
  // Nothing was touched: a refusal never half-acts.
  assert.equal(await read(POST), DRAFT);
  assert.equal(await fs.readFile(path.join(repo, HERO), 'utf8'), 'edited-after-the-publish\n');
});

test('a companion origin does not carry is left where it is', async () => {
  // A `public/` file the author added but the publish never picked up: it is not
  // in the merge's way, so cleanup has no business deleting it.
  const extra = 'public/video/unpublished.mp4';
  await write(repo, extra, 'unpublished\n');
  await write(repo, POST, DRAFT.replace('<Video src="/video/demo.mp4" />', '<Video src="/video/demo.mp4" poster="/video/unpublished.mp4" />'));
  const result = await cleanupPublishedTwin({
    repoDir: repo,
    relPath: POST,
    slug: SLUG,
    reviewedSha256: createHash('sha256')
      .update(await fs.readFile(path.join(repo, POST)))
      .digest('hex'),
  });

  assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
  assert.ok(!result.companionsDeleted.includes(extra), 'a file origin never took must survive');
  assert.equal(await fs.readFile(path.join(repo, extra), 'utf8'), 'unpublished\n');
});

test('refuses when the locally regenerated data file differs from the published copy', async () => {
  // The generated files get the same rule as every other companion: bytes that
  // match origin are dropped, bytes that do not are someone's work. A hand edit
  // to `page-paths.mjs` is unlikely, but a checkout mid-way through unrelated
  // content work regenerates it to something origin has never seen.
  await write(repo, PAGE_PATHS, "export const PAGE_PATHS = ['/writing/something-else'];\n");

  const r = refusal(await run());
  assert.equal(r.guard, 'lossless');
  assert.match(r.why, /page-paths\.mjs/);
  assert.deepEqual(r.commands[0], `git diff origin/master -- ${PAGE_PATHS}`);
  // A refusal never half-acts: the twin is still there and the edit survives.
  assert.equal(await read(POST), DRAFT);
  assert.equal(await read(PAGE_PATHS), "export const PAGE_PATHS = ['/writing/something-else'];\n");
});

test('the data files are swept even when the post twin is already gone', async () => {
  // The idempotent second run, and the reason the generated files are not
  // resolved through the payload: with no post on disk the resolver throws and
  // the payload companions are empty, but a locally regenerated `page-paths.mjs`
  // is still tracked, modified, and in the merge's way.
  await fs.rm(path.join(repo, POST));
  await fs.rm(path.join(repo, HERO));
  await fs.rm(path.join(repo, VIDEO));
  // Restored through git rather than rewritten, so the checkout's own
  // line-ending rules apply and the file is genuinely clean.
  await git(repo, 'checkout', '--', DICTIONARY);

  const result = await run();

  assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.deleted, false);
  assert.deepEqual(result.companionsRestored, [PAGE_PATHS]);
  assert.equal(await git(repo, 'status', '--porcelain'), '', 'checkout should be clean');
});
