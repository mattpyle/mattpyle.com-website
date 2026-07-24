/**
 * The single source of truth for the site's appearance switch (modern | retro).
 *
 * Both triggers — the footer toggle button and the `set_appearance` WebMCP tool
 * (src/lib/webmcp-tools.mjs) — call setAppearance(). There is no second code path.
 *
 * Client-local only: state lives in localStorage and on <html data-appearance>.
 * Nothing here ever fetches or writes to a server, so flipping retro changes only
 * the calling browser's own view.
 *
 * STORAGE_KEY is duplicated (by necessity, not drift) in the tiny pre-paint inline
 * script in src/layouts/Layout.astro — that script can't import an ES module and
 * still run early enough to block paint. Keep the two in sync.
 */

export const APPEARANCES = ['modern', 'retro'];
export const DEFAULT_APPEARANCE = 'modern';
export const STORAGE_KEY = 'mattpyle:appearance';
export const APPEARANCE_CHANGE_EVENT = 'appearance:change';

/** @param {string} [value] */
function resolve(value) {
  return APPEARANCES.includes(value) ? value : DEFAULT_APPEARANCE;
}

/** Read the persisted appearance, defaulting to modern on any failure. */
export function getAppearance() {
  try {
    return resolve(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** @param {string} mode */
function applyAttribute(mode) {
  if (mode === DEFAULT_APPEARANCE) {
    delete document.documentElement.dataset.appearance;
  } else {
    document.documentElement.dataset.appearance = mode;
  }
}

/**
 * Validate, apply, persist, and announce an appearance change.
 * Invalid input resolves to modern rather than failing.
 *
 * @param {string} mode
 * @returns {string} the resolved mode that was actually applied
 */
export function setAppearance(mode) {
  const resolved = resolve(mode);
  applyAttribute(resolved);
  try {
    localStorage.setItem(STORAGE_KEY, resolved);
  } catch {
    // Storage unavailable (private mode, quota, etc.) — the attribute is still
    // applied for this page view; it just won't persist. Degrade, don't throw.
  }
  document.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT, { detail: { mode: resolved } }));
  return resolved;
}

// ClientRouter soft nav re-runs page scripts on astro:page-load but doesn't
// reload the document, so re-apply the persisted appearance every time to
// survive navigation without a flash of the other mode.
if (typeof document !== 'undefined') {
  document.addEventListener('astro:page-load', () => {
    applyAttribute(getAppearance());
  });
}
