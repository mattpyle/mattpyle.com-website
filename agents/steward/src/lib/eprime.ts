import type { Finding, PassResult } from './report.js';

/**
 * Selecting Vale's E-Prime instances out of an already-resolved fan-out.
 *
 * **Why this is a leaf module with no imports beyond `report.ts`.** The
 * *workflow* calls `selectEprimeFindings` — it has to, because "were there any
 * E-Prime findings?" decides whether the `eprimeAlternativesPass` activity runs
 * at all, and a decision that changes the command sequence must be made from
 * data already in history (design rule 10). That means this module gets loaded
 * inside the workflow sandbox, where `node:fs`, `process.env` and the Anthropic
 * client are all unavailable. Payload construction and response mapping stay in
 * `activities/editorial.ts` for exactly that reason.
 *
 * The selection itself is a pure string filter over activity results, so running
 * it in workflow code is deterministic and replays identically.
 */

/** The Vale rule this pass exists to make useful. */
export const EPRIME_RULE = 'write-good.E-Prime';

/**
 * `valeAlertsToFindings` writes the message as
 * `${alert.Check} (${alert.Severity}): ${alert.Message}`, so the rule name is
 * everything up to the first ` (`. Matching on that boundary rather than with a
 * `startsWith` keeps a hypothetical `write-good.E-Primer` from being swept in.
 */
function checkNameOf(message: string): string {
  const paren = message.indexOf(' (');
  return paren === -1 ? message : message.slice(0, paren);
}

export function isEprimeFinding(finding: Finding): boolean {
  return finding.pass === 'vale' && checkNameOf(finding.message) === EPRIME_RULE;
}

/**
 * Every E-Prime instance Vale found, taken out of the resolved `passes` array.
 *
 * Re-running Vale to get these would be a second spawn of the same binary over
 * the same bytes for the same answer; the fan-out has already paid for it.
 * Returns `[]` when the Vale pass is absent (it may have failed and been
 * replaced by a `toolFailurePass`, whose findings are about the tool rather than
 * about the prose).
 */
export function selectEprimeFindings(passes: PassResult[]): Finding[] {
  const vale = passes.find((p) => p.pass === 'vale');
  if (!vale) return [];
  return vale.findings.filter(isEprimeFinding);
}
