import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRunners, type AuditEngine } from '../../src/lib/agent-audit/deep.js';
import { AUDIT_USER_AGENT } from '../../src/lib/agent-audit/safe-fetch.js';
import type { VettingProxy } from '../../src/lib/agent-audit/vetting-proxy.js';

/**
 * The hand-off from the vetting proxy to the browser, without a browser.
 *
 * `agent-audit-deep.test.ts` injects fake runners, so it never reaches the code
 * that passes the proxy's flags on. Dropping either hand-off in `defaultRunners`
 * would let Lighthouse or axe reach the network unproxied while those tests
 * stay green. This file calls the real `defaultRunners` with a fake audit engine
 * in place of `audit-engine.ts` and asserts on what the engine receives. The
 * real-browser test, `agent-audit-deep-chrome.test.ts`, shows that Chrome then
 * honours the flags; CI runs it when a PR touches the browser runners.
 */

/** Flags no real proxy would carry, so a match can only come from the hand-off. */
const PROXY = {
  port: 1,
  chromeFlags: ['--proxy-server=127.0.0.1:1', '--proxy-bypass-list=<-loopback>'],
  chromeOptions: ['proxy-server=127.0.0.1:1', 'proxy-bypass-list=<-loopback>'],
  blocked: [],
  close: async () => {},
} satisfies VettingProxy;

interface Calls {
  lighthouse: { url: string; opts: { flags?: Record<string, unknown>; chromeFlags?: string[] } }[];
  axe: { url: string; opts: { userAgent?: string; chromeOptions?: string[] } }[];
}

function fakeEngine(): { engine: AuditEngine; calls: Calls } {
  const calls: Calls = { lighthouse: [], axe: [] };
  const engine = {
    async runLighthouse(url, _signal, opts = {}) {
      calls.lighthouse.push({ url, opts });
      return { categories: {}, audits: {} } as never;
    },
    async runAxe(url, _signal, opts = {}) {
      calls.axe.push({ url, opts });
      return { violations: [], raw: [] };
    },
  } satisfies AuditEngine;
  return { engine, calls };
}

test('the Lighthouse runner hands the proxy flags to the launcher beside the identity flag', async () => {
  const { engine, calls } = fakeEngine();
  await defaultRunners(async () => engine).lighthouse('https://example.com/', 5_000, PROXY);

  assert.equal(calls.lighthouse.length, 1);
  assert.deepEqual(calls.lighthouse[0].opts.chromeFlags, [`--user-agent=${AUDIT_USER_AGENT}`, ...PROXY.chromeFlags]);
});

test('the axe runner hands the proxy options to the launcher with the identity', async () => {
  const { engine, calls } = fakeEngine();
  await defaultRunners(async () => engine).axe('https://example.com/', 5_000, PROXY);

  assert.equal(calls.axe.length, 1);
  assert.deepEqual(calls.axe[0].opts.chromeOptions, PROXY.chromeOptions);
  assert.equal(calls.axe[0].opts.userAgent, AUDIT_USER_AGENT);
});
