/**
 * The refusal behind `steward up` and `steward update` when the shell hands them
 * the read-only Temporal key.
 *
 * `loadDotEnv` in `config.ts` never overrides a variable that is already set, so
 * a shell that exported `TEMPORAL_API_KEY` for a read-only diagnostic wins over
 * the full key in `.env`. A worker started that way connects, then dies on its
 * first poll with `PermissionDenied` (2026-10-13). One string comparison before
 * anything connects says so up front.
 *
 * Pure: it reads the environment it is given, so a test passes a plain object.
 */

/** Both variables set, to the same value. Unset or empty is not a match. */
export function readOnlyKeyRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.TEMPORAL_API_KEY ?? '';
  const readOnly = env.TEMPORAL_READ_ONLY_API_KEY ?? '';
  if (key === '' || readOnly === '' || key !== readOnly) return null;
  return (
    'Refusing to start: TEMPORAL_API_KEY is set to the same value as TEMPORAL_READ_ONLY_API_KEY, ' +
    'so a worker started here would connect with the read-only key and die on its first poll with ' +
    'PermissionDenied. Clear TEMPORAL_API_KEY in this shell (PowerShell: ' +
    '`Remove-Item Env:TEMPORAL_API_KEY`) so Steward reads the full key from agents/steward/.env, ' +
    'then run the command again.'
  );
}
