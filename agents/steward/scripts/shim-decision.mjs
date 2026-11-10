// What the `steward` shim does after the CLI exits. Pure, so a test calls it
// without spawning `npm`. Plain JavaScript because the shim runs under plain
// `node`, before tsx exists; `shim-decision.d.mts` types it for the CLI and tests.

/**
 * The CLI exits with this code when `node_modules` needs `npm ci`. 75 is
 * EX_TEMPFAIL from sysexits.h: "try again", which is what the shim does.
 */
export const REINSTALL_EXIT_CODE = 75;

/** Set on the CLI's re-run after the shim installed, so a still-stale install refuses instead of looping. */
export const INSTALLED_BY_SHIM_ENV = 'STEWARD_INSTALLED_BY_SHIM';

/**
 * @param {{ exitCode: number | null, installedByShim: boolean }} input
 * @returns {'reinstall' | 'exit'} `reinstall` runs `npm ci` and re-runs the CLI.
 *   A second reinstall request after the shim already installed is passed through
 *   as a plain exit: the CLI refuses with the reason before it ever asks twice.
 */
export function nextShimStep({ exitCode, installedByShim }) {
  if (exitCode === REINSTALL_EXIT_CODE && !installedByShim) return 'reinstall';
  return 'exit';
}

/** The message the shim prints when its own `npm ci` fails. */
export function installFailureMessage(npmExitCode) {
  return (
    `npm ci failed (exit ${npmExitCode}). node_modules may be incomplete. ` +
    'Run `npm ci` at the repository root, then `steward up`.'
  );
}

/** The prefix of a 1Password secret reference. */
export const OP_REFERENCE_PREFIX = 'op://';

/**
 * The reference lines of a dotenv text, as `{ key, value }`. Parsed exactly as
 * `loadDotEnv` in `src/config.ts` parses: trim the line, skip blanks and `#`
 * comments, split at the first `=`, trim the key, trim the value and strip one
 * pair of outer quotes. The first line for a key wins, as it does there. Only
 * lines whose value starts with `op://` come back, so a plain value never leaves
 * this function.
 *
 * @param {string} text
 * @returns {{ key: string, value: string }[]}
 */
export function referenceEntries(text) {
  const seen = new Set();
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith(OP_REFERENCE_PREFIX)) entries.push({ key, value });
  }
  return entries;
}

/** True when at least one line of a dotenv text holds a reference. */
export function envFileHasReference(text) {
  return referenceEntries(text).length > 0;
}

/** The message when a reference needs resolving and `op` is not installed. */
export function opMissingMessage() {
  return (
    'agents/steward/.env holds op:// references, but the 1Password CLI (`op`) is not on PATH. ' +
    'Install it (https://developer.1password.com/docs/cli/get-started/), ' +
    'or replace the references with plain values, then run the command again.'
  );
}

/**
 * How the shim starts the CLI.
 *
 * A variable already set in the launcher's environment wins over the file, as in
 * `loadDotEnv`. So only a reference line whose key is NOT set in `env` is passed on:
 * the shim puts that reference string into the child's environment, and
 * `op run -- <cli>` resolves references found in environment variables. The shim
 * passes no `--env-file` (it would give the file precedence over the shell).
 *
 * - `plain`: no env file, or nothing to resolve. The CLI starts as before.
 * - `wrap`: `inject` holds the reference strings to add; run under `op run --`.
 * - `error`: something needs resolving and `op` is missing. The shim prints the
 *   message and exits, so the user sees the fix and not a spawn error.
 *
 * @param {{ envFileText: string | null, opPath: string | null, env: Record<string, string | undefined> }} input
 *   `envFileText` is null when the file does not exist. `opPath` is null when
 *   `op` is not on PATH. `env` is the launcher's own environment.
 * @returns {{ kind: 'plain' } | { kind: 'wrap', inject: Record<string, string> } | { kind: 'error', message: string }}
 */
export function launchPlan({ envFileText, opPath, env }) {
  if (envFileText === null) return { kind: 'plain' };
  /** @type {Record<string, string>} */
  const inject = {};
  for (const { key, value } of referenceEntries(envFileText)) {
    if (env[key] === undefined) inject[key] = value;
  }
  if (Object.keys(inject).length === 0) return { kind: 'plain' };
  if (!opPath) return { kind: 'error', message: opMissingMessage() };
  return { kind: 'wrap', inject };
}
