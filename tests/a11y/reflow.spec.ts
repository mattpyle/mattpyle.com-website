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
 * Every page runs modern at 320 and 375, then retro at 320, 375, 442 and 456.
 * Retro is a real appearance a visitor can select and persist, it restyles the
 * one header and one footer in much wider faces (bold Verdana links, a Comic Sans
 * wordmark), and it has had its own overflows that modern-only rows could not see.
 * Reflow is content-dependent per page, so retro gets the whole matrix rather than
 * one representative page.
 *
 * 320 is the only width 1.4.10 asks about. The other widths bracket the header's
 * link-count breakpoints, because each exists to satisfy a measured font metric —
 * and a metric is exactly the kind of premise that goes stale without anything
 * failing:
 *
 *   375  The three-to-two boundary in SiteHeader.astro: 375 and up puts three
 *        links beside `more`, below it two. Run in BOTH appearances, because the
 *        breakpoint was measured against 13px IBM Plex Mono and retro paints the
 *        same row in bold Verdana. The modern row was added on 2026-08-20 (renaming
 *        Builds to Projects widened the then-current row and quietly broke 360–362);
 *        the retro row on 2026-08-28, when retro stopped having a header of its own
 *        and started sharing this one.
 *   442  Retro, inside what used to be its own header wrap rule. That rule is gone:
 *        it existed because the legacy retro nav put five bold Verdana links on one
 *        row, and the priority-plus header is narrower than that in any face. The
 *        row is kept as coverage of the retro three-link band, not as a bracket.
 *   456  Retro, the far side of the same band. Anything that widens the retro row —
 *        a longer label, different platform metrics — fails here while 320 stays
 *        green, and the answer is a breakpoint change rather than a relaxed row.
 */

const MODERN_WIDTHS = [320, 375] as const;
const RETRO_WIDTHS = [320, 375, 442, 456] as const;

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
  for (const width of MODERN_WIDTHS) {
    test(`${spec.name} (${spec.path}): no horizontal scroll at ${width}px`, async ({ page }) => {
      // Set before the first paint rather than resizing after, for the same reason
      // the retro rows below do: the wrap rules are media queries, and measuring a
      // reflowed-into-place page is not the same as measuring one laid out at this
      // width from the start.
      await page.setViewportSize({ width, height: 720 });
      await gotoSettled(page, spec.path);
      expectNoOverflow(await measure(page), spec.path, width);
    });
  }

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
