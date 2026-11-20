import { test, expect, type Page } from '@playwright/test';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';
import { CHANGELOG_ENTRY } from './helpers/pages';

/**
 * A tapped row looks the same after the tap as before it.
 *
 * A touch browser has no pointer to move away, so it applies `:hover` to the last element tapped
 * and keeps it until the next tap elsewhere. A hover rule outside `@media (hover: hover)` then
 * paints a row that looks selected: the owner saw the Bluesky row on /about stay tinted after
 * he came back from the tab it opened.
 *
 * Why this check exists. `tests/hover-guard.test.mjs` reads the source and fails on a hover rule
 * outside the media query. This is the same promise measured in a browser: with touch emulation
 * Chromium reports `(hover: hover)` as false and still matches `:hover` on the tapped element,
 * which is the state a phone is in. The check asserts both, so it fails loudly if the emulation
 * stops behaving like a phone, and then compares the painted properties.
 *
 * The project card is the exception. Its hover rule moves it, and Chromium answers a moved layer
 * by hit-testing the emulated mouse again, away from the tap, so the card loses `:hover` within a
 * frame and a paint comparison would pass with the rule in effect. Every row therefore gets a
 * second measurement that needs no hover at all: the stylesheets the page loaded hold no hover
 * rule for the row, or anything inside it, that is live on this device.
 *
 * The rows carry no pressed style of their own. A touch browser draws its own tap highlight while
 * a finger is down, and a second tint under `:active` showed as two effects on a real phone.
 *
 * Both appearances. Retro repaints the same rows from `src/styles/retro.css` with hover rules of
 * its own, so a row can be clean in one appearance and stick in the other.
 */

test.use({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 839 } });

const ROWS = [
  { name: 'reach row', path: '/about/', selector: '.reach-card', holdsHover: true },
  { name: 'rail link', path: '/about/', selector: '.rail-value a', holdsHover: true },
  { name: 'list row', path: '/writing/', selector: '.row', holdsHover: true },
  { name: 'entry step', path: `/changelog/${CHANGELOG_ENTRY}/`, selector: '.entry-step', holdsHover: true },
  { name: 'project card', path: '/projects/', selector: 'a.card', holdsHover: false },
];

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

/** What a hover rule on this site changes, read from the row and everything inside it. */
function painted(page: Page, selector: string) {
  return page.evaluate(async sel => {
    const row = document.querySelector<HTMLElement>(sel);
    if (!row) throw new Error(`no ${sel} on ${location.pathname}`);
    const elements = [row, ...row.querySelectorAll<HTMLElement>('*')];
    // A hover rule usually arrives through a transition; read the value it settles on.
    await Promise.all(elements.flatMap(el => el.getAnimations()).map(animation => animation.finished.catch(() => null)));
    return {
      hover: row.matches(':hover'),
      styles: elements.map(el => {
        const style = getComputedStyle(el);
        return [
          style.color,
          style.backgroundColor,
          style.borderTopColor,
          style.borderRightColor,
          style.borderBottomColor,
          style.borderLeftColor,
          style.boxShadow,
          style.transform,
          style.textDecorationLine,
        ].join(' | ');
      }),
    };
  }, selector);
}

/**
 * The hover rules that apply to the row, or to something inside it, and are live on this device:
 * every media query around them matches. Read from the stylesheets the page loaded.
 */
function liveHoverRules(page: Page, selector: string) {
  return page.evaluate(sel => {
    const row = document.querySelector<HTMLElement>(sel);
    if (!row) throw new Error(`no ${sel} on ${location.pathname}`);
    const elements = [row, ...row.querySelectorAll<HTMLElement>('*')];
    const found: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          if (matchMedia(rule.conditionText).matches) walk(rule.cssRules);
        } else if (rule instanceof CSSStyleRule) {
          if (!rule.selectorText.includes(':hover')) continue;
          // Hovering an ancestor of the row is not a tap on the row, so only the selector's last
          // compound and the row's own subtree count: `.row:hover .row-title`, not `main:hover a`.
          const resting = rule.selectorText.replaceAll(':hover', '');
          const applies = elements.some(el => {
            try {
              return el.matches(resting);
            } catch {
              return false;
            }
          });
          if (applies) found.push(rule.selectorText);
        } else if ('cssRules' in rule) {
          walk((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    return found;
  }, selector);
}

for (const retro of [false, true]) {
  const appearance = retro ? 'retro' : 'modern';

  for (const row of ROWS) {
    test(`touch hover (${appearance}): a tapped ${row.name} on ${row.path} keeps no hover style`, async ({ page }) => {
      if (retro) {
        await page.addInitScript(() => {
          try {
            localStorage.setItem('mattpyle:appearance', 'retro');
          } catch {
            /* ignore */
          }
        });
      }
      await gotoSettled(page, row.path);
      if (retro) await expect(page.locator('html')).toHaveAttribute('data-appearance', 'retro');
      expect(
        await page.evaluate(() => matchMedia('(hover: hover)').matches),
        'the emulated device reports that it cannot hover',
      ).toBe(false);

      // The tap must not leave the page or open a tab: the row is measured where it was tapped.
      await page.evaluate(() => {
        document.addEventListener('click', event => event.preventDefault(), true);
      });

      expect(
        await liveHoverRules(page, row.selector),
        `a hover rule for ${row.selector} is in effect on a device that cannot hover. ` +
          'Put it inside @media (hover: hover); tests/hover-guard.test.mjs names the source line.',
      ).toEqual([]);
      if (!row.holdsHover) return;

      const target = page.locator(row.selector).first();
      await target.scrollIntoViewIfNeeded();
      const before = await painted(page, row.selector);
      expect(before.hover, 'nothing is hovered before the tap').toBe(false);

      await target.tap();
      await expect
        .poll(async () => (await painted(page, row.selector)).hover, {
          message: 'the emulation matches :hover on the tapped element, as a phone does. If this fails the check proves nothing.',
        })
        .toBe(true);

      const after = await painted(page, row.selector);
      expect(
        after.styles,
        `${row.selector} or something inside it is painted differently after a tap. ` +
          'A hover rule is outside @media (hover: hover); tests/hover-guard.test.mjs names it.',
      ).toEqual(before.styles);
    });
  }
}
