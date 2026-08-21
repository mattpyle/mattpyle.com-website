import { test, expect } from '@playwright/test';
import { installPageLoadCounter, gotoSettled, readPageLoads, waitForSoftNav } from './helpers/settle';

/**
 * WCAG 3.2.x / 4.1.3 for client-side navigation.
 *
 * The site runs Astro's ClientRouter, so following an internal link swaps the
 * document instead of loading one. Two things then have to be true for a keyboard
 * or screen-reader user, and neither is true by default in a naive SPA:
 *
 *   1. Focus must not be stranded on a node from the old document, and the next
 *      Tab must restart at the top of the new page rather than resuming mid-page.
 *   2. The navigation must be announced, because no page load event fires.
 *      Astro injects `.astro-route-announcer` for this; the assertion below is
 *      that it is still there and still carries the new page's name.
 */

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

const HOPS: { from: string; linkName: string; to: RegExp }[] = [
  { from: '/', linkName: 'Writing', to: /\/writing\/?$/ },
  { from: '/writing', linkName: 'Changelog', to: /\/changelog\/?$/ },
  { from: '/changelog', linkName: 'Scorecard', to: /\/scorecard\/?$/ },
];

for (const hop of HOPS) {
  test(`ClientRouter: ${hop.from} -> ${hop.linkName} leaves focus somewhere sensible`, async ({
    page,
  }) => {
    await gotoSettled(page, hop.from);

    // Click the link in the main navigation, not whatever else on the page shares
    // its label (the homepage hero also links to /writing).
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const before = await readPageLoads(page);
    await nav.getByRole('link', { name: hop.linkName, exact: true }).click();
    await waitForSoftNav(page, before);
    await expect(page).toHaveURL(hop.to);

    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        tag: el?.tagName.toLowerCase() ?? 'none',
        inMain: !!el?.closest('main'),
        detached: !!el && !document.contains(el),
      };
    });

    // Focus must belong to the new document.
    expect(active.detached, 'Focus is stranded on a node from the previous document').toBe(false);

    // "Somewhere sensible" = reset to the document root, or parked on something
    // inside the new <main>. What is NOT sensible is focus left on the nav link
    // that was clicked, because the next Tab then resumes deep in the chrome.
    expect(['body', 'html', 'main'].includes(active.tag) || active.inMain).toBe(true);

    // The practical consequence, asserted directly: Tab restarts at the skip link.
    await page.keyboard.press('Tab');
    const firstStop = await page.evaluate(() => ({
      className: (document.activeElement as HTMLElement | null)?.className ?? '',
    }));
    expect(
      firstStop.className,
      'After a soft navigation the first Tab does not land on the skip link',
    ).toContain('skip-link');
  });
}

test('ClientRouter announces the new page to assistive tech', async ({ page }) => {
  await gotoSettled(page, '/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const before = await readPageLoads(page);
  await nav.getByRole('link', { name: 'Projects', exact: true }).click();
  await waitForSoftNav(page, before);

  const announcer = page.locator('.astro-route-announcer');
  await expect(announcer).toHaveAttribute('aria-live', 'assertive');
  await expect(announcer).toContainText('Projects');
});
