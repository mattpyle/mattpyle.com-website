import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openChromeProbe, settleExpression, DEFAULT_SETTLE } from '../../src/lib/chrome-probe.js';
import { runChecks, type VerifyCheck } from '../../src/lib/verify-checks.js';

/**
 * The settle rule, in a real Chrome: a `selector` check measures an element
 * that appears two seconds after the load event, the way temporal.io's
 * consent banner does.
 *
 * Opt-in (`STEWARD_CHROME_TESTS=1`), like `agent-audit-deep-chrome.test.ts`.
 * CI sets the flag on a pull request that touches `chrome-probe.ts`. Run it
 * locally from `agents/steward`:
 *
 *   $env:STEWARD_CHROME_TESTS = '1'; node --import tsx --import ./tests/helpers/no-real-credentials.ts --test tests/lib/chrome-probe-settle.test.ts
 *
 * The second test is the probe that the first can fail: with no settle wait,
 * the same check measures before the element exists.
 */

const ENABLED = process.env.STEWARD_CHROME_TESTS === '1';

const LATE_PAGE = `<!doctype html><html><head><title>late</title></head><body><main>page</main>
<script>
window.addEventListener('load', () => {
  setTimeout(() => {
    const banner = document.createElement('div');
    banner.id = 'late-banner';
    banner.textContent = 'We use cookies';
    document.body.appendChild(banner);
  }, 2000);
});
</script></body></html>`;

async function lateSite(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LATE_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const check = (origin: string): VerifyCheck => ({
  url: `${origin}/`,
  kind: 'selector',
  expect: { selector: '#late-banner', count: 1 },
});

test('the settle expression names the rule it waits by', () => {
  const expression = settleExpression(DEFAULT_SETTLE);
  assert.match(expression, /MutationObserver/);
  assert.match(expression, new RegExp(`>= ${DEFAULT_SETTLE.minMs}`));
  assert.match(expression, new RegExp(`>= ${DEFAULT_SETTLE.maxMs}`));
});

test('a selector check sees an element that appears two seconds after load', { skip: !ENABLED, timeout: 120_000 }, async () => {
  const site = await lateSite();
  try {
    const [row] = await runChecks([check(site.origin)], {
      fetch,
      openProbe: () => openChromeProbe({ userAgent: 'steward-test' }),
      userAgent: 'steward-test',
    });
    assert.equal(row.pass, true, row.measured);
    assert.equal(row.measured, '1 elements');
  } finally {
    await site.close();
  }
});

test('without the settle wait the same check measures too early', { skip: !ENABLED, timeout: 120_000 }, async () => {
  const site = await lateSite();
  try {
    const [row] = await runChecks([check(site.origin)], {
      fetch,
      openProbe: () => openChromeProbe({ userAgent: 'steward-test', settle: { minMs: 0, quietMs: 0, maxMs: 0 } }),
      userAgent: 'steward-test',
    });
    assert.equal(row.pass, false);
    assert.equal(row.measured, '0 elements');
  } finally {
    await site.close();
  }
});
