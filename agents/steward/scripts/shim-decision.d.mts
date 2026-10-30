export const REINSTALL_EXIT_CODE: 75;
export const INSTALLED_BY_SHIM_ENV: 'STEWARD_INSTALLED_BY_SHIM';
export function nextShimStep(input: { exitCode: number | null; installedByShim: boolean }): 'reinstall' | 'exit';
export function installFailureMessage(npmExitCode: number | null): string;
