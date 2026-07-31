import { test, expect } from '@playwright/test';
import { PAGES } from './helpers/pages';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';

/**
 * WCAG 2.3.3 (animation from interactions) and the spirit of 2.2.2.
 *
 * Emulates `prefers-reduced-motion: reduce` and asserts that nothing is left with
 * a running animation or a perceptible transition. global.css carries a blanket
 * `*` rule that clamps both to .01ms; this check is what keeps that rule honest
 * when a component ships its own `!important` or an inline animation.
 *
 * Retro mode gets its own row: that is where the actual motion lives (the marquee
 * strip, the animated dividers, the nav flourish), and retro.css has a separate
 * reduced-motion block that could drift from global.css's.
 *
 * The emulation is applied imperatively with page.emulateMedia() and then VERIFIED,
 * on purpose. The declarative `test.use({ reducedMotion: 'reduce' })` silently does
 * not reach the browser context in Playwright 1.62.1 — matchMedia keeps reporting
 * false — which makes the whole check pass while measuring nothing. A media-emulation
 * check that does not assert its own emulation is a green light with no bulb in it.
 */

const THRESHOLD_SECONDS = 0.05;

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function assertEmulationApplied(page: import('@playwright/test').Page): Promise<void> {
  const matches = await page.evaluate(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  expect(matches, 'prefers-reduced-motion emulation did not reach the page').toBe(true);
}

const COLLECT = (threshold: number) => {
  const offenders: string[] = [];
  const describe = (el: Element, pseudo: string) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` +
    `${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}${pseudo}`;

  const longest = (value: string) =>
    Math.max(...value.split(',').map(part => parseFloat(part) || 0));

  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const pseudo of ['', '::before', '::after']) {
      const cs = getComputedStyle(el, pseudo || undefined);
      if (cs.animationName !== 'none' && longest(cs.animationDuration) > threshold) {
        offenders.push(`${describe(el, pseudo)} animation ${cs.animationName} ${cs.animationDuration}`);
      }
      if (longest(cs.transitionDuration) > threshold) {
        offenders.push(
          `${describe(el, pseudo)} transition ${cs.transitionProperty} ${cs.transitionDuration}`,
        );
      }
      if (offenders.length >= 10) return offenders;
    }
  }
  return offenders;
};

for (const spec of PAGES) {
  test(`${spec.name} (${spec.path}): reduced motion is honoured`, async ({ page }) => {
    await gotoSettled(page, spec.path);
    await assertEmulationApplied(page);
    const offenders = await page.evaluate(COLLECT, THRESHOLD_SECONDS);
    expect(
      offenders,
      `${spec.path} still animates under prefers-reduced-motion:\n${offenders.map(o => `  ${o}`).join('\n')}`,
    ).toEqual([]);
  });
}

test('retro mode homepage honours reduced motion', async ({ page }) => {
  // The marquee, dividers and nav flourish only exist in retro; retro.css carries
  // its own reduced-motion block, so global.css passing proves nothing here.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mattpyle:appearance', 'retro');
    } catch {
      /* ignore */
    }
  });
  await gotoSettled(page, '/');
  await assertEmulationApplied(page);
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'retro');

  const offenders = await page.evaluate(COLLECT, THRESHOLD_SECONDS);
  expect(
    offenders,
    `Retro homepage still animates under prefers-reduced-motion:\n${offenders.map(o => `  ${o}`).join('\n')}`,
  ).toEqual([]);
});
