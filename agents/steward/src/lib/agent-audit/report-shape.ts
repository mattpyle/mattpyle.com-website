import type { ReportIntegrity } from './result.js';

/**
 * Whether a finished deep audit is a report about a site or a report about the
 * auditor. **One predicate, two readers.**
 *
 * The 2026-08-15 failure this exists for: a deep audit sampled a page, rendered
 * nothing, and completed carrying a document that read as finished. PR #126
 * removed that particular cause; the class did not go away, because nothing in
 * assembly ever asked whether the browser half had produced anything.
 *
 * Two things now ask, and they must never disagree. `lib/run-health.ts` reads it
 * to decide whether to raise the run-shape alert, and `assembleDeepAudit` reads
 * it to stamp `integrity` on the document `get_audit` serves. An alert that fires
 * on a report calling itself clean is worse than either signal alone: it is two
 * systems telling the operator different things about one run. So the rule lives
 * here, in one function, and both import it.
 *
 * Deliberately not in `run-health.ts` itself, which is about alerting and knows
 * about ping slugs and credential expiry. The shape of a report is a fact about
 * the audit; the alert is one consumer of it.
 */

/**
 * **Zero rendered pages of a nonzero sample.**
 *
 * A sample of zero is explicitly not a defect: a small site, or one whose
 * robots.txt refuses this auditor, legitimately has nothing to render, and the
 * report says so through `not-applicable` checks. Zero rendered from a sample the
 * run itself chose means the browser half produced nothing while the document
 * still reads as complete.
 */
export function renderedNothing(sampled: number, rendered: number): boolean {
  return sampled > 0 && rendered === 0;
}

/**
 * The document's own verdict on itself, from the same predicate.
 *
 * `reason` is written for a stranger reading a report through an MCP client with
 * no other context, which is the whole population the public deep tier serves: it
 * has to say what is missing and that the fetch-based half is unaffected, because
 * a reader told only "degraded" will either discard a report that is three
 * quarters good or trust the empty quarter.
 */
export function reportIntegrity(input: { sampled: number; rendered: number }): ReportIntegrity {
  if (!renderedNothing(input.sampled, input.rendered)) {
    return { status: 'clean' };
  }
  return {
    status: 'degraded',
    reason:
      `0 of ${input.sampled} sampled page(s) were rendered, so every rendered-experience check in ` +
      'this report is an error rather than a measurement. The fetch-based checks above it are ' +
      'unaffected and can be read normally. Re-running the audit is worth a try; if it degrades ' +
      "again, the browser half of the auditor is what is broken, not the audited site.",
  };
}
