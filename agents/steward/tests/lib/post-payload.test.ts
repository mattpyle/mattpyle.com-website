import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  MissingReferenceError,
  describePayload,
  resolvePostPayload,
} from '../../src/lib/post-payload.js';

const exec = promisify(execFile);

/**
 * The resolver, against a throwaway git repo shaped like the real one.
 *
 * A real repo rather than mocks for the same reason `worktree.test.ts` uses
 * one: the dictionary group's answer comes from `git hash-object` against a
 * ref, and a mocked git would only assert that we call the command we already
 * decided to call.
 */

let repo: string;
const POST = 'src/content/writing/post-with-assets.md';

async function git(cwd: string, ...args: string[]) {
  await exec('git', args, { cwd });
}

async function write(rel: string, body: string) {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
}

before(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-payload-'));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await write('cspell.shared.yaml', 'words:\n  - astro\n');
  await write('README.md', 'repo\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');

  // The draft and everything it needs, all untracked — the state a real draft
  // is in when Steward reviews it.
  await write(
    POST,
    [
      '---',
      'title: "A post with assets"',
      'draft: true',
      'hero: ../../assets/writing/post-with-assets/hero.png',
      'heroAlt: "a hero"',
      '---',
      '',
      'A link to [the webmcp page](/webmcp/) that is not a file.',
      '',
      '![a body image](../../assets/writing/post-with-assets/body.png)',
      '',
      '![one from public](/images/from-public.png)',
      '',
      '<Video src="/video/demo.mp4" poster="/video/demo-poster.jpg" width={100} height={50} />',
      '',
    ].join('\n'),
  );
  await write('src/assets/writing/post-with-assets/hero.png', 'hero-bytes');
  await write('src/assets/writing/post-with-assets/body.png', 'body-bytes');
  // In the folder but named by nothing: it still travels, because the folder is
  // the post's own and the build may reach it from anywhere.
  await write('src/assets/writing/post-with-assets/unreferenced.png', 'spare-bytes');
  await write('public/video/demo.mp4', 'video-bytes');
  await write('public/video/demo-poster.jpg', 'poster-bytes');
  await write('public/images/from-public.png', 'public-image-bytes');
});

after(async () => {
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

describe('resolvePostPayload', () => {
  test('names the post, its asset folder and the public files it references', async () => {
    const payload = await resolvePostPayload(repo, POST, { compareRef: 'HEAD' });

    assert.equal(payload.post, POST);
    assert.deepEqual(payload.assets, [
      'src/assets/writing/post-with-assets/body.png',
      'src/assets/writing/post-with-assets/hero.png',
      'src/assets/writing/post-with-assets/unreferenced.png',
    ]);
    assert.deepEqual(payload.publicFiles, [
      'public/images/from-public.png',
      'public/video/demo-poster.jpg',
      'public/video/demo.mp4',
    ]);
  });

  test('a root-relative link to a page is not mistaken for a file', async () => {
    const payload = await resolvePostPayload(repo, POST, { compareRef: 'HEAD' });
    assert.ok(
      !payload.publicFiles.some((f) => f.includes('webmcp')),
      '/webmcp/ names a page, not a file in public/',
    );
  });

  test('resolves a relative asset that sits outside the per-slug folder', async () => {
    // The shape every `changelog` entry uses: `hero: ../../assets/x.png`, filed
    // flat rather than in a per-slug folder. A folder walk alone carries nothing.
    const flat = 'src/content/changelog/flat-hero.md';
    await write('src/assets/flat-hero.png', 'flat-bytes');
    await write(flat, '---\ntitle: "flat"\nhero: ../../assets/flat-hero.png\n---\n\nBody.\n');

    const payload = await resolvePostPayload(repo, flat, { compareRef: 'HEAD' });
    assert.deepEqual(payload.assets, ['src/assets/flat-hero.png']);
  });

  test('carries the dictionary only when it differs from the compare ref', async () => {
    const clean = await resolvePostPayload(repo, POST, { compareRef: 'HEAD' });
    assert.equal(clean.dictionary, null);
    assert.ok(!clean.files.includes('cspell.shared.yaml'));

    await write('cspell.shared.yaml', 'words:\n  - astro\n  - webmcp\n');
    const changed = await resolvePostPayload(repo, POST, { compareRef: 'HEAD' });
    assert.equal(changed.dictionary, 'cspell.shared.yaml');
    assert.equal(changed.files.at(-1), 'cspell.shared.yaml');

    await write('cspell.shared.yaml', 'words:\n  - astro\n');
  });

  test('files lists the post first, then every group', async () => {
    const payload = await resolvePostPayload(repo, POST, { compareRef: 'HEAD' });
    assert.equal(payload.files[0], POST);
    assert.equal(
      payload.files.length,
      1 + payload.assets.length + payload.publicFiles.length + (payload.dictionary ? 1 : 0),
    );
  });

  test('a missing src/assets reference is an error naming the path', async () => {
    const broken = 'src/content/writing/broken-hero.md';
    await write(broken, '---\ntitle: "broken"\nhero: ../../assets/writing/nope/hero.png\n---\n');

    await assert.rejects(
      () => resolvePostPayload(repo, broken, { compareRef: 'HEAD' }),
      (err: unknown) => {
        assert.ok(err instanceof MissingReferenceError);
        assert.match(err.message, /src\/assets\/writing\/nope\/hero\.png/);
        return true;
      },
    );
  });

  test('a missing public/ reference is left out rather than thrown', async () => {
    // Astro type-checks `src/assets/` references and fails the build on a broken
    // one; it never looks at `public/`. `steward-smoke-test.md` names a public
    // image that does not exist on purpose, and a review of it has to report
    // findings rather than crash.
    const smoke = 'src/content/writing/smoke.md';
    await write(smoke, '---\ntitle: "smoke"\n---\n\n![missing](/images/absent.png)\n');

    const payload = await resolvePostPayload(repo, smoke, { compareRef: 'HEAD' });
    assert.deepEqual(payload.publicFiles, []);
    assert.deepEqual(payload.files, [smoke]);
  });

  test('describePayload names the counts and the dictionary', async () => {
    const payload = await resolvePostPayload(repo, POST, { compareRef: 'HEAD' });
    assert.equal(describePayload(payload), '3 asset files, 3 `public/` files');

    assert.equal(
      describePayload({
        ...payload,
        assets: ['a'],
        publicFiles: [],
        dictionary: 'x',
        files: [payload.post, 'a', 'x'],
      }),
      '1 asset file, 0 `public/` files, the shared dictionary',
    );
  });

  test('describePayload says nothing when the post travels alone', async () => {
    const alone = 'src/content/writing/alone.md';
    await write(alone, '---\ntitle: "alone"\n---\n\nJust prose.\n');

    const payload = await resolvePostPayload(repo, alone, { compareRef: 'HEAD' });
    assert.deepEqual(payload.files, [alone]);
    assert.equal(describePayload(payload), '');
  });
});
