/**
 * Keeps real credentials out of a test process, whatever command line started it.
 *
 * `config.ts` calls `guardTestCredentials` before it reads `.env`, so the guard holds for
 * a `node --test` run that names no `--import`. `tests/helpers/no-real-credentials.ts`
 * calls the same function for a test file that never loads `config.ts`.
 *
 * No imports from `config.ts`: that module calls this one before it does anything else.
 */

/**
 * The variables a test process must never hold a real value for. A test that wants one
 * sets its own after the guard has run; `tests/helpers/fake-github.ts` does so for GitHub.
 */
export const TEST_GUARDED_VARIABLES: readonly string[] = [
  // GitHub: the app credential, and the tokens `gh` and git read.
  'STEWARD_GITHUB_APP_ID',
  'STEWARD_GITHUB_APP_PRIVATE_KEY',
  'STEWARD_GITHUB_APP_INSTALLATION_ID',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  // The reviewer's model: a live call spends money.
  'ANTHROPIC_API_KEY',
  // The preview bypass secret.
  'VERCEL_AUTOMATION_BYPASS_SECRET',
  // The Web Bot Auth signing key: a test that signs builds a throwaway key at run time.
  'STEWARD_WEB_BOT_AUTH_KEY',
  // The alerting base URL: every run-health signal posts to it, healthy or not.
  'STEWARD_HEALTHCHECK_BASE',
  // The Temporal API keys. A `.env` line may hold a 1Password reference, and a reference
  // that reaches `config.ts` stops every test that loads it. The suite never connects to
  // Temporal Cloud.
  'TEMPORAL_API_KEY',
  'TEMPORAL_METRICS_API_KEY',
  'TEMPORAL_READ_ONLY_API_KEY',
];

/** Set once the variables are blanked. A child process inherits it and keeps what its parent test gave it. */
export const TEST_GUARD_MARKER = 'STEWARD_TEST_CREDENTIALS_BLANKED';

/** A script path that node's test runner would pick up: `x.test.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`. */
const TEST_FILE = /\.test\.[cm]?[jt]s$/;

export interface ProcessShape {
  argv: readonly string[];
  execArgv: readonly string[];
  env: Record<string, string | undefined>;
}

/**
 * True when this process belongs to a test run. Three signals, any one is enough:
 *
 * 1. `NODE_TEST_CONTEXT` is set. `node --test` sets it in the child it starts for each
 *    test file, and a CLI that the test spawns inherits it.
 * 2. `--test` is in `execArgv`: the runner itself, and every test under `--test-isolation=none`.
 * 3. The script is a `*.test.*` file, run directly without `--test`.
 *
 * A worker or CLI start has none of them: its script is `worker.ts`, `worker-hosted.ts` or
 * `cli.ts`, and nothing in the Dockerfile, the launcher or a workflow sets `NODE_TEST_CONTEXT`.
 * A false yes here would blank a worker's credentials, so each signal is exact, not a pattern
 * over flag names.
 */
export function isTestProcess(p: ProcessShape): boolean {
  if ((p.env.NODE_TEST_CONTEXT ?? '') !== '') return true;
  if (p.execArgv.includes('--test')) return true;
  return TEST_FILE.test(p.argv[1] ?? '');
}

/**
 * Blanks the guarded variables, once per test run, and says whether this is a test process.
 *
 * Empty, not deleted: an empty value is defined, so nothing downstream treats the variable as
 * missing-and-loadable. The marker makes a second call a no-op, in this process and in a child,
 * so a value a test or `fake-github.ts` set after the first call survives.
 *
 * Returns true in a test process; `config.ts` then keeps the guarded variables out of its
 * `.env` read as well, which covers a variable a test deleted after the blanking.
 *
 * A test file that sets a guarded variable before `config.ts` loads, or hands one to a child
 * CLI without loading `config.ts` itself, imports `tests/helpers/no-real-credentials.ts` first.
 * Without it the first call comes later and blanks the test's own value: the test fails, and
 * no real value gets through.
 */
export function guardTestCredentials(p: ProcessShape = process): boolean {
  if (!isTestProcess(p)) return false;
  if (p.env[TEST_GUARD_MARKER] !== '1') {
    for (const name of TEST_GUARDED_VARIABLES) p.env[name] = '';
    p.env[TEST_GUARD_MARKER] = '1';
  }
  return true;
}
