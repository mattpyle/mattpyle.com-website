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
 *
 * The fixture worktree carries stand-ins for the three `prebuild` generators
 * whose output is committed. They are stubs rather than the site's own scripts
 * because the question here is the staging contract — *does the publish commit
 * carry what the generators wrote?* — and asking it of the real generators would
 * need a fixture holding the whole content tree, `src/lib/` and `src/data/`. The
 * stand-in for `generate-page-paths.mjs` reproduces the one property that
 * matters: its output is a function of the content directory, so publishing a
 * post changes it. The site's own tests hold the generators themselves.
 */

let site: string;
let worktree: string;
const POST = 'src/content/writing/staged-post.md';

const PAGE_PATHS = 'src/data/page-paths.mjs';
const A2A_DIGEST = 'src/data/a2a-digest.json';
const SKILLS_INDEX = 'src/data/agent-skills-index.json';

/**
 * What the two constant-writing stubs write.
 *
 * They stand for the generators whose output this post does not change, and
 * their presence is what proves the loop runs all three and still stages only
 * what actually moved.
 */
const FIXED = '{\n  "fixed": true\n}\n';

/** What the page-paths stub writes for a given set of post filenames. */
function pagePathsFor(...files: string[]): string {
  return `export const PAGE_PATHS = ${JSON.stringify(files.sort())};\n`;
}

/** Reads `src/content/writing/` and writes the slug list. Only on a difference. */
const PAGE_PATHS_STUB = `
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'data', 'page-paths.mjs');

let slugs = [];
try {
  slugs = readdirSync(join(root, 'src', 'content', 'writing')).sort();
} catch {}

const next = \`export const PAGE_PATHS = \${JSON.stringify(slugs)};\\n\`;
let current = null;
try { current = readFileSync(out, 'utf8'); } catch {}
if (current !== next) writeFileSync(out, next);
`;

/** Writes a constant to `rel`. Only on a difference. */
function fixedStub(rel: string): string {
  return `
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, ${JSON.stringify(rel)});

const next = ${JSON.stringify(FIXED)};
let current = null;
try { current = readFileSync(out, 'utf8'); } catch {}
if (current !== next) writeFileSync(out, next);
`;
}

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
  // origin/master, which has never seen any of the above. Its base commit
  // carries the generators and the files they write, exactly as a real base
  // commit does — including a `page-paths.mjs` for a content tree with no posts
  // in it, which is what makes publishing one a difference.
  await fs.mkdir(worktree, { recursive: true });
  await git(worktree, 'init', '-b', 'main');
  await git(worktree, 'config', 'user.email', 'test@example.com');
  await git(worktree, 'config', 'user.name', 'Test');
  await write(worktree, 'cspell.shared.yaml', 'words:\n  - astro\n');
  await write(worktree, 'scripts/generate-page-paths.mjs', PAGE_PATHS_STUB);
  await write(worktree, 'scripts/generate-a2a-digest.mjs', fixedStub(A2A_DIGEST));
  await write(worktree, 'scripts/generate-agent-skills-index.mjs', fixedStub(SKILLS_INDEX));
  await write(worktree, PAGE_PATHS, pagePathsFor());
  await write(worktree, A2A_DIGEST, FIXED);
  await write(worktree, SKILLS_INDEX, FIXED);
  await git(worktree, 'add', '.');
  await git(worktree, 'commit', '-m', 'base');
});

after(async () => {
  await fs.rm(path.dirname(site), { recursive: true, force: true }).catch(() => {});
});

describe('writeAndStagePayload', () => {
  test('stages the payload and the regenerated data files that changed', async () => {
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
      PAGE_PATHS,
      POST,
    ].sort());
    assert.deepEqual(await stagedInIndex(worktree), staged.sort());
  });

  test('the regenerated file holds what the generator wrote, not a copied one', async () => {
    // The point of running the generators in the worktree rather than copying
    // the author's `src/data/`: the content tree this commit creates is what
    // decides the contents.
    assert.equal(
      await fs.readFile(path.join(worktree, PAGE_PATHS), 'utf8'),
      pagePathsFor('staged-post.md'),
    );
  });

  test('a generator whose output did not change stages nothing', async () => {
    // Both constant-writing stubs ran — the loop is not conditional — and
    // neither is in the staged set, because neither wrote a different byte.
    const index = await stagedInIndex(worktree);
    assert.ok(!index.includes(A2A_DIGEST));
    assert.ok(!index.includes(SKILLS_INDEX));
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
    // commit" for the whole payload, not only for the markdown — and now not
    // for the regenerated data files either, since the base already carries the
    // post the generators read.
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

  test('a failing generator fails the publish non-retryably, before anything is staged', async () => {
    // A generator exits non-zero on a fact about the content tree — a post whose
    // frontmatter the generator cannot read, say — and a second attempt reads
    // the same tree. Retrying would burn attempts to reach the same answer, and
    // the push must not happen either way.
    await git(worktree, 'commit', '-m', 'chore(steward): new hero');
    await write(
      worktree,
      'scripts/generate-page-paths.mjs',
      "process.stderr.write('cannot read the content tree\\n');\nprocess.exit(3);\n",
    );

    const payload = await resolvePostPayload(site, POST, { compareRef: 'HEAD' });
    await assert.rejects(
      () =>
        writeAndStagePayload({
          siteDir: site,
          worktreeDir: worktree,
          payload,
          postContent: PUBLISHED,
        }),
      (err: Error & { type?: string; nonRetryable?: boolean }) => {
        assert.equal(err.type, 'GeneratorFailed');
        assert.equal(err.nonRetryable, true);
        assert.match(err.message, /generate-page-paths\.mjs failed \(exit 3\)/);
        assert.match(err.message, /cannot read the content tree/);
        return true;
      },
    );

    assert.deepEqual(await stagedInIndex(worktree), [], 'a failure stages nothing');
  });
});
