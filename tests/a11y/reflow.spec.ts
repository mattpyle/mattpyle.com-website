import { test, expect, type Page } from '@playwright/test';
import { PAGES } from './helpers/pages';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';

/**
 * WCAG 1.4.10 (reflow): no two-dimensional scrolling at 320 CSS px of width,
 * which is what 1280px at 400% zoom reduces to.
 *
 * The assertion is on the document, not on individual elements: a container that
 * scrolls horizontally on its own is explicitly allowed by 1.4.10 (and this site
 * relies on it — the /webmcp agent snippets must not wrap mid-token). What fails
 * the criterion is the page itself scrolling sideways.
 *
 * Every page runs modern at 320, then retro at 320 and 429. Retro is a real
 * appearance a visitor can select and persist, it restyles the header and footer
 * in much wider faces, and it had its own overflows that modern-only rows could
 * not see (the footer appearance toggle at 320, the nav row up to 429). Reflow is
 * content-dependent per page, so retro gets the whole matrix rather than one
 * representative page.
 *
 * 429 is not a second reflow criterion; 320 is the only width 1.4.10 asks about.
 * It is the exact width retro's unwrapped nav row needs, so it is the width where
 * that row goes from fitting to overflowing: it guards the measured font metric
 * the 440px rule is built on, and fails the day a sixth nav link, a longer label
 * or different metrics push the row past it.
 *
 * Measured, so nobody mistakes it for a regression guard on the fix itself:
 * against the pre-fix retro.css, all nine 320 rows fail and all nine 429 rows
 * pass. The unwrapped row fits 429 to the pixel with or without the wrap rule.
 * The widest width that would have caught the shipped defect is 427 (at 428 the
 * overflow is 1px, inside the tolerance below).
 */

const RETRO_WIDTHS = [320, 429] as const;

test.use({ viewport: { width: 320, height: 720 } });

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

/** Measure document-level horizontal overflow, naming what sticks out. */
function measure(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth;
    const offenders: string[] = [];
    if (doc.scrollWidth > limit + 1) {
      // Name the widest elements that actually stick out, so the failure is
      // actionable rather than "something on this page is too wide".
      for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right <= limit + 1) continue;
        // A scroll container overflowing its own content is fine; only report
        // elements whose own box extends past the viewport.
        const parent = el.parentElement;
        if (parent && parent.scrollWidth > parent.clientWidth + 1) continue;
        offenders.push(
          `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` +
            `${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}` +
            ` right=${Math.round(rect.right)}`,
        );
        if (offenders.length >= 8) break;
      }
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: limit, offenders };
  });
}

function expectNoOverflow(
  result: { scrollWidth: number; clientWidth: number; offenders: string[] },
  label: string,
  width: number,
): void {
  expect(
    result.scrollWidth,
    `${label} scrolls horizontally at ${width}px ` +
      `(scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth}).\n` +
      `Widest offenders:\n${result.offenders.map(o => `  ${o}`).join('\n')}`,
  ).toBeLessThanOrEqual(result.clientWidth + 1);
}

for (const spec of PAGES) {
  test(`${spec.name} (${spec.path}): no horizontal scroll at 320px`, async ({ page }) => {
    await gotoSettled(page, spec.path);
    expectNoOverflow(await measure(page), spec.path, 320);
  });

  for (const width of RETRO_WIDTHS) {
    test(`${spec.name} (${spec.path}): retro, no horizontal scroll at ${width}px`, async ({
      page,
    }) => {
      // Retro is selected the way a visitor selects it, through the persisted
      // preference AppearanceUI reads on boot.
      await page.addInitScript(() => {
        try {
          localStorage.setItem('mattpyle:appearance', 'retro');
        } catch {
          /* ignore */
        }
      });
      // Set before the first paint rather than resizing after: the wrap rules are
      // media queries, and measuring a reflowed-into-place page is not the same
      // as measuring one laid out at this width from the start.
      await page.setViewportSize({ width, height: 720 });
      await gotoSettled(page, spec.path);

      // Assert the appearance genuinely applied before measuring. A retro row that
      // silently rendered modern would pass while checking nothing, which is the
      // same trap the reduced-motion spec guards against for media emulation.
      await expect(page.locator('html')).toHaveAttribute('data-appearance', 'retro');

      expectNoOverflow(await measure(page), `${spec.path} (retro)`, width);
    });
  }
}
