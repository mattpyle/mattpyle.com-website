import { test, expect } from '@playwright/test';
import { PAGES } from './helpers/pages';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';

/**
 * Nothing may transition itself on load.
 *
 * This is a measurement guard as much as a design one. Pages here ship their
 * controls `disabled` and enable them in an `astro:page-load` handler; if the
 * enabled and disabled states differ in a transitioned property, the swap
 * animates. Two things follow, and the second is the one that bit us:
 *
 *   1. The page visibly animates on load for no reason. No user asked for it.
 *   2. Any tool sampling computed style during those milliseconds reads a blend
 *      of the two states. On /webmcp that meant axe scoring a run button's
 *      near-white label against a background still part page-coloured, and
 *      reporting a colour-contrast violation for a pair the page never paints.
 *      It failed the axe job intermittently, on site code the PR never touched,
 *      and passed on re-run. See docs/work/webmcp-axe-contrast-flake.md.
 *
 * The reduced-motion spec does not cover this: it reads computed style at rest,
 * so a transition that only ever runs during the load swap is invisible to it.
 * This check listens for the event instead, from an init script installed before
 * the page's own scripts run, and asserts nothing fired.
 *
 * Transitions only, not animations: a looping decorative animation (the retro
 * marquee, the output-block cursor) is a deliberate, steady-state thing that the
 * reduced-motion spec already governs. A transition with no input behind it is
 * always an accident.
 *
 * Modern appearance only. The load swap is driven by shared scripts, not by the
 * stylesheet, so retro would exercise the same code path against a second set of
 * colours; reflow is the check that pays for the both-appearances matrix.
 */

declare global {
  interface Window {
    __loadTransitions?: string[];
  }
}

/** Longer than the site's longest transition (.15s) plus a frame of slack. */
const QUIET_MS = 400;

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
  await page.addInitScript(() => {
    window.__loadTransitions = [];
    document.addEventListener(
      'transitionstart',
      event => {
        const target = event.target;
        const description =
          target instanceof Element
            ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}` +
              (typeof target.className === 'string' && target.className
                ? `.${target.className.trim().split(/\s+/).join('.')}`
                : '')
            : String(target);
        window.__loadTransitions?.push(`${description} { ${event.propertyName} }`);
      },
      // Capture: transitionstart does bubble, but a listener on the document in
      // the bubble phase can be beaten by a handler that stops propagation.
      true,
    );
  });
});

for (const spec of PAGES) {
  test(`${spec.name} (${spec.path}): nothing transitions itself on load`, async ({ page }) => {
    await gotoSettled(page, spec.path);
    // gotoSettled returns on astro:page-load, which is when the enable swap
    // happens. The transition it would start runs AFTER that, so give the page
    // its full transition budget before reading.
    await page.waitForTimeout(QUIET_MS);

    const fired = await page.evaluate(() => window.__loadTransitions ?? []);
    const unique = [...new Set(fired)];
    expect(
      unique,
      `${spec.path} animated itself on load, with no user input:\n${unique.map(f => `  ${f}`).join('\n')}`,
    ).toEqual([]);
  });
}
