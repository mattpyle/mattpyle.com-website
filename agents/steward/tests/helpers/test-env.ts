import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';

/**
 * Where the time-skipping test server binary is cached.
 *
 * `createTimeSkipping()` defaults to the system temp directory with a **1-day**
 * TTL, which is why the workflow suites' "no network" comment was only
 * accidentally true: the binary is downloaded on first use, and after 24 hours
 * — or on any fresh machine, or any CI runner — it is downloaded again. That is
 * a real network dependency at the front of the suite, and it is where the
 * observed flaky first run (`Failed to start ephemeral server`, passing on the
 * retry) came from.
 *
 * The home is per user, not per checkout: a path inside the checkout gave
 * every git worktree its own 57 MB download, and on Windows a firewall prompt
 * per worktree, because firewall rules are keyed to the executable's path.
 * CI restores it with `actions/cache` (`ci.yml`), so the download happens once
 * per runner image rather than once per run. `STEWARD_TEST_SERVER_DIR`
 * overrides it.
 */
export const TEST_SERVER_DIR =
  process.env.STEWARD_TEST_SERVER_DIR ??
  path.join(
    process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'),
    'steward',
    'temporal-test-server',
  );

/**
 * The time-skipping environment every workflow suite shares.
 *
 * The long TTL is deliberate: the binary is pinned to the installed
 * `@temporalio/*` version, so re-downloading it on a timer buys nothing. A real
 * SDK upgrade changes the resolved version and re-downloads on its own.
 */
export function createTestEnv(): Promise<TestWorkflowEnvironment> {
  // The SDK does not create `downloadDir` — it fails with the deeply unhelpful
  // `Failed to start ephemeral server: The system cannot find the path
  // specified. (os error 3)`, which reads like a server problem rather than a
  // missing directory. This is almost certainly the same message the earlier
  // review recorded as a mystery "flaky first run". The default works only
  // because the system temp directory always exists.
  fs.mkdirSync(TEST_SERVER_DIR, { recursive: true });

  return TestWorkflowEnvironment.createTimeSkipping({
    server: {
      executable: { type: 'cached-download', downloadDir: TEST_SERVER_DIR, ttl: '365 days' },
    },
  });
}
