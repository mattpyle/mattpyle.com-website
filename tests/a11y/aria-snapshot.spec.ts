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
 * REDACT CONTENT, NEVER A COUNT. Redaction replaces a subtree's text with `·`,
 * which asserts nothing about it: a region redacted to `·` still matches when it
 * renders empty, or loses the number that was its whole point. That is fine for
 * a post title, which is content the template does not owe the reader; it is
 * wrong for "showing X of Y", an entry count, or a score, where the number IS
 * the behaviour under test. Those stay in the golden as a regex — `/showing \d+
 * of \d+/` — so the shape is pinned and the value is free. Checked by breaking
 * it: blanking the changelog pager's count fails `changelog-index`, which a
 * `·` redaction did not.
 *
 * Playwright writes some of those regexes itself when it regenerates, and it
 * writes them too tight — it turned the hero's date into `/\d+ Aug \d+/`, which
 * would fail the day the newest entry is not in August. Widen them by hand and
 * read every one.
 *
 * Update deliberately: `npx playwright test aria-snapshot --update-snapshots`,
 * then read the diff. A diff here means the accessibility tree changed shape.
 *
 * A FORCED regeneration (`--update-snapshots=all`) rewrites all ten and
 * RELITERALISES hand-written regexes — it has turned `/\d+ audits/` into
 * `"2 audits"` in steward.aria.yml on every forced run so far. Force only when
 * a golden may have gone stale without failing (they match as a subset, so an
 * ADDED element never fails one), then keep only the files you meant to move.
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
