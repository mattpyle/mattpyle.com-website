/**
 * `DD MMM YYYY` — the one date format the redesign uses, everywhere
 * (docs/projects/redesign/design-export/README.md, constraint 6).
 *
 * UTC, not local. Content dates are authored as calendar dates and coerced by
 * Zod to midnight UTC, so reading them back in a local zone west of Greenwich
 * renders the day before. The legacy RecentWriting.astro formatter already does
 * this; this module is the same rule in one place, in the case the design asks
 * for (`04 Aug 2026`, not `04 AUG 2026`).
 *
 * Not to be confused with the "dates are Matt's local date" rule in CLAUDE.md,
 * which governs what date a human WRITES into frontmatter or a vault note. This
 * only reads back what was written.
 */

/**
 * @param {Date} date
 * @returns {string} e.g. `04 Aug 2026`
 */
export function formatSiteDate(date) {
  const day = date.getUTCDate().toString().padStart(2, '0');
  const month = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${day} ${month} ${date.getUTCFullYear()}`;
}

/**
 * Same format from a plain `YYYY-MM-DD` string (the scorecard run `iso` field),
 * without routing it through a Date and risking a timezone shift.
 *
 * @param {string} iso
 * @returns {string}
 */
export function formatIsoDate(iso) {
  const [year, month, day] = iso.split('-');
  const name = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    .toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${day} ${name} ${year}`;
}
