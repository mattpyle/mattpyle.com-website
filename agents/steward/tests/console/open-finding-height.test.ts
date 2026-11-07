import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { startConsoleServer, type ConsoleServer } from '../../src/console/server.js';
import { CONSOLE_RESTART_STUBS } from '../helpers/console-options.js';
import type { FindingRow, FindingsModel } from '../../src/console/findings-model.js';

/**
 * An open finding fills the panel's height, with the verdict foot at the bottom, at every width.
 *
 * **The symptom.** Scroll the list down, open a finding with a long body, and the finding shows in a short
 * box: the reason field and Approve sit near the top of the screen and the list beside it takes about 40
 * percent of the viewport height. Nothing is clipped by a `max-height`; the whole panel has slid up the page.
 *
 * **The rule.** At 1041 px and wider, `html:has(.is-open) { overflow: hidden }` stops the window scrolling
 * but keeps the offset it already had. `.app` was in the flow at `height: 100vh`, so it started that many
 * pixels above the top of the window and only the lowest part of the panel stayed on screen. Pinning
 * `.is-open .app` with `position: fixed; inset: 0` in `findings.css` removes the dependence on the offset.
 * Below 1041 px the panel is already `position: fixed`; those widths guard the overlay and the phone layout.
 *
 * This test starts the real console on a free port with 30 rows that each carry a body several screens long,
 * scrolls the window down the list as a reader does, opens a row and measures the panel in the system
 * Chrome (Playwright's `chrome` channel, as `browser.test.ts` does). At 1440, 1024 and 390 px wide and 800 px
 * tall it asserts that the panel spans the viewport, the document is at least 60 percent of the viewport
 * high and scrolls inside the panel, and the foot sits under the document and on the bottom edge. At 1440
 * px it also asserts that the rail keeps its own scroll and that closing the finding puts the list back where
 * it was. It asserts sizes, never a screenshot, so a copy change cannot break it.
 *
 * **Needs.** Google Chrome. Without it and with `CI` unset the tests skip; with `CI` set they fail.
 */

const SITE = 'temporal-io';
const RUN = { open: false, since: null, step: null, queried: false, queryError: null, prUrl: null, issueUrl: null, previewResult: null, lastFixError: null, slotLine: null };
const OPEN_KEY = 'ux-row-14--set-up';
const VIEWPORT_HEIGHT = 800;
/** The document must show at least this share of the viewport's height. The foot and the close row take the rest. */
const MIN_DOC_SHARE = 0.6;

const LONG_HTML = Array.from({ length: 24 }, (_, i) => `<p>Paragraph ${i}. ${'The consent banner covers the wizard buttons on the set up page, so a visitor cannot choose an SDK. '.repeat(4)}</p>`).join('');

function row(i: number): FindingRow {
  return {
    site: SITE,
    status: 'proposed',
    fileStatus: 'proposed',
    kind: 'defect',
    type: 'content',
    key: `ux-row-${i}--set-up`,
    title: `Title of row ${i}`,
    titleShort: null,
    summary: 'One line summary of the finding.',
    keyShort: null,
    reason: '',
    priority: 'medium',
    verdictAt: null,
    verdictSource: null,
    opened: '2026-10-20',
    index: i,
    prUrl: null,
    fileMissing: false,
    run: RUN,
    verification: null,
    drift: [],
    quietReason: null,
    holdLine: null,
    body: LONG_HTML,
    sections: [{ heading: 'Evidence', html: LONG_HTML }, { heading: 'Suggested fix', html: LONG_HTML }],
    events: [],
    actions: { fix: false, verify: false },
  } as unknown as FindingRow;
}

const MODEL = {
  generatedAt: '2026-11-07T12:00:00.000Z',
  repo: 'test/argus',
  sites: [{ site: SITE, rows: Array.from({ length: 30 }, (_, i) => row(i)), counts: {}, openRuns: 0, orphanRuns: [] }],
  failedVerifies: [],
  cost: { treeCalls: 1, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 },
  commit: 'abc1234',
  behindMaster: false,
} as unknown as FindingsModel;

