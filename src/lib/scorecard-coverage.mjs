/**
 * Does the published run still cover the whole site?
 *
 * `/scorecard` prints a run's `Scope` ("22 live pages") beside its scores. Both
 * are true of the site the run measured. Ship a page after that run and the two
 * stop describing the same site: the scores are still published as current, now
 * verified against a set that excludes the newest page. The audit opens a PR the
 * next time it runs, so the record self-corrects; this covers the window before
 * that happens.
 *
 * The scope string is the only machine-readable page count a run carries
 * (`src/data/scorecard-runs.json`, written by the steward audit). Runs before
 * 2026-07-23 counted "5 live page types", a different unit, and the pattern
 * below deliberately does not match them: no count, no claim.
 *
 * Steward parses the same field with its own, looser pattern in
 * `agents/steward/src/lib/scorecard-aggregate.ts` (a leading integer, whatever
 * the unit). The two disagree on purpose. Steward is summarising its own runs
 * and knows what it measured; this makes a public claim about the current site
 * and must decline when the unit is not pages. Do not unify them without
 * deciding which behaviour the public page should have.
 *
 * It compares counts, not sets. Remove one page and ship another between runs
 * and the counts match while the audited set does not; catching that needs the
 * run to record which URLs it visited, which it does not today.
 */

// "22 live pages" and "19 live pages, excluding drafts" count pages. "5 live page types" counts
// something else and must not match, which is why the unit has to END here rather than merely
// appear: `\b` after "page" is satisfied by the space in front of "types".
const LIVE_PAGES_SCOPE = /^(\d+)\s+live pages?\s*(?:[,.;]|$)/;

/**
 * The number of pages a run's scope claims, or null when the scope does not
 * state one in pages.
 *
 * @param {string | undefined} scope
 * @returns {number | null}
 */
export function runPageCount(scope) {
  const match = LIVE_PAGES_SCOPE.exec(String(scope ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * The sentence `/scorecard` adds when the run covers fewer pages than the site
 * now has, and null when it does not.
 *
 * Null covers three cases on purpose, because none of them is a coverage gap:
 * the counts match, the run covers more pages than the site does now (a page was
 * removed — the run is broader than the site, not narrower), and the scope has
 * no page count to compare.
 *
 * @param {string | undefined} scope the published run's scope
 * @param {number} livePageCount pages the site publishes now
 * @returns {string | null}
 */
export function describeCoverageGap(scope, livePageCount) {
  const covered = runPageCount(scope);
  if (covered === null || !Number.isInteger(livePageCount)) return null;
  if (covered >= livePageCount) return null;

  const uncovered = livePageCount - covered;
  // "not in this run's scope" rather than "shipped since this run": a page shipping after the run
  // is the usual cause and not the only one — a targeted `--urls` audit produces a smaller scope
  // too — and the page must not assert a cause it cannot see from a count.
  return `Covers ${covered} of the site's ${livePageCount} current pages. ` +
    `The other ${uncovered === 1 ? 'one is' : `${uncovered} are`} not in this run's scope.`;
}
