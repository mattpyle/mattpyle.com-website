import { test, expect } from '@playwright/test';
import { PAGES, type PageSpec } from './helpers/pages';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';

/**
 * A committed accessibility-tree golden per template.
 *
 * This is the check most likely to be more trouble than it is worth, and the
 * design below is the compromise the card asks for: PRUNE THE CONTENT, KEEP THE
 * TEMPLATE. An unpruned body snapshot fails on every new post, every changelog
 * entry and every scorecard run, which makes it a change detector rather than a
 * check. Pruned to chrome plus one representative row of each list, it guards
 * exactly what a template snapshot should guard: landmarks, headings, roles,
 * accessible names, and the shape of a row.
 *
 * The pruning is per-page and declared in helpers/pages.ts, so what is being
 * ignored is legible in review rather than buried in a regex.
 *
 * Update deliberately: `npx playwright test aria-snapshot --update-snapshots`,
 * then read the diff. A diff here means the accessibility tree changed shape.
 *
 * Tagged @golden because these are the one family the per-PR guard in
 * .github/workflows/a11y.yml excludes: they match as a subset rather than an
 * exact tree, so they are a scorecard axis with a human reading the diff, not a
 * gate. The tag is the filter, so a new spec file joins the guard by default.
 */

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

const REDACTED = '·';

async function prune(page: import('@playwright/test').Page, spec: PageSpec): Promise<void> {
  await page.evaluate(
    ({ drop, keepFirst, redact, token }) => {
      for (const selector of drop ?? []) {
        document.querySelectorAll(selector).forEach(el => el.remove());
      }
      for (const selector of keepFirst ?? []) {
        Array.from(document.querySelectorAll(selector))
          .slice(1)
          .forEach(el => el.remove());
      }
      for (const selector of redact ?? []) {
        document.querySelectorAll(selector).forEach(root => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const texts: Text[] = [];
          while (walker.nextNode()) texts.push(walker.currentNode as Text);
          for (const node of texts) {
            if (node.nodeValue && node.nodeValue.trim()) node.nodeValue = token;
          }
          // An aria-label carries the accessible name straight past the text
          // nodes — /scorecard's history rows build theirs from the numbers.
          const labelled = [root, ...Array.from(root.querySelectorAll('[aria-label]'))];
          for (const el of labelled) {
            if (el instanceof Element && el.hasAttribute('aria-label')) {
              el.setAttribute('aria-label', token);
            }
          }
          // An aria snapshot records a link's href, and inside a redacted row the
          // href is the post slug — content by another name.
          const linked = [root, ...Array.from(root.querySelectorAll('[href]'))];
          for (const el of linked) {
            if (el instanceof Element && el.hasAttribute('href')) el.setAttribute('href', '#');
          }
        });
      }
    },
    {
      drop: spec.snapshotDrop,
      keepFirst: spec.snapshotKeepFirst,
      redact: spec.snapshotRedact,
      token: REDACTED,
    },
  );
}

for (const spec of PAGES) {
  test(`${spec.name} (${spec.path}): accessibility tree matches the golden`, { tag: '@golden' }, async ({ page }) => {
    await gotoSettled(page, spec.path);
    await prune(page, spec);
    await expect(page.locator('body')).toMatchAriaSnapshot({
      name: `${spec.name}.aria.yml`,
    });
  });
}
