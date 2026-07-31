import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { withWorktreeLock, worktreeLockState } from '../../src/lib/worktree-lock.js';
import { syncWorktree } from '../../src/lib/git.js';

const exec = promisify(execFile);

/**
 * The worktree mutex (card: steward-worktree-serialisation).
 *
 * Two halves. The first exercises the lock as a lock — exclusion, FIFO order,
 * release on throw, the acquire timeout. The second runs the two real
 * worktree-mutating sections (`buildAndAuditDraft`'s sync, a publish activity's
 * `checkout -B` + commit) against a throwaway git repo, overlapping, and asserts
 * they serialise: the failure this card exists to prevent is a publish resetting
 * the tree in the middle of a build, and only a real git repo shows that.
 */

// ---------------------------------------------------------------------------
// The lock as a lock
// ---------------------------------------------------------------------------

const tick = () => new Promise((r) => setImmediate(r));

test('a second holder cannot enter while the first is inside', async () => {
  let inside = 0;
  let maxInside = 0;
  const enter = async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await tick();
    await tick();
    inside -= 1;
  };

  await Promise.all([
    withWorktreeLock('a', enter),
    withWorktreeLock('b', enter),
    withWorktreeLock('c', enter),
  ]);

  assert.equal(maxInside, 1, 'critical sections overlapped');
  assert.deepEqual(worktreeLockState(), { holder: undefined, waiting: [] });
});

test('waiters run in FIFO order, so a long queue cannot starve the first arrival', async () => {
  const order: string[] = [];
  const holders = ['first', 'second', 'third', 'fourth'];

  await Promise.all(
    holders.map((h) =>
      withWorktreeLock(h, async () => {
        order.push(h);
        await tick();
      }),
    ),
  );

  assert.deepEqual(order, holders);
});

test('a throwing critical section releases the lock', async () => {
  await assert.rejects(
    () =>
      withWorktreeLock('thrower', async () => {
        throw new Error('build failed');
      }),
    /build failed/,
  );

  assert.equal(worktreeLockState().holder, undefined);
  // And the next caller is not wedged behind the corpse.
  assert.equal(await withWorktreeLock('after', async () => 'ok'), 'ok');
});

test('a waiter waits as long as the holder takes, rather than giving up', async () => {
  // The card's change (steward-publish-contention-timeout): the acquire is
  // unbounded, so the caller's own `startToCloseTimeout` is the only deadline.
  // The publish used to abandon the queue after four minutes; nothing here may
  // reject a waiter for waiting.
  let releaseHolder!: () => void;
  const held = withWorktreeLock('long-build', async () => {
    await new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
  });

  // Give the holder a turn to acquire before the waiter arrives.
  await tick();

  let acquired = false;
  const waiting = withWorktreeLock('patient-publish', async () => {
    acquired = true;
    return 'ran';
  });

  // Several event-loop turns and a real timer later, the waiter is still queued
  // and still un-rejected: the only thing that can end this wait is the holder.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(acquired, false, 'waiter entered while the holder was inside');
  assert.deepEqual(worktreeLockState(), { holder: 'long-build', waiting: ['patient-publish'] });

  releaseHolder();
  await held;
  assert.equal(await waiting, 'ran');
  assert.deepEqual(worktreeLockState(), { holder: undefined, waiting: [] });
});

// ---------------------------------------------------------------------------
// The real worktree-mutating sections, overlapped
// ---------------------------------------------------------------------------

let repo: string;
let worktree: string;
const POST = 'src/content/writing/temp-post.md';

async function git(cwd: string, ...args: string[]) {
  await exec('git', args, { cwd });
}

before(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-lock-'));
  repo = path.join(base, 'repo');
  worktree = path.join(base, 'worktree');
  await fs.mkdir(path.join(repo, 'src', 'content', 'writing'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, POST), '---\ntitle: "committed"\n---\n', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
});

after(async () => {
  await fs.rm(path.dirname(repo), { recursive: true, force: true }).catch(() => {});
});

/**
 * Stands in for `buildAndAuditDraft`'s worktree region: sync, then read back
 * the file it is about to "build" — the read is the part a concurrent publish
 * corrupts.
 */
