/**
 * Which role the hosted image runs in (STW-610).
 *
 * The image starts in one of two roles, chosen by `STEWARD_WORKER_ROLE`:
 *
 * - **default** (unset, empty or `default`): the credentialed worker. Three
 *   queues, the scorecard's publish leg, the findings loop.
 * - **public**: the uncredentialed worker for the public audits. It serves
 *   `steward-audit` and `steward-audit-fast` only, in whatever Temporal
 *   namespace `TEMPORAL_NAMESPACE` names, and holds no credential that writes
 *   to GitHub. A page rendered for a stranger runs in this process, so
 *   everything else the Steward codebase reads as a secret is kept out of its
 *   environment too (STW-609).
 *
 * This module is pure: no connection, no side effect at import. The entry point
 * and the tests both use it.
 */

export type WorkerRole = 'default' | 'public';

export const WORKER_ROLE_ENV = 'STEWARD_WORKER_ROLE';

/** Strict: an unknown value throws, so a typo never falls back to the credentialed role. */
export function parseWorkerRole(env: Record<string, string | undefined>): WorkerRole {
  const raw = (env[WORKER_ROLE_ENV] ?? '').trim();
  if (raw === '' || raw === 'default') return 'default';
  if (raw === 'public') return 'public';
  throw new Error(`${WORKER_ROLE_ENV} must be "public" or "default" (or unset); got a value that is neither.`);
}

/**
 * Credential-bearing variables the public role needs. Each has a reason:
 *
 * - `TEMPORAL_API_KEY`: the worker's own connection to Temporal Cloud. It is a
 *   key for the audit namespace, which holds no findings workflow.
 * - `STEWARD_WEB_BOT_AUTH_KEY`: signs the auditor's requests, so a site owner
 *   can verify the traffic is Steward's.
 * - `STEWARD_METRICS_OTLP_*`: the SDK metrics export to Grafana Cloud.
 */
export const PUBLIC_ROLE_ALLOWED_CREDENTIALS: readonly string[] = [
  'TEMPORAL_API_KEY',
  'STEWARD_WEB_BOT_AUTH_KEY',
  'STEWARD_METRICS_OTLP_URL',
  'STEWARD_METRICS_OTLP_USER',
  'STEWARD_METRICS_OTLP_TOKEN',
];

/**
 * Credential-bearing variables the public role refuses to start beside. Every
 * key, token, secret or app id the Steward codebase reads is in this list or in
 * the allowed one; `tests/lib/worker-role.test.ts` scans `src/` and fails when a
 * new one is in neither.
 */
export const PUBLIC_ROLE_REFUSED_CREDENTIALS: readonly string[] = [
  // GitHub: the credential that writes to the repositories.
  'STEWARD_GITHUB_APP_ID',
  'STEWARD_GITHUB_APP_PRIVATE_KEY',
  'STEWARD_GITHUB_APP_INSTALLATION_ID',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  // The reviewer's model.
  'ANTHROPIC_API_KEY',
  // Temporal keys with other jobs: Cloud usage sampling and the read-only console.
  'TEMPORAL_METRICS_API_KEY',
  'TEMPORAL_READ_ONLY_API_KEY',
  // Reaches Vercel preview deployments.
  'VERCEL_AUTOMATION_BYPASS_SECRET',
];

/**
 * The refused variables that are set. Names only, never values. Empty means the
 * environment is clean. An empty string counts as unset.
 */
export function presentRefusedCredentials(env: Record<string, string | undefined>): string[] {
  return PUBLIC_ROLE_REFUSED_CREDENTIALS.filter((name) => (env[name] ?? '') !== '');
}

/** Throws, naming each offending variable and no value, when the public role's environment holds one. */
export function assertPublicRoleEnvironment(env: Record<string, string | undefined>): void {
  const present = presentRefusedCredentials(env);
  if (present.length === 0) return;
  throw new Error(
    `${WORKER_ROLE_ENV}=public refuses to start: ${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set. ` +
      'The public-audit worker renders pages that strangers choose and must hold no credential that writes to ' +
      "GitHub or reaches the findings loop. Remove the variable from this service's environment and redeploy.",
  );
}
