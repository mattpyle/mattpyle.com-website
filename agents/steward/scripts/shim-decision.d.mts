export const REINSTALL_EXIT_CODE: 75;
export const INSTALLED_BY_SHIM_ENV: 'STEWARD_INSTALLED_BY_SHIM';
export function nextShimStep(input: { exitCode: number | null; installedByShim: boolean }): 'reinstall' | 'exit';
export function installFailureMessage(npmExitCode: number | null): string;
export const OP_REFERENCE_PREFIX: 'op://';
export function envFileHasReference(text: string): boolean;
export function opMissingMessage(): string;
export function launchPlan(input: {
  envFileText: string | null;
  opPath: string | null;
}): { kind: 'plain' } | { kind: 'wrap' } | { kind: 'error'; message: string };
