/**
 * The pre-paint appearance script, as source text rather than as code.
 *
 * This exists so exactly one string is both rendered into <head> (by
 * src/layouts/Layout.astro, via `set:html`) and hashed into the CSP (by
 * astro.config.mjs). Astro does not hash `is:inline` scripts — head or body,
 * `is:inline` means "emit these bytes untouched", and untouched includes
 * leaving them out of the hash list — so the hash has to be computed here.
 * Deriving it from this constant is what stops an edit to the script from
 * silently reintroducing a CSP refusal: change the string and the hash moves
 * with it.
 *
 * It has to be a classic inline script (not a module, not deferred) to run
 * before the render-blocking stylesheets are applied, which is the only reason
 * a returning retro visitor doesn't see a flash of modern. That rules out
 * importing appearance.mjs at runtime, so the constants are interpolated in at
 * build time instead — same source of truth, resolved a phase earlier.
 *
 * Behaviour matches applyAttribute() in appearance.mjs: a stored non-default
 * appearance sets the attribute, anything else (including the default, junk,
 * or unreadable storage) leaves <html> alone.
 */

import { APPEARANCES, DEFAULT_APPEARANCE, STORAGE_KEY } from './appearance.mjs';

const NON_DEFAULT_APPEARANCES = APPEARANCES.filter((mode) => mode !== DEFAULT_APPEARANCE);

export const PRE_PAINT_APPEARANCE_SCRIPT = `(function () {
  try {
    var mode = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    if (${JSON.stringify(NON_DEFAULT_APPEARANCES)}.indexOf(mode) !== -1) {
      document.documentElement.dataset.appearance = mode;
    }
  } catch (e) {}
})();`;
