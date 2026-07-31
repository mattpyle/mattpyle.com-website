import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  withWorktreeLock,
  worktreeLockState,
  WorktreeBusyError,
  PUBLISH_ACQUIRE_TIMEOUT_MS,
} from '../../src/lib/worktree-lock.js';
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

test('acquireTimeoutMs fails with WorktreeBusyError naming the holder, and does not leak a waiter', async () => {
  let releaseHolder!: () => void;
  const held = withWorktreeLock('long-build', async () => {
    await new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
  });

  // Give the holder a turn to acquire before the impatient caller arrives.
  await tick();

  const err = await withWorktreeLock('impatient-publish', async () => 'never runs', {
    acquireTimeoutMs: 10,
  }).then(
    () => undefined,
    (e: unknown) => e,
  );

  assert.ok(err instanceof WorktreeBusyError, `expected WorktreeBusyError, got ${String(err)}`);
  assert.match(err.message, /long-build/);
  assert.deepEqual(worktreeLockState().waiting, [], 'timed-out waiter left in the queue');

  releaseHolder();
  await held;
  assert.equal(worktreeLockState().holder, undefined);
});

test('a timed-out waiter never later steals the lock', async () => {
  let releaseHolder!: () => void;
  const held = withWorktreeLock('holder', async () => {
    await new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
  });
  await tick();

  await assert.rejects(
    () => withWorktreeLock('gone', async () => 'never runs', { acquireTimeoutMs: 5 }),
    WorktreeBusyError,
  );

  let ran = false;
  releaseHolder();
  await held;
  await withWorktreeLock('next', async () => {
    ran = true;
    assert.deepEqual(worktreeLockState().waiting, []);
  });
  assert.ok(ran);
});

test('the publish acquire timeout stays inside the publish activities startToCloseTimeout', () => {
  // Both publish activities are scheduled with `startToCloseTimeout: '5 minutes'`
  // and may not be changed workflow-side (replay risk on parked reviews). If this
  // constant ever exceeds that, the WorktreeBusyError it exists to produce would
  // never fire — the activity would time out first.
  assert.ok(PUBLISH_ACQUIRE_TIMEOUT_MS < 5 * 60_000);
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
