import { test, expect, type Page } from '@playwright/test';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';
import { markTabbables, tabbablesInsideAriaHidden, walk, formatStops } from './helpers/keyboard';

/**
 * The Phase 3 furniture — the guest book, the webmaster note, the web ring — is the only
 * INTERACTIVE part of this site that exists in one appearance and not the other. It is
 * `display: none` in modern, so every other row in this suite walks straight past it: the modern
 * homepage has nothing to tab into, and the aria golden records a tree the controls are not in.
 *
 * So this file is the retro homepage's keyboard and focus coverage, run the same way the reflow
 * spec runs retro: the appearance is written to localStorage before the first paint, and the
 * attribute is asserted before anything is measured, because a retro row that silently rendered
 * modern would pass while checking nothing.
 *
 * Not a golden. Everything here is derived from the page's own DOM on each run.
 */

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

/** Load the homepage with retro persisted, and prove it took. */
async function gotoRetroHome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mattpyle:appearance', 'retro');
    } catch {
      /* ignore */
    }
  });
  await gotoSettled(page, '/');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'retro');
}

test('the furniture is displayed in retro and hidden in modern', async ({ page }) => {
  const panels = ['[data-module="guestbook"]', '[data-module="webmaster-note"]', '[data-module="web-ring"]'];

  await gotoRetroHome(page);
  for (const selector of panels) {
    await expect(page.locator(selector), `${selector} should be visible in retro`).toBeVisible();
  }

  // Same DOM, same page, appearance switched back: present but not displayed. This is the
  // progressive-enhancement claim in the spec — nothing is injected or removed at toggle time.
  // Init scripts accumulate and run in order, so this one overwrites the retro key set above.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mattpyle:appearance', 'modern');
    } catch {
      /* ignore */
    }
  });
  await gotoSettled(page, '/');
  await expect(page.locator('html')).not.toHaveAttribute('data-appearance', 'retro');
  for (const selector of panels) {
    await expect(page.locator(selector), `${selector} should exist in modern`).toHaveCount(1);
    await expect(page.locator(selector), `${selector} should be hidden in modern`).toBeHidden();
  }
});

test('the guest book reads with JavaScript off, and its controls ship disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  // No astro:page-load without JavaScript, so this cannot use gotoSettled. The attribute has to
  // be set from the test rather than from the pre-paint script, for the same reason.
  await page.goto('/');
  await page.evaluate(() => document.documentElement.setAttribute('data-appearance', 'retro'));

  await expect(page.locator('[data-module="guestbook"] .gb-entry')).toHaveCount(5);
  await expect(page.locator('[data-module="guestbook"] .gb-badge')).toHaveCount(2);
  await expect(page.locator('[data-gb-submit]')).toBeDisabled();
  await expect(page.locator('[data-wm-submit]')).toBeDisabled();
  await expect(page.locator('[data-ring-next]')).toBeDisabled();
  // The dead controls have to explain themselves rather than just sitting there.
  await expect(page.locator('[data-gb-nojs]')).toBeVisible();

  await context.close();
});

test('the script enables every control it disabled', async ({ page }) => {
  await gotoRetroHome(page);

  for (const selector of ['[data-gb-name]', '[data-gb-message]', '[data-gb-submit]', '[data-wm-input]', '[data-wm-submit]', '[data-ring-prev]', '[data-ring-random]', '[data-ring-next]']) {
    await expect(page.locator(selector), `${selector} should be enabled after hydration`).toBeEnabled();
  }
});

test('sequential focus order on the retro homepage matches DOM order and reaches every control', async ({ page }) => {
  await gotoRetroHome(page);
  const expected = await markTabbables(page);
  expect(expected.length, 'the retro homepage has no tabbable elements').toBeGreaterThan(0);

  const stops = await walk(page, expected.length);
  expect(
    stops.map(s => s.idx),
    `Tab order on the retro homepage diverged from DOM order.\nGot:\n${formatStops(stops)}\n` +
      `Expected DOM order:\n${expected.map(e => `  ${e.idx}: ${e.label}`).join('\n')}`,
  ).toEqual(expected.map(e => e.idx));
});

test('every tab stop on the retro homepage paints a focus indicator', async ({ page }) => {
  await gotoRetroHome(page);
  const expected = await markTabbables(page);
  const stops = await walk(page, expected.length);

  const unringed = stops.filter(s => !s.ring).map(s => `  idx=${s.idx} ${s.label}`);
  expect(
    unringed,
    `Tab stops on the retro homepage with no visible focus indicator:\n${unringed.join('\n')}`,
  ).toEqual([]);
});

test('nothing in the retro homepage tab order is hidden from assistive tech', async ({ page }) => {
  // The furniture around these panels IS aria-hidden (marquee, dividers, construction banner),
  // so this page is the one most likely to grow a control inside a hidden subtree.
  await gotoRetroHome(page);
  await markTabbables(page);
  expect(await tabbablesInsideAriaHidden(page)).toEqual([]);
});

test('a rejected signature names the problem, marks the field, and takes focus there', async ({ page }) => {
  await gotoRetroHome(page);

  await page.locator('[data-gb-message]').fill('A message with no signature.');
  await page.locator('[data-gb-submit]').click();

  const name = page.locator('[data-gb-name]');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toBeFocused();

  const error = page.locator('[data-gb-name-error]');
  await expect(error).toBeVisible();
  // The word ERROR is one of the three non-colour cues; the other two are the border-style flip
  // and the counter's weight, both CSS.
  await expect(error).toContainText('ERROR');
  // The error message has to be reachable from the field, not merely near it.
  await expect(name).toHaveAttribute('aria-describedby', /gb-name-error/);

  // Nothing was written, so the book is still the five seeds.
  await expect(page.locator('[data-module="guestbook"] .gb-entry')).toHaveCount(5);
});

