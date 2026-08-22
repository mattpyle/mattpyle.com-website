/**
 * Which routes have been rebuilt to the redesign (docs/projects/redesign/design-export/README.md).
 *
 * The redesign converts the site one surface at a time on the `redesign`
 * integration branch and lands on production in ONE merge, so mid-branch the
 * site legitimately carries two type systems at once. This set is what keeps
 * them apart: Layout.astro reads it to decide three things per page —
 *
 *   1. `skin-redesign` on <body>, which arms the redesign base rules and tokens
 *      in src/styles/global.css;
 *   2. which header and footer markup renders (the redesigned pair, plus the
 *      legacy pair kept in the DOM for retro, versus the legacy pair alone);
 *   3. which fonts are preloaded, so an unconverted page does not pay for three
 *      typefaces it never paints.
 *
 * An unconverted route is byte-identical to what it was before the branch. That
 * is the point: converting /writing does not have to re-verify /scorecard.
 *
 * WHEN THE LAST SURFACE CONVERTS, DELETE THIS MODULE. The flag, the legacy
 * tokens in global.css, and the legacy Nav/Footer components all go together;
 * a permanently-half-true flag is worse than either end state.
 */

/** Trailing-slash canonical form, matching the hrefs in the nav. */
const REDESIGNED = new Set(['/']);

/**
 * @param {string} pathname
 * @returns {boolean}
 */
export function isRedesignedRoute(pathname) {
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return REDESIGNED.has(path);
}
