import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runDeepChecks } from '../../src/lib/agent-audit/deep.js';
import { DEFAULT_POLICY } from '../../src/lib/agent-audit/safe-fetch.js';

/**
 * The Chrome-side SSRF closures, with a real browser.
 *
 * Opt-in (`STEWARD_CHROME_TESTS=1`), because it launches Chrome four times and
 * takes minutes, which is not something the suite should pay on every run. The
 * proxy's own behaviour is covered without a browser in
 * `agent-audit-vetting-proxy.test.ts`; what only a real Chrome can show is the
 * part in between — that `defaultRunners` actually hands the proxy flags to both
 * Lighthouse and axe, that Chrome honours them, and that removing the loopback
 * bypass is enough to stop it going around the proxy. Those are the pieces a
 * unit test asserts about a value rather than about a browser.
 *
 * Run it after any change to the launch flags:
 *
 *   STEWARD_CHROME_TESTS=1 node --import tsx --test tests/lib/agent-audit-deep-chrome.test.ts
 */

const ENABLED = process.env.STEWARD_CHROME_TESTS === '1';

/** The address every refusal in here is about: the cloud metadata service. */
const METADATA = 'http://169.254.169.254/latest/meta-data/';

/**
 * A two-page site that does the two things Chrome used to do unsupervised: pull
 * a subresource from a blocked address, and redirect to one.
 */
async function hostileSite(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/redirected/') {
      res.writeHead(302, { location: METADATA });
      return res.end();
    }
    if (url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hostile page</title></head>` +
        `<body><h1>Hostile page</h1>` +
        `<img src="${METADATA}logo.png" alt="a subresource on a link-local address">` +
        `</body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test(
  'a real Chrome is refused both the blocked subresource and the blocked redirect target',
  { skip: ENABLED ? false : 'set STEWARD_CHROME_TESTS=1 to run the browser tests', timeout: 600_000 },
  async (t) => {
    const site = await hostileSite();
    t.after(() => site.close());

    const { notes, renderedPages } = await runDeepChecks(
      {
        candidates: [`${site.origin}/`, `${site.origin}/redirected/`],
        remainingMs: () => 600_000,
        // The mock site is on loopback, which is the address the guard exists to
        // refuse; the exemption covers that one host and nothing else, so
        // 169.254.169.254 is still refused exactly as it would be in a real run.
        policy: { ...DEFAULT_POLICY, allowedPrivateHosts: ['127.0.0.1'] },
        robotsDetail: async () => null,
      },
      { maxPages: 2, pageTimeoutMs: 150_000 },
    );

    assert.equal(renderedPages, 2, notes.join(' | '));
    const refusals = notes.filter((n) => /the browser was refused/.test(n));
    assert.ok(
      refusals.some((n) => n.includes(`${METADATA}logo.png`)),
      `no refusal for the subresource:\n${notes.join('\n')}`,
    );
    assert.ok(
      refusals.some((n) => n.includes(METADATA) && !n.includes('logo.png')),
      `no refusal for the redirect target:\n${notes.join('\n')}`,
    );
    for (const line of refusals) assert.match(line, /link-local/);
  },
);
