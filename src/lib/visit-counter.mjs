/**
 * The 1997 hit counter, told the truth.
 *
 * A static host has no server-side count, and a fabricated one would be the single most dishonest
 * pixel on a site whose whole premise is that its claims are measurable. So this counts what it
 * can actually observe: how many times THIS browser has loaded the homepage. The caption on the
 * counter says exactly that.
 *
 * Client-local, same rules as the appearance switch and the guest book: localStorage only, no
 * fetch, no server, no other visitor.
 *
 * NO TOP-LEVEL SIDE EFFECTS — this file is reachable from the build-time import chain.
 */

export const VISITS_STORAGE_KEY = 'mattpyle:visits';

/** Six digits, zero-padded. Fixed width is what keeps the counter from shifting layout when
 *  the script replaces the server-rendered value on load. */
export const VISIT_DIGITS = 6;

/** @param {number} count */
export function formatVisits(count) {
  return String(Math.max(1, Math.min(count, 10 ** VISIT_DIGITS - 1))).padStart(VISIT_DIGITS, '0');
}

/** The count as it stands, without incrementing. Any failure reads as a first visit. */
export function readVisits() {
  try {
    const parsed = Number.parseInt(localStorage.getItem(VISITS_STORAGE_KEY) ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Record this page view and return the new count. A browser with storage blocked always sees 1,
 * which is true for it: nothing it did was remembered.
 */
export function recordVisit() {
  const next = readVisits() + 1;
  try {
    localStorage.setItem(VISITS_STORAGE_KEY, String(next));
  } catch {
    // Storage unavailable. Degrade to an honest 1, do not throw.
  }
  return next;
}
