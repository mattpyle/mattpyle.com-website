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
 * `steward cleanup`, exercised against a real throwaway origin + clone in the
 * temp dir, for the same reason `worktree.test.ts` does: the behaviour under
 * test is almost entirely git's own (untracked-file state, ancestry,
 * `--ff-only`), and a mocked git would assert only that we call the commands we
 * already decided to call.
 *
 * The fixture reproduces the incident this command exists for: a draft that was
 * never committed locally, published by Steward from its own worktree, and
 * therefore sitting in the author's checkout as an untracked twin of a file the
 * incoming merge also adds.
 */

const POST = 'src/content/writing/temp-post.md';
const SLUG = 'temp-post';
/** The exact bytes the gate reviewed. CRLF on purpose — this is a Windows checkout. */
const DRAFT = '---\r\ntitle: "A draft"\r\ndraft: true\r\n---\r\n\r\nBody.\r\n';
const PUBLISHED = DRAFT.replace('draft: true', 'draft: false');

let base: string;
let origin: string;
let repo: string;
let reviewedSha: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

function sha256(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

/**
 * Builds: a bare origin on `master` carrying the *published* post, and a clone
 * whose HEAD is one commit behind it. The clone does not have the post at all —
 * exactly the state a checkout is in after Steward published from its worktree
 * and someone merged the PR.
 */
async function makeFixture(): Promise<void> {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-cleanup-'));
  origin = path.join(base, 'origin.git');
  repo = path.join(base, 'repo');

  const seed = path.join(base, 'seed');
  await fs.mkdir(seed, { recursive: true });
  await git(seed, 'init', '-b', 'master');
  await git(seed, 'config', 'user.email', 'test@example.com');
  await git(seed, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(seed, 'README.md'), 'seed\n', 'utf8');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'initial');
  await git(base, 'clone', '--bare', seed, origin);

  await git(base, 'clone', origin, repo);
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');

  // The publish: a commit on origin/master adding the post with `draft: false`.
  // Made in the seed clone so the author's checkout stays one commit behind.
  await git(seed, 'remote', 'add', 'origin', origin);
  await fs.mkdir(path.join(seed, path.dirname(POST)), { recursive: true });
  await fs.writeFile(path.join(seed, POST), PUBLISHED, 'utf8');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'chore(steward): publish temp-post');
  await git(seed, 'push', 'origin', 'master');

  // The twin: the reviewed draft, untracked, in the author's checkout.
  await fs.mkdir(path.join(repo, path.dirname(POST)), { recursive: true });
  await fs.writeFile(path.join(repo, POST), DRAFT, 'utf8');
  reviewedSha = sha256(DRAFT);
}

function run(overrides: Partial<Parameters<typeof cleanupPublishedTwin>[0]> = {}) {
  return cleanupPublishedTwin({
    repoDir: repo,
    relPath: POST,
    slug: SLUG,
    reviewedSha256: reviewedSha,
    ...overrides,
  });
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

// ---------------------------------------------------------------------------
// The success path.
// ---------------------------------------------------------------------------

test('deletes a byte-identical twin and fast-forwards the checkout', async () => {
  const before = await git(repo, 'rev-parse', 'HEAD');

  const result = await run();

  assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.deleted, true);
  assert.equal(result.pulled, true);
  assert.equal(result.base, 'master');
  assert.notEqual(result.to, before, 'HEAD should have moved');

  // The published post is present, and it is the published version — the point
  // of the whole exercise is that the merge's copy wins.
  const onDisk = await fs.readFile(path.join(repo, POST), 'utf8');
  assert.equal(onDisk, PUBLISHED);
  assert.equal(await git(repo, 'status', '--porcelain'), '', 'checkout should be clean');
});

test('is idempotent: a second run finds nothing to delete and stays clean', async () => {
  await run();
  const result = await run();

  assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
  // The twin is gone, but the *published* file is now here and tracked — so the
  // command must not read "byte-mismatch" and must not delete it.
  assert.equal(result.deleted, false);
  assert.equal(await fs.readFile(path.join(repo, POST), 'utf8'), PUBLISHED);
  assert.equal(await git(repo, 'status', '--porcelain'), '');
});

// ---------------------------------------------------------------------------
// Guard 1 — deletion must be provably lossless.
// ---------------------------------------------------------------------------

test('refuses a modified twin, touching nothing, and prints the commands', async () => {
  const edited = DRAFT.replace('Body.', 'Body, edited after the review.');
  await fs.writeFile(path.join(repo, POST), edited, 'utf8');
  const before = await git(repo, 'rev-parse', 'HEAD');

  const r = refusal(await run());

  assert.equal(r.guard, 'lossless');
  assert.match(r.why, /changed since it was reviewed|does not match/i);
  assert.ok(r.commands.length > 0, 'a refusal must print the manual commands');
  // Touched nothing: the file is still there, still edited, HEAD has not moved.
  assert.equal(await fs.readFile(path.join(repo, POST), 'utf8'), edited);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), before);
});

test('refuses a tracked twin — deleting a committed file is not lossless', async () => {
  await git(repo, 'add', '--', POST);
  await git(repo, 'commit', '-m', 'author committed the draft');
  const before = await git(repo, 'rev-parse', 'HEAD');

  const r = refusal(await run());

  assert.equal(r.guard, 'lossless');
  assert.match(r.why, /tracked|committed/i);
  assert.ok(r.commands.length > 0);
  assert.equal(await fs.readFile(path.join(repo, POST), 'utf8'), DRAFT);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), before);
});

