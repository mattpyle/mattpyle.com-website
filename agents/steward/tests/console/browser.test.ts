import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { startConsoleServer, type ConsoleServer } from '../../src/console/server.js';
import { CONSOLE_RESTART_STUBS } from '../helpers/console-options.js';
import { buildFindingVerdict, CONSOLE_APPROVE_REASON, type FindingVerdictRequest } from '../../src/lib/finding-verdict.js';
import type { FindingRow, FindingsModel } from '../../src/console/findings-model.js';

/**
 * The console's buttons wired to the backend, in a real browser.
 *
 * What the VM tests cannot see: `findings-client.test.ts` and its siblings run `findings.js` in a Node vm
 * with no document, so they check the HTML the script builds and never a click. `server.test.ts` and
 * `api.test.ts` check the routes with hand-built requests. Between the two sits the page's own wiring: the
 * click handler that calls `sendVerdict(act)`, the `fetch` that posts the body and the handler that calls
 * `runRow`. Delete any of those and every other test stays green while the button does nothing.
 *
 * This test closes that gap. It starts the real console server on a free port with a fixture model and
 * fakes that record every request, opens `/findings` in the system Chrome through Playwright (no browser
 * download), then approves one finding, rejects another with a reason and presses Fix on a third. It
 * asserts what the fakes received.
 *
 * **Needs.** Google Chrome, found by Playwright's `chrome` channel. The runner image of `ubuntu-latest`
 * ships it. Without Chrome and with `CI` unset, the test skips and the message names Chrome. With `CI`
 * set it fails instead, so a runner that loses Chrome cannot turn the check into a silent pass.
 */

const SITE = 'mattpyle-com';
const RUN = { open: false, since: null, step: null, queried: false, queryError: null, prUrl: null, issueUrl: null, previewResult: null, lastFixError: null, slotLine: null };

function row(partial: Partial<FindingRow> & Pick<FindingRow, 'key' | 'status'>): FindingRow {
  return {
    site: SITE,
    fileStatus: partial.status,
    kind: 'defect',
    type: 'content',
    title: `Title of ${partial.key}`,
    titleShort: null,
    summary: null,
    keyShort: null,
    reason: '',
    priority: 'medium',
    verdictAt: null,
    verdictSource: null,
    opened: '2026-10-20',
    index: 0,
    prUrl: null,
    fileMissing: false,
    run: RUN,
    verification: null,
    drift: [],
    quietReason: null,
    holdLine: null,
    body: '',
    sections: [],
    events: [],
    actions: { fix: false, verify: false },
    ...partial,
  };
}

const APPROVE_KEY = 'ux-approve-me--about';
const REJECT_KEY = 'ux-reject-me--about';
const FIX_KEY = 'ux-fix-me--about';
const REJECT_REASON = 'Duplicate of an older finding.';

const MODEL = {
  generatedAt: '2026-11-07T12:00:00.000Z',
  repo: 'test/argus',
  sites: [{
    site: SITE,
    rows: [
      row({ key: APPROVE_KEY, status: 'proposed', index: 0 }),
      row({ key: REJECT_KEY, status: 'proposed', index: 1 }),
      row({ key: FIX_KEY, status: 'approved', index: 2, actions: { fix: true, verify: false } }),
    ],
    counts: {},
    openRuns: 0,
    orphanRuns: [],
  }],
  failedVerifies: [],
  cost: { treeCalls: 1, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 },
  commit: 'abc1234',
  behindMaster: false,
} as unknown as FindingsModel;

let server: ConsoleServer;
let browser: Browser | null = null;
let missingChrome = '';
const verdicts: FindingVerdictRequest[] = [];
const fixes: { site: string; key: string }[] = [];

before(async () => {
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
    // On CI the runner is meant to have Chrome: a launch failure there is a failure, never a skip.
    if (process.env.CI) throw new Error(`The console browser test needs Google Chrome and could not launch it: ${why}`);
    missingChrome = `Google Chrome is not installed (${why}), so the console browser test did not run.`;
    return;
  }
  server = await startConsoleServer({
    ...CONSOLE_RESTART_STUBS,
    port: 0,
    loadFindings: async () => MODEL,
    sendVerdict: async (request) => {
      verdicts.push(request);
      return {
        workflowId: `finding/${request.site}/${request.key}`,
        sent: buildFindingVerdict(request.status, request.reason),
        recorded: buildFindingVerdict(request.status, request.reason),
        commitSha: 'abc1234',
        nextStep: null,
        nextStepError: null,
        webUrl: 'https://web.example/workflows/x',
      };
    },
    runFix: async (site, key) => {
      fixes.push({ site, key });
      return { workflowId: `finding/${site}/${key}`, webUrl: 'https://web.example/workflows/x', nextStep: 'The fixer opens a PR.' };
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

/** Clicks `selector` and waits for the page to post to `route`; a click that sends nothing fails with that sentence. */
async function press(page: Page, selector: string, route: string): Promise<void> {
  const posted = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === route, { timeout: 5000 });
  await page.click(selector);
  try {
    await posted;
  } catch {
    posted.catch(() => {});
    assert.fail(`Pressing ${selector} sent no POST to ${route}.`);
  }
}

test('Approve, Reject and Fix in the page each reach the backend with the right finding', async (t) => {
  if (!browser) {
    t.skip(missingChrome);
    return;
  }
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  try {
    await page.goto(server.url);
    const rowOf = (key: string) => `.row[data-id="${SITE}/${key}"]`;

    // 1. Approve the first finding with no reason: the console supplies its own.
    await page.click(rowOf(APPROVE_KEY));
    await press(page, '.foot [data-act="approve"]', '/api/verdict');
    await page.waitForSelector('.foot .next');

    // 2. Reject the second. With no reason the page refuses and sends nothing; with one it posts.
    await page.click(rowOf(REJECT_KEY));
    await page.click('.foot [data-act="reject"]');
    await page.waitForSelector('.foot .reason[data-error]');
    assert.equal(verdicts.length, 1, 'a reject with no reason must not reach the backend');
    await page.fill('#reason', REJECT_REASON);
    await press(page, '.foot [data-act="reject"]', '/api/verdict');
    await page.waitForSelector('.foot .next');

    // 3. Press Fix on the approved third finding. The tabs hide while a finding is open, so close it first.
    await page.click('.close');
    await page.click('.stab[data-status="approved"]');
    await page.click(rowOf(FIX_KEY));
    await press(page, '.foot [data-act="fix"]', '/api/run/fix');
    await page.waitForSelector('.foot .result');
    assert.match(await page.textContent('.foot .result') ?? '', /Fix started/);

    assert.deepEqual(verdicts, [
      { site: SITE, key: APPROVE_KEY, status: 'approved', reason: CONSOLE_APPROVE_REASON },
      { site: SITE, key: REJECT_KEY, status: 'rejected', reason: REJECT_REASON },
    ]);
    assert.deepEqual(fixes, [{ site: SITE, key: FIX_KEY }]);
    assert.deepEqual(pageErrors, []);
  } finally {
    await page.close();
  }
});
