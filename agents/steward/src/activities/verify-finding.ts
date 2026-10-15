import { ApplicationFailure } from '@temporalio/activity';
import { AUDIT_USER_AGENT } from '../lib/agent-audit/safe-fetch.js';
import { openChromeProbe } from '../lib/chrome-probe.js';
import { log } from '../lib/logger.js';
import {
  CheckBroken,
  bypassFetch,
  onOrigin,
  runChecks,
  type CheckRunner,
  type VerifyCheck,
  type VerifyCheckResult,
} from '../lib/verify-checks.js';

/**
 * `runFindingChecks`: a `verify` block, measured against production, or against
 * a fixer PR's Vercel preview.
 *
 * Steward's own code does every measurement: `fetch` for `status`, `header`,
 * `text` and `markdown`, the worker's Chromium for `selector` and `js`. A block
 * is data, and nothing in it is spawned.
 *
 * **A failed check is a row, not a failure.** "The fix did not take" is what
 * the workflow writes down. The activity throws only when a check could not be
 * measured (production answered 5xx or not at all, which the retry policy
 * retries) or when a check's own expression does not run (`VerifyCheckBroken`,
 * which no retry mends).
 *
 * **On a preview** each check's production origin is swapped for the preview's,
 * and every request to the preview carries Vercel's Protection Bypass for
 * Automation secret. The secret is read here, from the worker's
 * `VERCEL_AUTOMATION_BYPASS_SECRET`, and goes nowhere but those requests: not
 * into the input, the result or a log line. A worker without it fails the
 * activity as `PreviewBypassMissing`.
 */

/** The worker environment variable that holds the bypass secret, under the name Vercel uses. */
export const BYPASS_SECRET_ENV = 'VERCEL_AUTOMATION_BYPASS_SECRET';

export interface RunFindingChecksInput {
  key: string;
  /** The block as validated, on the production origin. */
  checks: VerifyCheck[];
  /** A preview origin to run the block against instead of production. */
  previewOrigin?: string;
}

export interface RunFindingChecksResult {
  /** ISO 8601, when the checks finished. The Verification section's date. */
  ranAt: string;
  passed: boolean;
  results: VerifyCheckResult[];
}

export async function runFindingChecks(
  input: RunFindingChecksInput,
  /** Replaced by the tests, which have no browser and a mock origin. */
  runner: Partial<CheckRunner> = {},
): Promise<RunFindingChecksResult> {
  let checks = input.checks;
  let preview: Partial<CheckRunner> = {};
  if (input.previewOrigin) {
    const secret = process.env[BYPASS_SECRET_ENV];
    if (!secret) {
      throw ApplicationFailure.nonRetryable(
        `${BYPASS_SECRET_ENV} is not set on the worker, so the preview cannot be fetched past Vercel Authentication.`,
        'PreviewBypassMissing',
      );
    }
    const bypass = { origin: input.previewOrigin, secret };
    checks = onOrigin(checks, input.previewOrigin);
    preview = {
      fetch: bypassFetch(input.previewOrigin, secret, runner.fetch ?? fetch),
      openProbe: runner.openProbe ?? (() => openChromeProbe({ userAgent: AUDIT_USER_AGENT, bypass })),
    };
  }
  let results: VerifyCheckResult[];
  try {
    results = await runChecks(checks, {
      fetch,
      openProbe: () => openChromeProbe({ userAgent: AUDIT_USER_AGENT }),
      userAgent: AUDIT_USER_AGENT,
      ...runner,
      ...preview,
    });
  } catch (err) {
    if (err instanceof CheckBroken) throw ApplicationFailure.nonRetryable(err.message, 'VerifyCheckBroken');
    throw err;
  }
  const passed = results.every((row) => row.pass);
  log.info(
    {
      activity: 'runFindingChecks',
      key: input.key,
      on: input.previewOrigin ?? 'production',
      passed,
      failed: results.filter((row) => !row.pass).map((row) => row.n),
    },
    'finding checks ran',
  );
  return { ranAt: new Date().toISOString(), passed, results };
}
