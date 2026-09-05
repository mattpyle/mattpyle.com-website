import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { writeAndStagePayload } from '../../src/activities/publish.js';
import { resolvePostPayload } from '../../src/lib/post-payload.js';

const exec = promisify(execFile);

/**
 * The publish leg's git half: which paths a publish actually stages.
 *
 * `publish.test.ts` covers the pure frontmatter surgery, and the live dry-run
 * covers the REST calls and the push. The staged set sits between the two and
 * used to be provable only by reading a real PR's file list — which is how a
 * publish shipped a post whose hero image existed on one laptop. A throwaway
 * repo answers it in milliseconds.
 */

let site: string;
let worktree: string;
const POST = 'src/content/writing/staged-post.md';

async function git(cwd: string, ...args: string[]) {
  await exec('git', args, { cwd });
}

async function write(root: string, rel: string, body: string) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
}

/** Paths git holds in the index, as `git commit` would see them. */
async function stagedInIndex(repo: string): Promise<string[]> {
  const { stdout } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: repo });
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
}

const DRAFT = [
  '---',
  'title: "A staged post"',
  'draft: true',
  'date: 2026-09-04',
  'hero: ../../assets/writing/staged-post/hero.png',
  '---',
  '',
  '<Video src="/video/demo.mp4" poster="/video/demo-poster.jpg" />',
  '',
].join('\n');

const PUBLISHED = DRAFT.replace('draft: true', 'draft: false');

before(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-stage-'));
  site = path.join(base, 'site');
  worktree = path.join(base, 'worktree');

  // The author's checkout: the draft and its assets are untracked, the
  // dictionary is tracked and locally edited.
  await fs.mkdir(site, { recursive: true });
  await git(site, 'init', '-b', 'main');
  await git(site, 'config', 'user.email', 'test@example.com');
  await git(site, 'config', 'user.name', 'Test');
  await write(site, 'cspell.shared.yaml', 'words:\n  - astro\n');
  await git(site, 'add', '.');
  await git(site, 'commit', '-m', 'initial');

  await write(site, POST, DRAFT);
  await write(site, 'src/assets/writing/staged-post/hero.png', 'hero-bytes');
  await write(site, 'public/video/demo.mp4', 'video-bytes');
  await write(site, 'public/video/demo-poster.jpg', 'poster-bytes');
  await write(site, 'cspell.shared.yaml', 'words:\n  - astro\n  - webmcp\n');

  // Steward's worktree: a separate repo standing in for one cut from
  // origin/master, which has never seen any of the above.
  await fs.mkdir(worktree, { recursive: true });
  await git(worktree, 'init', '-b', 'main');
  await git(worktree, 'config', 'user.email', 'test@example.com');
  await git(worktree, 'config', 'user.name', 'Test');
  await write(worktree, 'cspell.shared.yaml', 'words:\n  - astro\n');
  await git(worktree, 'add', '.');
  await git(worktree, 'commit', '-m', 'base');
});

after(async () => {
  await fs.rm(path.dirname(site), { recursive: true, force: true }).catch(() => {});
});

describe('writeAndStagePayload', () => {
  test('stages the post, its assets, its public files and the dictionary', async () => {
    const payload = await resolvePostPayload(site, POST, { compareRef: 'HEAD' });
    const staged = await writeAndStagePayload({
      siteDir: site,
      worktreeDir: worktree,
      payload,
      postContent: PUBLISHED,
    });

    assert.deepEqual(staged.sort(), [
      'cspell.shared.yaml',
      'public/video/demo-poster.jpg',
      'public/video/demo.mp4',
      'src/assets/writing/staged-post/hero.png',
      POST,
    ].sort());
    assert.deepEqual(await stagedInIndex(worktree), staged.sort());
  });

  test('the post is written flipped and everything else byte-for-byte', async () => {
    assert.match(await fs.readFile(path.join(worktree, POST), 'utf8'), /draft: false/);
    assert.equal(
      await fs.readFile(path.join(worktree, 'src/assets/writing/staged-post/hero.png'), 'utf8'),
      'hero-bytes',
    );
    assert.equal(
      await fs.readFile(path.join(worktree, 'cspell.shared.yaml'), 'utf8'),
      'words:\n  - astro\n  - webmcp\n',
    );
  });

  test('a second run over the same commit reports nothing to stage', async () => {
    // The idempotent path: a re-approve after a park has to find "nothing to
    // commit" for the whole payload, not only for the markdown.
    await git(worktree, 'commit', '-m', 'chore(steward): publish staged-post');

    const payload = await resolvePostPayload(site, POST, { compareRef: 'HEAD' });
    const staged = await writeAndStagePayload({
      siteDir: site,
      worktreeDir: worktree,
      payload,
      postContent: PUBLISHED,
    });

    assert.deepEqual(staged, []);
  });

  test('an asset changed since the last publish is staged on its own', async () => {
    // The case the old one-file check missed entirely: the markdown is
    // identical, so a post-only `status --porcelain` reports clean and the
    // publish commits nothing while the image on disk has changed.
    await write(site, 'src/assets/writing/staged-post/hero.png', 'new-hero-bytes');

    const payload = await resolvePostPayload(site, POST, { compareRef: 'HEAD' });
    const staged = await writeAndStagePayload({
      siteDir: site,
      worktreeDir: worktree,
      payload,
      postContent: PUBLISHED,
    });

    assert.deepEqual(staged, ['src/assets/writing/staged-post/hero.png']);
  });
});
