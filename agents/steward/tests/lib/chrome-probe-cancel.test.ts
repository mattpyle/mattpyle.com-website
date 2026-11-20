import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CancelledFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { runFindingChecks } from '../../src/activities/verify-finding.js';
import { openChromeProbe } from '../../src/lib/chrome-probe.js';

/**
 * Cancellation in a real Chrome: `runFindingChecks` is cancelled while a page
 * is settling, the attempt ends as cancelled within seconds, and no Chrome
 * process the probe launched is left running.
 *
 * Opt-in (`STEWARD_CHROME_TESTS=1`), like `chrome-probe-settle.test.ts`, and
 * for a system with `ps`. `tests/activities/finding-verify.test.ts` covers the
 * same path on every run with a fake probe. Run it from `agents/steward`:
 *
 *   STEWARD_CHROME_TESTS=1 node --import tsx --import ./tests/helpers/no-real-credentials.ts --test tests/lib/chrome-probe-cancel.test.ts
 *
 * The probe's Chrome is told apart from any other, another test file's
 * included, by a user agent only this test uses: the browser process carries
 * it on its command line, and its profile directory there names the rest.
 */

const ENABLED = process.env.STEWARD_CHROME_TESTS === '1' && process.platform !== 'win32';
const USER_AGENT = `steward-cancel-test-${process.pid}-${Date.now()}`;

/** The command lines of the running processes that mention `needle`. */
function processesWith(needle: string): string[] {
  return execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\n')
    .filter((line) => line.includes(needle));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await sleep(100);
  }
}

test('cancelling a check run in a real Chrome leaves no Chrome process behind', { skip: !ENABLED, timeout: 120_000 }, async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>page</title></head><body><main>page</main></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = new MockActivityEnvironment();
  try {
    const check = { url: `${origin}/`, kind: 'selector' as const, expect: { selector: 'main', count: 1 } };
    const running = env.run(() =>
      runFindingChecks({ key: 'cancel-probe', checks: [check, check] }, { openProbe: () => openChromeProbe({ userAgent: USER_AGENT }) }),
    );
    running.catch(() => {});
    // The page has been asked for, so Chrome is up and the check is in its settle wait of three seconds or more.
    await until('Chrome asks for the page', () => requests > 0);
    const profile = processesWith(USER_AGENT)
      .map((line) => line.match(/--user-data-dir=(\S+)/)?.[1])
      .find((dir) => dir !== undefined);
    assert.ok(profile, 'the probe launched a Chrome with its own profile directory');
    assert.ok(processesWith(profile).length > 0);

    const cancelledAt = Date.now();
    env.cancel();
    await assert.rejects(running, (err: Error) => err instanceof CancelledFailure);
    assert.ok(Date.now() - cancelledAt < 15_000, 'the attempt ended soon after the cancellation');
    await until('every probe Chrome process has exited', () => processesWith(profile).length === 0, 15_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
