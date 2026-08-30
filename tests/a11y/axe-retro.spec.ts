import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Result } from 'axe-core';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';

/**
 * axe against RETRO, on the same nine routes `.github/workflows/a11y.yml` audits with
 * `@axe-core/cli` in modern. The CLI can only audit what the server sends, and retro lives entirely
 * in client-side storage, so the second mode of a two-mode site had no automated audit at all: the
 * guest book, the webmaster note and the web ring are `display: none` in modern, and a contrast or
 * labelling regression in any of them reached production without CI noticing.
 *
 * Why Playwright rather than a build-time retro fixture or a `?appearance=retro` parameter: this
 * suite already forces the appearance before the first paint and the axe job already runs a
 * Playwright step against the same build on the same server. One dependency, no new machinery, and
 * no retro duplicate of every page sitting in dist for a crawler to find.
 *
 * The trap that shapes every test here: injecting axe into a page and setting `data-appearance`
 * from the console reports contrast violations the page does not have, because the retro custom
 * properties have to be in effect when the browser computes the styles axe reads. So the appearance
 * is written to localStorage from an init script, before the first paint, exactly the way a
 * returning visitor arrives — and asserted before anything is scanned, because a retro row that
 * silently rendered modern would pass while checking nothing.
 *
 * Tagged @axe so the workflow can run this as its own gating step and grep it out of the advisory
 * guard step, rather than scanning everything twice in one job.
 */

/**
 * The routes the CLI audits in modern, in the order the workflow lists them, plus the two
 * changelog surfaces. Those two are a deliberate superset, added 2026-08-29: the one-DOM phase
 * that converted /changelog and the entry page wrote net-new retro styling on both, and the CLI
 * step cannot scan retro at all, so without these rows that styling would ship with no contrast
 * gate. Every restyled retro surface gets scanned; that is this file's premise.
 */
const ROUTES = [
  '/',
  '/about',
  '/writing',
  '/projects',
  '/changelog',
  '/changelog/public-scorecard/',
  '/scorecard',
  '/activity',
  '/steward',
  '/webmcp',
  '/writing/accessibility-and-ai/',
] as const;

/**
 * A guest book entry written by an agent, seeded into storage for the homepage scans.
 *
 * Session 15's lesson made a rule: a returning visitor's book is script-built DOM, and the script
 * replaces the whole list as soon as this browser has one entry of its own. A page seeded with the
 * appearance key alone renders the five server-side seeds and nothing else, so it never scans the
 * rows the client renderer builds — which is where a layout bug lived invisibly for a whole phase.
 * An agent entry rather than a human one, because it carries two extra rendered things: the
 * provenance badge and the tool-name line.
 */
const STORED_AGENT_ENTRY = [
  {
    number: 6,
    name: 'the retro axe audit',
    message: 'A stored entry, so the script-built rows are what gets scanned.',
    date: '02 AUG 2026',
    iso: '2026-08-02',
    source: 'agent',
  },
];

/** Persist retro (and optionally a guest book) before the first paint, then prove it took. */
async function gotoRetro(
  page: Page,
  path: string,
  options: { guestbook?: unknown } = {},
): Promise<void> {
  await page.addInitScript(guestbook => {
    try {
      localStorage.setItem('mattpyle:appearance', 'retro');
      if (guestbook) localStorage.setItem('mattpyle:guestbook', JSON.stringify(guestbook));
    } catch {
      /* ignore */
    }
  }, options.guestbook ?? null);
  await gotoSettled(page, path);
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'retro');
}

/** Scan with AxeBuilder defaults — the same rule set, and the same axe-core, as the CLI step. */
async function scan(page: Page): Promise<Result[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations;
}

/**
 * A failure has to be readable in a CI log without a report artifact, so every violation names its
 * rule, its impact, the selectors that failed and axe's own summary of why.
 */
function report(violations: Result[], label: string): string {
  return (
    `axe found ${violations.length} violation(s) on ${label}:\n` +
    violations
      .map(v => {
        const nodes = v.nodes
          .map(n => `      - ${n.target.join(' ')}\n        ${(n.failureSummary ?? '').replace(/\n/g, '\n        ')}`)
          .join('\n');
        return `  ${v.id} (${v.impact ?? 'unknown'}): ${v.help}\n    ${v.helpUrl}\n${nodes}`;
      })
      .join('\n')
  );
}

async function expectClean(page: Page, label: string): Promise<void> {
  const violations = await scan(page);
  expect(violations.map(v => v.id), report(violations, label)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

for (const path of ROUTES) {
  test(`retro: axe is clean on ${path}`, { tag: '@axe' }, async ({ page }) => {
    // Only the homepage renders the guest book, so only the homepage is seeded with one.
    await gotoRetro(page, path, path === '/' ? { guestbook: STORED_AGENT_ENTRY } : {});
    await expectClean(page, `${path} (retro)`);
  });
}

/**
 * The three states below exist only after an interaction, so a scan of the page as served never
 * reaches them. They were audited by hand for Phase 3 (build-log Session 14) and found clean; a
 * hand audit is not a guard, and these are the states most likely to regress, because each one
 * introduces colour and copy that appear nowhere else: an error's red, a confirmation's green, and
 * a filing card that replaces its own form.
 */

test('retro: axe is clean on the guest book error state', { tag: '@axe' }, async ({ page }) => {
  await gotoRetro(page, '/', { guestbook: STORED_AGENT_ENTRY });

  await page.locator('[data-gb-message]').fill('A message with no signature.');
  await page.locator('[data-gb-submit]').click();
  // Scan the state, not the moment before it: the error message and aria-invalid are what is new.
  await expect(page.locator('[data-gb-name-error]')).toBeVisible();
  await expect(page.locator('[data-gb-name]')).toHaveAttribute('aria-invalid', 'true');

  await expectClean(page, 'the guest book error state (retro)');
});

test('retro: axe is clean on the guest book confirmation', { tag: '@axe' }, async ({ page }) => {
  await gotoRetro(page, '/', { guestbook: STORED_AGENT_ENTRY });

  await page.locator('[data-gb-name]').fill('the retro axe audit');
  await page.locator('[data-gb-message]').fill('Signed so the confirmation is on the page.');
  await page.locator('[data-gb-submit]').click();
  // The confirmation and the freshly prepended entry, badge included, are both new DOM.
  await expect(page.locator('[data-gb-confirm]')).toBeVisible();
  await expect(page.locator('[data-module="guestbook"] .gb-badge--new')).toHaveCount(1);

  await expectClean(page, 'the guest book confirmation (retro)');
});

test('retro: axe is clean on the filed webmaster note', { tag: '@axe' }, async ({ page }) => {
  await gotoRetro(page, '/', { guestbook: STORED_AGENT_ENTRY });

  await page.locator('[data-wm-input]').fill('Filed so the filing card is on the page.');
  await page.locator('[data-wm-submit]').click();
  await expect(page.locator('[data-wm-filed]')).toBeVisible();
  await expect(page.locator('[data-wm-form]')).toBeHidden();

  await expectClean(page, 'the filed webmaster note (retro)');
});
