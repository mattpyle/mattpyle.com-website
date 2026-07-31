import type { Page } from '@playwright/test';

/**
 * Every interactive component on this site wires itself up inside an
 * `astro:page-load` listener (FilterPills, ArticleActions, AppearanceUI, the
 * WebMCP console), because that event fires both on a hard load and after a
 * ClientRouter swap. Asserting anything about the keyboard or the a11y tree
 * before it fires measures the pre-hydration document, which is a different
 * document: /webmcp ships every control `disabled` and enables it there.
 *
 * So: count the event from an init script, and wait for the count to move.
 */

declare global {
  interface Window {
    __a11yPageLoads?: number;
  }
}

export async function installPageLoadCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__a11yPageLoads = 0;
    document.addEventListener('astro:page-load', () => {
      window.__a11yPageLoads = (window.__a11yPageLoads ?? 0) + 1;
    });
  });
}

/** Navigate and wait for the site's own hydration signal. */
export async function gotoSettled(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'load' });
  await page.waitForFunction(() => (window.__a11yPageLoads ?? 0) > 0);
  // Fonts affect layout, and the reflow check reads scrollWidth.
  await page.evaluate(() => document.fonts.ready);
}

/** Wait for the counter to advance past a value captured before a soft nav. */
export async function waitForSoftNav(page: Page, previous: number): Promise<void> {
  await page.waitForFunction(
    prev => (window.__a11yPageLoads ?? 0) > prev,
    previous,
  );
}

export function readPageLoads(page: Page): Promise<number> {
  return page.evaluate(() => window.__a11yPageLoads ?? 0);
}