test('a signature prepends the entry, badges it as just added, and states where it went', async ({ page }) => {
  await gotoRetroHome(page);

  await page.locator('[data-gb-name]').fill('A keyboard');
  await page.locator('[data-gb-message]').fill('Signed from the a11y suite.');
  await page.locator('[data-gb-submit]').click();

  const entries = page.locator('[data-module="guestbook"] .gb-entry');
  await expect(entries).toHaveCount(6);
  await expect(entries.first()).toContainText('A keyboard');
  await expect(entries.first()).toContainText('#006');
  await expect(entries.first().locator('.gb-badge--new')).toHaveText('[JUST ADDED]');

  // A form entry is a human entry: no agent badge, whatever the visitor typed.
  await expect(entries.first().locator('.gb-badge').filter({ hasText: 'SIGNED BY AGENT' })).toHaveCount(0);

  // The confirmation is the one place the client-local guarantee is stated, and it is announced.
  const confirm = page.locator('[data-gb-confirm]');
  await expect(confirm).toContainText('#006');
  await expect(confirm).toContainText('this browser only');
  await expect(confirm).toHaveAttribute('aria-live', 'polite');
});

test('a stored agent entry renders with the provenance badge and the tool name', async ({ page }) => {
  // The store's provenance rules are unit-tested in tests/guestbook.test.mjs; what this asserts is
  // the render — that an entry recorded as agent-written comes back out of storage carrying the
  // badge. Seeded through localStorage rather than through the tool because the tool needs
  // `document.modelContext`, which is the origin trial, which is the manual pass.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mattpyle:appearance', 'retro');
      localStorage.setItem(
        'mattpyle:guestbook',
        JSON.stringify([
          {
            number: 6,
            name: 'a test agent',
            message: 'Written through the tool.',
            date: '02 AUG 2026',
            iso: '2026-08-02',
            source: 'agent',
          },
        ]),
      );
    } catch {
      /* ignore */
    }
  });
  await gotoSettled(page, '/');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'retro');

  const first = page.locator('[data-module="guestbook"] .gb-entry').first();
  await expect(first).toContainText('a test agent');
  await expect(first.locator('.gb-badge').first()).toHaveText('[SIGNED BY AGENT]');
  await expect(first.locator('.gb-via')).toContainText('sign_guestbook');

  // Session-only: [JUST ADDED] does not survive a reload, when the number and date do the job.
  await expect(first.locator('.gb-badge--new')).toHaveCount(0);

  // A script-built row must get the same layout as a server-rendered one. It does not get Astro's
  // scoping attribute, so a scoped entry rule would style the seeds and skip everything this
  // browser wrote — which is what happened, and it was invisible until a stored entry existed.
  const stored = first.locator('.gb-entry-meta');
  const seed = page.locator('[data-module="guestbook"] .gb-entry').nth(1).locator('.gb-entry-meta');
  for (const property of ['display', 'columnGap', 'justifyContent']) {
    const built = await stored.evaluate((el, p) => getComputedStyle(el)[p as any], property);
    const rendered = await seed.evaluate((el, p) => getComputedStyle(el)[p as any], property);
    expect(built, `${property} on a script-built entry`).toBe(rendered);
    expect(built).not.toBe('');
  }
  await expect(stored).toHaveCSS('display', 'flex');
});

test('filing a webmaster note replaces the form with the confirmation and the real link', async ({ page }) => {
  await gotoRetroHome(page);

  await page.locator('[data-wm-input]').fill('Your site is loud. I mean that kindly.');
  await page.locator('[data-wm-submit]').click();

  const filed = page.locator('[data-wm-filed]');
  await expect(filed).toBeVisible();
  await expect(filed).toContainText('never left this browser');
  await expect(page.locator('[data-wm-form]')).toBeHidden();

  // The one real channel, and it appears only here — the moment the joke has just admitted the
  // note went nowhere.
  await expect(filed.locator('a')).toHaveAttribute('href', /linkedin\.com/);
  await expect(page.locator('[data-wm-announce]')).toContainText('never left this browser');
});

test('the ring cycles its members without moving the controls', async ({ page }) => {
  await gotoRetroHome(page);

  const member = page.locator('[data-ring-member]');
  const nameLine = page.locator('[data-ring-name]');
  const before = await member.boundingBox();
  const firstName = await nameLine.textContent();

  await page.locator('[data-ring-next]').click();
  await expect(nameLine).not.toHaveText(firstName!);
  await expect(page.locator('[data-ring-position]')).toContainText('Site 2 of');

  // Fixed height: cycling must not move the button the visitor is about to press again.
  expect((await member.boundingBox())?.height).toBe(before?.height);

  // An open slot says so rather than rendering a dead link.
  await expect(page.locator('[data-ring-visit]')).toContainText('No link yet');
});

test('the visit counter reads a real count and says it in words for a screen reader', async ({ page }) => {
  await gotoRetroHome(page);

  await expect(page.locator('[data-visit-digits]')).toHaveText('000001');
  await expect(page.locator('[data-visit-plain]')).toHaveText('1 visit from this browser.');
  // Six zero-padded digits are a picture of a number, not a number: the digits are hidden from
  // assistive tech and the sentence beside them carries the value.
  await expect(page.locator('[data-visit-digits]')).toHaveAttribute('aria-hidden', 'true');
});
