import { test, expect } from '@playwright/test';
import { PAGES } from './helpers/pages';
import { installPageLoadCounter, gotoSettled } from './helpers/settle';
import { markTabbables, walk } from './helpers/keyboard';

/**
 * WCAG 2.4.7 (focus visible).
 *
 * Driven with real Tab presses rather than element.focus(), because `:focus-visible`
 * only matches on a keyboard-initiated focus. Calling .focus() from script would
 * report a missing ring on every button on the site.
 *
 * The indicator is read as: an outline on the focused element, an outline on one
 * of its first three ancestors (the `:has()` pattern /webmcp uses to move the ring
 * off a dark scroll panel onto its frame), or a box-shadow on the element itself.
 * That is a presence test, not a contrast or thickness test — WCAG 2.4.11/2.4.13
 * are out of scope here and are the kind of thing axe already partly covers.
 */

test.beforeEach(async ({ page }) => {
  await installPageLoadCounter(page);
});

for (const spec of PAGES) {
  test(`${spec.name} (${spec.path}): every tab stop paints a focus indicator`, async ({ page }) => {
    await gotoSettled(page, spec.path);
    const expected = await markTabbables(page);
    const stops = await walk(page, expected.length);

    const unringed = stops
      .filter(s => !s.ring)
      .map(s => `  idx=${s.idx} ${s.label}`);

    expect(
      unringed,
      `Tab stops on ${spec.path} with no visible focus indicator:\n${unringed.join('\n')}`,
    ).toEqual([]);
  });
}
