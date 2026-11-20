import { test, expect, type Page } from '@playwright/test';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';

/**
 * The /about portrait rail pins only while the whole of it fits in the window.
 *
 * AboutBody.astro makes the rail `position: sticky` under a media query,
 * `(min-width: 1001px) and (min-height: 773px)`. A pinned block taller than the window has a
 * bottom that cannot be reached until the reading column ends, and the rail's last line is a
 * link. PostRail.astro measures its own height in script; this rail has a fixed width and a
 * fixed height at the widths where it pins, so it uses a number instead: 773 is the rail's
 * 661px plus the 96px offset and a 16px gutter.
 *
 * Why this check exists. That number is a measurement of the rail's content, and nothing else
 * fails when the rail grows a line. This does: at the threshold the pinned rail's bottom edge
 * must be inside the window, and one pixel shorter the rail must not pin.
 *
 * Both appearances. Retro frames the rail and sets it in smaller faces, so it is shorter there
 * today, and it is the same rule that pins it.
 */

const WIDTH = 1280;
const THRESHOLD = 773;

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

async function goto(page: Page, retro: boolean): Promise<void> {
  if (retro) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('mattpyle:appearance', 'retro');
      } catch {
        /* ignore */
      }
    });
  }
  await gotoSettled(page, '/about/');
  if (retro) await expect(page.locator('html')).toHaveAttribute('data-appearance', 'retro');
}

/** The rail's computed position and, once the page has scrolled far enough to pin it, its box. */
function measure(page: Page) {
  return page.evaluate(async () => {
    const rail = document.querySelector<HTMLElement>('aside.rail');
    if (!rail) throw new Error('no aside.rail on /about');
    window.scrollTo(0, rail.getBoundingClientRect().top + window.scrollY);
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    const rect = rail.getBoundingClientRect();
    return {
      position: getComputedStyle(rail).position,
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: rail.offsetHeight,
      windowHeight: window.innerHeight,
    };
  });
}

for (const retro of [false, true]) {
  const appearance = retro ? 'retro' : 'modern';

  test(`about rail (${appearance}): pinned at ${WIDTH}x${THRESHOLD} with its bottom edge in the window`, async ({ page }) => {
    await page.setViewportSize({ width: WIDTH, height: THRESHOLD });
    await goto(page, retro);
    const rail = await measure(page);
    expect(rail.position, 'the rail pins at the threshold height').toBe('sticky');
    expect(rail.top, 'the pinned rail sits at its 96px offset').toBe(96);
    expect(
      rail.bottom,
      `the pinned rail is ${rail.height}px tall and ends at ${rail.bottom}px in a ${rail.windowHeight}px window. ` +
        'Raise the min-height in AboutBody.astro to the rail height plus 112.',
    ).toBeLessThanOrEqual(rail.windowHeight);
  });

  test(`about rail (${appearance}): not pinned at ${WIDTH}x${THRESHOLD - 1}`, async ({ page }) => {
    await page.setViewportSize({ width: WIDTH, height: THRESHOLD - 1 });
    await goto(page, retro);
    const rail = await measure(page);
    expect(rail.position, 'one pixel under the threshold the rail flows with the page').not.toBe('sticky');
  });
}