let server: ConsoleServer;
let browser: Browser | null = null;
let missingChrome = '';

before(async () => {
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
    if (process.env.CI) throw new Error(`The console browser test needs Google Chrome and could not launch it: ${why}`);
    missingChrome = `Google Chrome is not installed (${why}), so the open-finding height test did not run.`;
    return;
  }
  server = await startConsoleServer({
    ...CONSOLE_RESTART_STUBS,
    port: 0,
    loadFindings: async () => MODEL,
    sendVerdict: async () => {
      throw new Error('This test sends no verdict.');
    },
    timeZone: 'America/Vancouver',
    webUi: 'https://web.example',
    namespace: 'ns.test',
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

for (const width of [1440, 1024, 390]) {
  test(`an open finding fills the panel at ${width} px wide`, async (t) => {
    if (!browser) {
      t.skip(missingChrome);
      return;
    }
    const page = await browser.newPage({ viewport: { width, height: VIEWPORT_HEIGHT } });
    try {
      await page.goto(server.url);
      await page.waitForSelector('.row');

      // A reader scrolls down the list before opening a row; the window keeps that offset while the finding is open.
      await page.evaluate('window.scrollTo(0, 600)');
      const listScroll = await page.evaluate<number>('window.scrollY');
      assert.ok(listScroll > 0, 'the fixture list is long enough to scroll the window');

      await page.click(`.row[data-id="${SITE}/${OPEN_KEY}"]`);
      await page.waitForSelector('body.is-open', { state: 'attached' });
      await page.waitForSelector('.foot:not([hidden])');

      const box = async (selector: string) => {
        const b = await page.locator(selector).boundingBox();
        assert.ok(b, `${selector} has a box`);
        return b;
      };
      const panel = await box('.panel');
      const doc = await box('.doc');
      const foot = await box('.foot');
      const where = `at ${width} px wide: panel ${JSON.stringify(panel)}, document ${JSON.stringify(doc)}, foot ${JSON.stringify(foot)}`;

      assert.ok(Math.abs(panel.y) <= 1 && Math.abs(panel.y + panel.height - VIEWPORT_HEIGHT) <= 1, `the panel spans the viewport's height ${where}`);
      assert.ok(doc.height >= VIEWPORT_HEIGHT * MIN_DOC_SHARE, `the document is at least ${MIN_DOC_SHARE * 100} percent of the viewport high ${where}`);
      assert.ok(foot.y > doc.y, `the foot sits below the top of the document ${where}`);
      assert.ok(foot.y >= doc.y + doc.height - 1, `the foot sits under the document ${where}`);
      assert.ok(Math.abs(foot.y + foot.height - VIEWPORT_HEIGHT) <= 1, `the foot sits on the panel's bottom edge ${where}`);

      const docScrolls = await page.evaluate<boolean>("(() => { const d = document.querySelector('.doc'); return d.scrollHeight > d.clientHeight; })()");
      assert.ok(docScrolls, 'the long body scrolls inside the document, not the window');

      if (width > 1040) {
        // The rail is its own scroll container, as tall as the viewport, and closing puts the list back where it was.
        const rail = await box('.page');
        const railScrolls = await page.evaluate<boolean>("(() => { const p = document.querySelector('.page'); return p.scrollHeight > p.clientHeight; })()");
        assert.ok(Math.abs(rail.height - VIEWPORT_HEIGHT) <= 1, `the rail is as tall as the viewport, not the panel's share of it: ${JSON.stringify(rail)}`);
        assert.ok(railScrolls, 'the rail keeps its own scroll');

        await page.click('.close');
        await page.waitForSelector('body:not(.is-open)', { state: 'attached' });
        // Wait past the old 240 ms track transition: a late layout change moves the offset through scroll anchoring,
        // and a read taken before it lands passes on a fast machine and fails on a slow one.
        await page.waitForTimeout(500);
        assert.equal(await page.evaluate<number>('window.scrollY'), listScroll, 'closing the finding returns the list to its scroll position');
      }
    } finally {
      await page.close();
    }
  });
}
