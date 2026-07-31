import { test, expect } from '@playwright/test';
import { PAGES } from './helpers/pages';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';
import { markTabbables, tabbablesInsideAriaHidden, walk, formatStops } from './helpers/keyboard';

/**
 * WCAG 2.1.1 (keyboard), 2.1.2 (no keyboard trap), 2.4.3 (focus order).
 *
 * Nothing here is snapshotted. The expectation is derived from the page's own DOM
 * on every run, so the check asserts a relationship rather than a fixture, and a
 * new post or changelog entry cannot break it.
 */

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

for (const spec of PAGES) {
  test.describe(`${spec.name} (${spec.path})`, () => {
    test.describe.configure({ mode: 'parallel' });

    test('sequential focus order matches DOM order and reaches every control', async ({ page }) => {
      await gotoSettled(page, spec.path);
      const expected = await markTabbables(page);
      expect(expected.length, `${spec.path} has no tabbable elements`).toBeGreaterThan(0);

      const stops = await walk(page, expected.length);

      // Every press must move focus to the next element in DOM order. A press
      // that lands on the same index twice is a trap; a press that lands out of
      // order is a focus-order defect; a null is focus escaping the document
      // before the last control was reached, i.e. an unreachable control.
      expect(
        stops.map(s => s.idx),
        `Tab order on ${spec.path} diverged from DOM order.\nGot:\n${formatStops(stops)}\n` +
          `Expected DOM order:\n${expected.map(e => `  ${e.idx}: ${e.label}`).join('\n')}`,
      ).toEqual(expected.map(e => e.idx));
    });

    test('shift-tab retraces the same order in reverse with no trap', async ({ page }) => {
      await gotoSettled(page, spec.path);
      const expected = await markTabbables(page);

      // Walk forward to the last control first, so the backward walk starts from
      // a known end rather than from wherever a wrap-around put us.
      await walk(page, expected.length);
      const back = await walk(page, expected.length - 1, true);

      const wanted = expected
        .slice(0, -1)
        .map(e => e.idx)
        .reverse();

      expect(
        back.map(s => s.idx),
        `Shift+Tab order on ${spec.path} is not the reverse of Tab order.\nGot:\n${formatStops(back)}`,
      ).toEqual(wanted);
    });

    test('nothing in the tab order is hidden from assistive tech', async ({ page }) => {
      await gotoSettled(page, spec.path);
      await markTabbables(page);
      const offenders = await tabbablesInsideAriaHidden(page);
      expect(
        offenders,
        `Tabbable elements inside aria-hidden="true" on ${spec.path}: a keyboard ` +
          `user can reach them and a screen-reader user cannot (WCAG 4.1.2).`,
      ).toEqual([]);
    });

    test('the skip link is the first stop and moves focus into main', async ({ page }) => {
      await gotoSettled(page, spec.path);
      await page.keyboard.press('Tab');

      const first = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          className: el?.className ?? '',
          href: el?.getAttribute('href') ?? '',
          text: (el?.textContent ?? '').trim(),
        };
      });
      expect(first.className, `First Tab stop on ${spec.path} is not the skip link`).toContain(
        'skip-link',
      );
      expect(first.href).toBe('#main');

      // A skip link that is focusable but visually parked off-screen is useless;
      // it has to come back into the viewport when focused. Polled, not read once:
      // .skip-link slides in over a 150ms `top` transition, so an immediate read
      // catches it mid-flight and reports a defect that is not there.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const el = document.activeElement as HTMLElement;
              return el.getBoundingClientRect().top;
            }),
          { message: 'Focused skip link never came back into the viewport' },
        )
        .toBeGreaterThanOrEqual(0);

      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp('#main$'));
    });
  });
}
