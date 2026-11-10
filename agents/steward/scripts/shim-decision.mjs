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
 * True when at least one line of a dotenv file holds a value that starts with
 * `op://`. It tests the prefix and keeps nothing else from the text, so a plain
 * value never leaves this function. Comment lines and blank lines do not count.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function envFileHasReference(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const value = trimmed.slice(eq + 1).trim().replace(/^["']/, '');
    if (value.startsWith(OP_REFERENCE_PREFIX)) return true;
  }
  return false;
}

/** The message when the env file holds references and `op` is not installed. */
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
 * - `plain`: no env file, or one without references. The CLI starts as before.
 * - `wrap`: the file holds a reference and `op` exists. The CLI runs under
 *   `op run --env-file <file> --`.
 * - `error`: the file holds a reference and `op` is missing. The shim prints
 *   the message and exits, so the user sees the fix and not a spawn error.
 *
 * @param {{ envFileText: string | null, opPath: string | null }} input
 *   `envFileText` is null when the file does not exist. `opPath` is null when
 *   `op` is not on PATH.
 * @returns {{ kind: 'plain' } | { kind: 'wrap' } | { kind: 'error', message: string }}
 */
export function launchPlan({ envFileText, opPath }) {
  if (envFileText === null || !envFileHasReference(envFileText)) return { kind: 'plain' };
  if (!opPath) return { kind: 'error', message: opMissingMessage() };
  return { kind: 'wrap' };
}
