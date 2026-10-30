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