async function buildSection(marker: string, seen: string[]): Promise<void> {
  await fs.writeFile(path.join(repo, POST), `---\ntitle: "${marker}"\n---\n`, 'utf8');
  await syncWorktree(repo, worktree, POST);
  // Stand-in for npm ci + build + serve + audit: a window, comfortably longer
  // than the publish section's git work, during which the worktree must not
  // move under this activity. The real thing holds it for minutes.
  await new Promise((r) => setTimeout(r, BUILD_HOLD_MS));
  seen.push(await fs.readFile(path.join(worktree, POST), 'utf8'));
}

/** Long enough that an unlocked publish lands inside the build's window. */
const BUILD_HOLD_MS = 800;
const SYNCED_BYTES = '---\ntitle: "under review"\n---\n';

/** Stands in for a publish activity's region: branch the worktree, write, commit. */
async function publishSection(branch: string): Promise<void> {
  await git(worktree, 'checkout', '-B', branch, 'main');
  await git(worktree, 'clean', '-fd');
  await fs.writeFile(path.join(worktree, POST), `---\ntitle: "${branch}"\ndraft: false\n---\n`, 'utf8');
  await git(worktree, 'add', '--', POST);
  await git(worktree, 'commit', '-m', `publish ${branch}`);
  await git(worktree, 'checkout', '--detach');
}

test('an overlapping build and publish serialise, and the build reads its own bytes', async () => {
  // Create the worktree up front so both sections start from the same state.
  await syncWorktree(repo, worktree, POST);

  const seen: string[] = [];
  await Promise.all([
    withWorktreeLock('build', () => buildSection('under review', seen)),
    withWorktreeLock('publish', () => publishSection('steward/publish-temp-post')),
  ]);

  assert.equal(seen.length, 1);
  // The deterministic serialised outcome: whichever order they ran in, the
  // build saw the draft it synced, never the publish commit's version.
  assert.equal(seen[0], SYNCED_BYTES);
  assert.equal(worktreeLockState().holder, undefined);
});

test('a publish that arrives mid-build waits the build out and still publishes', async () => {
  // The card this change exists for (steward-publish-contention-timeout). The
  // test above starts both at once, so FIFO may hand the tree to the publish
  // first; here the build is provably already inside its critical section when
  // the publish arrives, which is the case that used to fail with
  // `WorktreeBusyError` and cost Matt a re-approve.
  await syncWorktree(repo, worktree, POST);

  const seen: string[] = [];
  const build = withWorktreeLock('buildAndAuditDraft:temp-post', () =>
    buildSection('under review', seen),
  );

  // Wait until the build genuinely holds the lock before the publish asks for it.
  while (worktreeLockState().holder === undefined) await tick();
  assert.equal(worktreeLockState().holder, 'buildAndAuditDraft:temp-post');

  const branch = 'steward/publish-mid-build';
  const startedWaiting = Date.now();
  const publish = withWorktreeLock(`publishPost:temp-post`, () => publishSection(branch));

  // Queued, not refused.
  await tick();
  assert.deepEqual(worktreeLockState().waiting, ['publishPost:temp-post']);

  // The publish resolves — no rejection, no bounded-wait failure — and it did so
  // by outlasting the build rather than by racing it.
  await assert.doesNotReject(() => publish);
  const waited = Date.now() - startedWaiting;
  await build;

  assert.ok(
    waited >= BUILD_HOLD_MS - 50,
    `publish completed after ${waited}ms, too fast to have waited out the ${BUILD_HOLD_MS}ms build`,
  );
  // The build still read its own synced bytes, and the publish's commit exists.
  assert.deepEqual(seen, [SYNCED_BYTES]);
  const { stdout } = await exec('git', ['log', '-1', '--format=%s', branch], { cwd: worktree });
  assert.equal(stdout.trim(), `publish ${branch}`);
  assert.equal(worktreeLockState().holder, undefined);
});

test('without the lock the same two sections corrupt each other (the control)', async () => {
  await syncWorktree(repo, worktree, POST);

  const seen: string[] = [];
  let threw = false;
  try {
    await Promise.all([
      buildSection('under review', seen),
      publishSection('steward/publish-unlocked'),
    ]);
  } catch {
    // Either outcome proves the point: two checkouts racing in one tree can also
    // fail outright on git's own index lock. What must not happen is a clean pass.
    threw = true;
  }

  const clean = !threw && seen.length === 1 && seen[0] === SYNCED_BYTES;
  assert.ok(!clean, 'unlocked sections did not interfere — this test no longer proves anything');
});
