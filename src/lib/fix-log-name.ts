/**
 * The fix log's name, path and the one word whose wording is still open. Kept apart from
 * `fix-log.ts` so the footer can import them without pulling the content layer into every page.
 * The name may change, so every page reads it from here.
 */
export const FIX_LOG = {
  name: 'Fix log',
  path: '/fix-log/',
  description: 'Problems on this site that its agents found, and the fixes they made, each with a before and an after.',
} as const;

/** The visible word beside a fix's type in the rail. Matt has not ruled on it. */
export const FIX_AREA_LABEL = 'area';

/** The visible word beside a fix's date in the rail. */
export const FIX_DATE_LABEL = 'fixed';
