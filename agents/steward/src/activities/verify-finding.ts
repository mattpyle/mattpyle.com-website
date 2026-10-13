import { ApplicationFailure } from '@temporalio/activity';
import { AUDIT_USER_AGENT } from '../lib/agent-audit/safe-fetch.js';
import { openChromeProbe } from '../lib/chrome-probe.js';
import { log } from '../lib/logger.js';
import { CheckBroken, runChecks, type CheckRunner, type VerifyCheck, type VerifyCheckResult } from '../lib/verify-checks.js';

/**
 * `runFindingChecks`: a handoff's `verify` block, measured against production.
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
 */

export interface RunFindingChecksInput {
  key: string;
  checks: VerifyCheck[];
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
  let results: VerifyCheckResult[];
  try {
    results = await runChecks(input.checks, {
      fetch,
      openProbe: () => openChromeProbe({ userAgent: AUDIT_USER_AGENT }),
      userAgent: AUDIT_USER_AGENT,
      ...runner,
    });
  } catch (err) {
    if (err instanceof CheckBroken) throw ApplicationFailure.nonRetryable(err.message, 'VerifyCheckBroken');
    throw err;
  }
  const passed = results.every((row) => row.pass);
  log.info(
    { activity: 'runFindingChecks', key: input.key, passed, failed: results.filter((row) => !row.pass).map((row) => row.n) },
    'finding checks ran',
  );
  return { ranAt: new Date().toISOString(), passed, results };
}
