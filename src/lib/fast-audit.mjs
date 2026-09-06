/**
 * How this site runs a fast audit, for every surface that runs one.
 *
 * `/mcp` composed this inline until 2026-09-06, when `/audit` became the second surface that has
 * to run a fast audit exactly the way the first one does — same budget, same standalone-activity
 * path, same fallback, same reported `tool.path`. The alternative was a second copy of the
 * composition and of the budget on the page, which is the drift CLAUDE.md names in its own words:
 * a hand-copy on the site that goes silently wrong the day one of them changes. The two surfaces
 * differ in exactly one thing, the tag on their log lines, so that is the one argument this
 * factory takes.
 *
 * Nothing here is new behaviour. The choice between the activity and the function, the arithmetic
 * of the shared budget and the four fallback triggers all live where they always did, in
 * src/lib/mcp-fast-standalone.mjs; this file is the wiring those two routes had in common.
 */

import { runFastAudit } from '@mattpyle/steward/agent-audit/fast';
import { createFastAuditRunner, withPath } from './mcp-fast-standalone.mjs';
import { getClient, readTemporalConfig } from './mcp-temporal.mjs';

/**
 * The audit's whole wall-clock budget, deliberately well under the function's timeout.
 *
 * A slow target must produce an answer that says the audit ran out of time, not a platform 504
 * with no body — an agent can act on the first and can only guess at the second, and a visitor
 * reading a browser error page learns nothing at all. Steward's own default is 120s, which is
 * right for a CLI run and wrong here; the fast tier against a healthy site finishes in a few
 * seconds, and the checks report a spent budget as evidence rather than as a crash (see
 * `BudgetExhaustedError` handling in checks.ts).
 *
 * 45s sits under the 60s floor every Vercel plan has offered, so the margin does not depend on
 * which plan this project is on or on the platform's current default.
 */
export const AUDIT_BUDGET_MS = 45_000;

/**
 * Whether this deployment can reach Temporal at all.
 *
 * Read once at module scope, because the answer is a property of the deployment rather than of a
 * request — the variables are set in Vercel's environment variable store and do not change under a
 * running instance.
 */
export const TEMPORAL_ENABLED = readTemporalConfig() !== null;

/**
 * Builds the `runAudit` a surface calls: `(url, { fresh, origin }) => Promise<AuditResult>`.
 *
 * With a Temporal connection the audit is a standalone `auditSiteFast` on the hosted worker,
 * shared with any other caller asking about the same site in the same UTC hour, and falling back
 * into this function on any of the four triggers. Without one there is nothing to fall back from,
 * so the in-function path is the only path and the document says so rather than leaving
 * `tool.path` absent — "no field" and "ran here" are different facts and only one of them is true.
 *
 * @param {{ log?: (fields: Record<string, string | number>) => void }} options
 */
export function createSiteFastAudit({ log = () => {} } = {}) {
  /**
   * The fast audit, run inside this function. The fallback, and the whole runner on a deployment
   * with no Temporal configuration.
   *
   * `budgetMs` is a parameter rather than the constant because the standalone path hands it what
   * is left of the one budget after a failed attempt — see mcp-fast-standalone.mjs on why a fresh
   * budget there would be a platform 504.
   */
  const inFunction = (url, budgetMs = AUDIT_BUDGET_MS) =>
    runFastAudit(url, { policy: { totalBudgetMs: budgetMs } });

  if (!TEMPORAL_ENABLED) {
    return async (url) => withPath(await inFunction(url), 'function');
  }

  return createFastAuditRunner({
    getClient,
    runInFunction: inFunction,
    budgetMs: AUDIT_BUDGET_MS,
    log,
  });
}
