import { test, expect } from '@playwright/test';
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
 */

test.use({ viewport: { width: 320, height: 720 } });

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

for (const spec of PAGES) {
  test(`${spec.name} (${spec.path}): no horizontal scroll at 320px`, async ({ page }) => {
    await gotoSettled(page, spec.path);

    const result = await page.evaluate(() => {
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

    expect(
      result.scrollWidth,
      `${spec.path} scrolls horizontally at 320px ` +
        `(scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth}).\n` +
        `Widest offenders:\n${result.offenders.map(o => `  ${o}`).join('\n')}`,
    ).toBeLessThanOrEqual(result.clientWidth + 1);
  });
}
