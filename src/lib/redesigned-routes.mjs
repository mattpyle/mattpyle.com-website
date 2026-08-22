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
 * is the point: converting /writing did not have to re-verify /scorecard.
 *
 * WHEN THE LAST SURFACE CONVERTS, DELETE THIS MODULE. The flag, the legacy
 * tokens in global.css, and the legacy Nav/Footer components all go together;
 * a permanently-half-true flag is worse than either end state.
 */

/** Trailing-slash canonical form, matching the hrefs in the nav. */
const REDESIGNED = new Set(['/', '/writing/', '/projects/', '/changelog/', '/about/', '/steward/']);

/**
 * Whole subtrees, for a template that converts every one of its pages at once.
 * `/writing/` and `/changelog/` are listed above as well: the prefix covers the
 * pages under each — posts, and the changelog's entries plus its paginated
 * pages at /changelog/2 and beyond — and the index itself is an exact match
 * rather than a prefix so that adding an entry template here can never silently
 * convert an index that has not been rebuilt.
 *
 * `/projects/` is an exact match with no prefix: it has no pages beneath it.
 */
const REDESIGNED_PREFIXES = ['/writing/', '/changelog/'];

/**
 * @param {string} pathname
 * @returns {boolean}
 */
export function isRedesignedRoute(pathname) {
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  if (REDESIGNED.has(path)) return true;
  return REDESIGNED_PREFIXES.some(prefix => path.startsWith(prefix));
}
