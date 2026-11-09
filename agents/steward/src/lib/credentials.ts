import { NAMESPACE, WORKER_READY_LOG } from '../config.js';
import { sampleActionUsage } from './action-usage.js';
import { healthCheckSlug } from './run-health.js';
import type { CredentialSpec, RotateTarget } from './credential-rotate.js';

/**
 * Steward's credentials for `steward credential rotate`: one row per
 * credential, and the values that make the generic runner (`credential-rotate.ts`)
 * rotate Steward's rather than anyone else's.
 *
 * A third credential is one row here and, if its check is new, one function in
 * {@link STEWARD_VERIFIERS}. The runner and its real dependencies
 * (`credential-rotate-deps.ts`) name nothing of Steward's.
 */

/** Where a Steward credential lives: the Railway service that reads it and the 1Password vault that holds it. */
export const STEWARD_TARGET: RotateTarget = {
  railwayProject: 'mattpyle.com-website',
  railwayService: 'steward-audit-worker',
  railwayEnvironment: 'production',
  opVault: 'Steward',
  readyMarker: WORKER_READY_LOG,
};

export const CREDENTIALS: Record<string, CredentialSpec> = {
  'temporal-metrics': {
    name: 'temporal-metrics',
    envVar: 'TEMPORAL_METRICS_API_KEY',
    opItem: 'TEMPORAL_METRICS_API_KEY',
    railwayVariable: 'TEMPORAL_METRICS_API_KEY',
    issuer: 'tcld',
    serviceAccount: 'steward-metrics',
    keyDisplayName: 'steward-metrics',
    pasteLabel: 'the new metrics API key',
    manualSteps: [
      'Open Temporal Cloud, Settings, API keys, and choose Create API key.',
      'Owner: the steward-metrics service account. Set the expiry to match the duration above.',
      'Copy the key once. Cloud shows it only on creation. The key id sits beside it in the list.',
    ],
    dated: true,
    verify: 'action-usage',
    verifyPlan: 'call the metrics endpoint with the new key, retrying up to two minutes.',
    verifyDone: 'the metrics endpoint answered 200 on the new key',
    readyField: 'actionUsage',
    readyValue: 'configured',
    checkValue: (v) => (/\s/.test(v) ? 'the key contains whitespace' : v.length < 20 ? 'the key is too short to be an API key' : null),
  },
  'healthcheck-base': {
    name: 'healthcheck-base',
    envVar: 'STEWARD_HEALTHCHECK_BASE',
    opItem: 'STEWARD_HEALTHCHECK_BASE',
    railwayVariable: 'STEWARD_HEALTHCHECK_BASE',
    issuer: 'manual',
    pasteLabel: 'the new ping base (https://hc-ping.com/<ping-key>)',
    manualSteps: [
      'Open healthchecks.io, the project Settings page, and regenerate the ping key.',
      'Copy the project ping URL. It reads https://hc-ping.com/<ping-key>, with no trailing slash.',
    ],
    dated: false,
    verify: 'ping-base',
    verifyPlan: "send one /log ping to the new base. It changes no check's state.",
    verifyDone: 'a /log ping to the new base was accepted',
    readyField: 'alerting',
    readyValue: 'configured',
    checkValue: (v) => (/^https:\/\/hc-ping\.com\/[A-Za-z0-9_-]+$/.test(v) ? null : 'expected https://hc-ping.com/<ping-key>, with no trailing slash'),
  },
};

export function credentialNames(): string[] {
  return Object.keys(CREDENTIALS);
}

/**
 * What each `verify` key in the table does with the new value. A verifier throws
 * on failure and returns on success; the runner retries it for two minutes,
 * because a new key answers Access Denied for its first seconds.
 */
export const STEWARD_VERIFIERS: Record<string, (value: string) => Promise<void>> = {
  /** The metrics endpoint answers 200 on the key. `sampleActionUsage` throws with the status otherwise. */
  'action-usage': async (key) => {
    await sampleActionUsage(NAMESPACE, key);
  },
  /** One `/log` ping to the new base. A log ping records an event and changes no check's state. */
  'ping-base': async (base) => {
    const url = `${base.replace(/\/+$/, '')}/${healthCheckSlug('run-shape')}/log`;
    const res = await fetch(url, { method: 'POST', body: 'steward credential rotate: new ping base verified', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`the alerting service answered ${res.status}`);
  },
};
