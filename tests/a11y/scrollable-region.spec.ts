import { test, expect, type Page } from '@playwright/test';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';
import { RETRO_ROUTES } from '../../scripts/lib/retro-routes.mjs';

/**
 * WCAG 2.1.1 (keyboard): every region that scrolls horizontally can be reached and
 * scrolled by keyboard. This is axe's `scrollable-region-focusable` rule (serious),
 * measured directly rather than through axe, at the one width the failures appear at.
 *
 * Why this check exists. The reflow spec already runs 320px, but it asserts the
 * opposite thing: that the DOCUMENT does not scroll sideways. A `pre` that scrolls on
 * its own satisfies reflow by design — that is how a code block avoids wrapping
 * mid-token — and is a keyboard trap in reverse: content only a mouse or a touch drag
 * can reach. The axe runs in CI are the other half of the gap, because they audit at
 * 1280px, and a code line that fits there overflows at 320. So a serious failure sat on
 * three pages for weeks while the suite reported Accessibility 100, and an external
 * reviewer found it. See docs/reference/a11y-manual-checks-suite.md.
 *
 * Why measurement rather than a second axe row. axe reports the rule fine, but only for
 * the elements that happen to overflow at the viewport it is given, and its output says
 * nothing about how close the others are. Reading `scrollWidth` against `clientWidth`
 * over every element whose computed `overflow-x` can scroll is the same predicate axe
 * applies, in a check that names the element, its widths and the page in the failure
 * message, and costs one page load rather than an axe injection per route.
 *
 * Both appearances, because retro restyles code blocks in a different mono face at a
 * different size: a block that fits in JetBrains Mono can overflow in the retro face,
 * and the reverse. Retro is selected the way a visitor selects it, through the persisted
 * preference, before the first paint.
 *
 * Tagged @axe so it joins the workflow's GATING step rather than the advisory guard. It
 * asserts a serious WCAG failure with a deterministic measurement, and the failure it
 * was written for blocks Steward's own review gate — an advisory red would be a second
 * report of a problem already known rather than a stop.
 */

/**
 * The routes measured: the eleven the retro axe scan already covers, plus the WebMCP
 * how-to, whose five code blocks are the post that made this check necessary and which
 * no other row reaches (the writing rows use `accessibility-and-ai` as the template
 * fixture).
 */
const ROUTES = [...RETRO_ROUTES, '/writing/how-to-implement-webmcp-on-a-website/'];

interface Offender {
  /** A selector-ish description: tag, id and classes, enough to find the element. */
  where: string;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Every element that scrolls horizontally at this viewport and cannot be reached by
 * keyboard.
 *
 * The pass condition mirrors axe's: the element itself is focusable, or it contains
 * focusable content, which gives a keyboard user a way to bring the overflow into view.
 * `tabIndex >= 0` covers both the natively focusable elements (a link inside a scrolling
 * table) and an explicit `tabindex="0"`.
 */
function findUnreachable(page: Page): Promise<Offender[]> {
  return page.evaluate(() => {
    const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]';
    const offenders: { where: string; scrollWidth: number; clientWidth: number }[] = [];

    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
      // One pixel of slack, the same tolerance the reflow spec uses: sub-pixel layout
      // rounding produces a scrollWidth one larger than clientWidth on boxes that do
      // not actually scroll.
      if (el.scrollWidth <= el.clientWidth + 1) continue;

      if (el.tabIndex >= 0) continue;
      const focusableChild = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).some(
        child => child.tabIndex >= 0,
      );
      if (focusableChild) continue;

      const classes =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).join('.')}`
          : '';
      offenders.push({
        where: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes}`,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      });
    }
    return offenders;
  });
}

function expectAllReachable(offenders: Offender[], label: string): void {
  expect(
    offenders.map(o => o.where),
    `${label}: ${offenders.length} horizontally scrollable region(s) cannot be reached by ` +
      `keyboard. Give each one tabindex="0" (the shared :focus-visible rule already draws ` +
      `the ring), or make its content wrap.\n` +
      offenders
        .map(o => `  ${o.where} (scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth})`)
        .join('\n'),
  ).toEqual([]);
}

test.use({ viewport: { width: 320, height: 720 } });

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

for (const path of ROUTES) {
  test(
    `${path}: every scrollable region is keyboard-reachable at 320px`,
    { tag: '@axe' },
    async ({ page }) => {
      await gotoSettled(page, path);
      expectAllReachable(await findUnreachable(page), path);
    },
  );

  test(
    `${path}: retro, every scrollable region is keyboard-reachable at 320px`,
    { tag: '@axe' },
    async ({ page }) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem('mattpyle:appearance', 'retro');
        } catch {
          /* ignore */
        }
      });
      await gotoSettled(page, path);
      // A retro row that silently rendered modern would pass while measuring the wrong
      // appearance, the same trap the reflow and axe-retro specs guard against.
      await expect(page.locator('html')).toHaveAttribute('data-appearance', 'retro');
      expectAllReachable(await findUnreachable(page), `${path} (retro)`);
    },
  );
}