test('refuses while the publish PR is unmerged — the draft exists nowhere else', async () => {
  // Roll origin/master back to before the publish commit. The twin is now the
  // only copy of the draft in existence, and deleting it would destroy it.
  await git(origin, 'update-ref', 'refs/heads/master', 'HEAD~1');

  const r = refusal(await run());

  assert.equal(r.guard, 'lossless');
  assert.match(r.why, /not.*(carry|on origin|merged)/i);
  assert.equal(await fs.readFile(path.join(repo, POST), 'utf8'), DRAFT);
});

// ---------------------------------------------------------------------------
// Guard 2 — the checkout is on the base branch, mid-nothing.
// ---------------------------------------------------------------------------

test('refuses on a non-base branch, printing the switch command', async () => {
  await git(repo, 'switch', '-c', 'some-other-work');

  const r = refusal(await run());

  assert.equal(r.guard, 'branch');
  assert.match(r.why, /some-other-work/);
  assert.ok(
    r.commands.some((c) => c.includes('git switch master')),
    `expected the switch command, got: ${r.commands.join(' | ')}`,
  );
  assert.equal(await fs.readFile(path.join(repo, POST), 'utf8'), DRAFT);
});

test('refuses mid-merge even on the base branch', async () => {
  // A real interrupted merge: a conflicting commit on both sides of README.md.
  await git(repo, 'switch', '-c', 'conflicting');
  await fs.writeFile(path.join(repo, 'README.md'), 'theirs\n', 'utf8');
  await git(repo, 'commit', '-am', 'theirs');
  await git(repo, 'switch', 'master');
  await fs.writeFile(path.join(repo, 'README.md'), 'ours\n', 'utf8');
  await git(repo, 'commit', '-am', 'ours');
  await exec('git', ['merge', 'conflicting'], { cwd: repo }).catch(() => {});

  const r = refusal(await run());

  assert.equal(r.guard, 'branch');
  assert.match(r.why, /merge/i);
  assert.equal(await fs.readFile(path.join(repo, POST), 'utf8'), DRAFT);
});

// ---------------------------------------------------------------------------
// Guard 3 — the pull must be a fast-forward.
// ---------------------------------------------------------------------------

test('refuses when the checkout has diverged and cannot fast-forward', async () => {
  await fs.writeFile(path.join(repo, 'local.txt'), 'local work\n', 'utf8');
  await git(repo, 'add', '--', 'local.txt');
  await git(repo, 'commit', '-m', 'local commit that is not on origin');
  const before = await git(repo, 'rev-parse', 'HEAD');

  const r = refusal(await run());

  assert.equal(r.guard, 'fast-forward');
  // Specifically the ancestry *precheck*, not the pull's own failure afterwards.
  // Letting `--ff-only` discover this would be correct but too late: the twin
  // would already be deleted, and only the restore path would save it.
  assert.match(r.why, /not an ancestor/i);
  assert.match(r.why, /fast-forward|diverged/i);
  assert.ok(
    r.commands.some((c) => c.includes('git pull')),
    `expected a pull command, got: ${r.commands.join(' | ')}`,
  );
  assert.equal(await fs.readFile(path.join(repo, POST), 'utf8'), DRAFT);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), before);
});

test('refuses when incoming files collide with other uncommitted work', async () => {
  // The pull would overwrite a file the author is mid-edit on. `--ff-only` would
  // refuse anyway — but only *after* the twin had already been deleted, which is
  // exactly the half-done state the guards exist to prevent.
  await fs.writeFile(path.join(repo, 'README.md'), 'mid-edit, uncommitted\n', 'utf8');
  // Put a README change on origin so it is genuinely part of the incoming diff.
  const seed = path.join(base, 'seed');
  await fs.writeFile(path.join(seed, 'README.md'), 'upstream edit\n', 'utf8');
  await git(seed, 'commit', '-am', 'upstream touches README');
  await git(seed, 'push', 'origin', 'master');

  const r = refusal(await run());

  assert.equal(r.guard, 'fast-forward');
  assert.match(r.why, /README\.md/);
  assert.equal(await fs.readFile(path.join(repo, POST), 'utf8'), DRAFT);
  assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'mid-edit, uncommitted\n');
});

// ---------------------------------------------------------------------------
// Every refusal is actionable.
// ---------------------------------------------------------------------------

test('no refusal is ever silent about what to do next', async () => {
  const cases: Array<() => Promise<unknown>> = [
    async () => fs.writeFile(path.join(repo, POST), DRAFT + 'edited\n', 'utf8'),
    async () => git(repo, 'switch', '-c', 'elsewhere'),
    async () => {
      await fs.writeFile(path.join(repo, 'local.txt'), 'x\n', 'utf8');
      await git(repo, 'add', '--', 'local.txt');
      await git(repo, 'commit', '-m', 'diverge');
    },
  ];

  for (const setup of cases) {
    await makeFixture();
    await setup();
    const r = refusal(await run());
    assert.ok(r.why.trim().length > 0, 'a refusal states why');
    assert.ok(r.commands.length > 0, 'a refusal prints commands');
    assert.ok(
      r.commands.every((c) => c.trim().length > 0),
      'no blank commands',
    );
  }
});
