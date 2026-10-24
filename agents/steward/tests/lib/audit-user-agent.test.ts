import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockActivityEnvironment } from '@temporalio/testing';
import { auditUrl } from '../../src/lib/audit-engine.js';
import type { AuditRunners } from '../../src/lib/audit-engine.js';
import { AUDIT_USER_AGENT } from '../../src/lib/agent-audit/safe-fetch.js';
import type { PageAuditOutcome } from '../../src/lib/scorecard-aggregate.js';

/**
 * One identity, three places.
 *
 * Lighthouse sends requests from two of them — the page it emulates and the
 * browser its own gatherers fetch robots.txt and llms.txt from — and axe's
 * Chrome is the third. Setting fewer than three leaves some of the run
 * arriving as `HeadlessChrome`, which is the bug this covers; it was found on
 * the deep tier by pointing it at a server that logged what it was asked by
 * whom, and `auditUrl` now has to reproduce that wiring for the nightly
 * scorecard.
 *
 * Stub runners rather than a real browser: what is under test is what each
 * tool was asked for, not what Chrome then did with it. To confirm the header
 * actually reaches the wire, point `auditLiveUrl` at a local server that logs
 * every request's `User-Agent`; each one starts with `steward-audit/`.
 */

/** Every option the two tools were handed, captured. */
function recordingRunners(): {
  runners: AuditRunners;
  axeOpts: Array<Record<string, unknown>>;
  lighthouseOpts: Array<Record<string, unknown>>;
} {
  const axeOpts: Array<Record<string, unknown>> = [];
  const lighthouseOpts: Array<Record<string, unknown>> = [];
  const runners: AuditRunners = {
    async axe(_url, _signal, opts = {}) {
      axeOpts.push(opts as Record<string, unknown>);
      return { violations: [], raw: [] };
    },
    async lighthouse(_url, _signal, opts = {}) {
      lighthouseOpts.push(opts as Record<string, unknown>);
      return {} as Awaited<ReturnType<AuditRunners['lighthouse']>>;
    },
  };
  return { runners, axeOpts, lighthouseOpts };
}

const UA = 'steward-audit/9.9.9 (+https://example.test/steward)';

test('auditUrl sets the User-Agent in all three places', async () => {
  const { runners, axeOpts, lighthouseOpts } = recordingRunners();
  await auditUrl('https://example.test/', new AbortController().signal, {
    userAgent: UA,
    runners,
  });

  assert.equal(axeOpts.length, 1);
  assert.equal(axeOpts[0].userAgent, UA);

  assert.equal(lighthouseOpts.length, 1);
  assert.deepEqual(lighthouseOpts[0].flags, { emulatedUserAgent: UA });
  assert.deepEqual(lighthouseOpts[0].chromeFlags, [`--user-agent=${UA}`]);
});

test('auditUrl without a User-Agent leaves both tools at Chrome defaults', async () => {
  const { runners, axeOpts, lighthouseOpts } = recordingRunners();
  await auditUrl('https://example.test/', new AbortController().signal, { runners });

  assert.equal(axeOpts[0].userAgent, undefined);
  assert.equal(lighthouseOpts[0].flags, undefined);
  assert.equal(lighthouseOpts[0].chromeFlags, undefined);
});

// config.ts resolves SITE_DIR at import time, so the activity module needs the
// fixture root the other activity tests use before it is imported.
process.env.STEWARD_SITE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);
const { auditLiveUrl } = await import('../../src/activities/scorecard.js');

/**
 * The reading-budget fetches, answered here: a fourth place the identity has to
 * reach, since `auditLiveUrl` fetches the page twice more, as HTML and as markdown,
 * beside the two browser tools. Records what each request asked for.
 */
function recordingFetch(): { fetch: typeof fetch; asked: Array<{ accept: string; ua: string }> } {
  const asked: Array<{ accept: string; ua: string }> = [];
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const accept = headers.get('accept') ?? '';
    asked.push({ accept, ua: headers.get('user-agent') ?? '' });
    return accept.includes('markdown')
      ? new Response('---\ntitle: Home\n---\n\n# Home\n\nHello.\n', { headers: { 'content-type': 'text/markdown' } })
      : new Response('<!doctype html><nav><a href="/">Home</a></nav><main><p>Hello there, reader.</p></main>', {
          headers: { 'content-type': 'text/html' },
        });
  }) as typeof fetch;
  return { fetch: impl, asked };
}

test('auditLiveUrl audits as steward-audit', async () => {
  const { runners, axeOpts, lighthouseOpts } = recordingRunners();
  const { fetch: fetchImpl, asked } = recordingFetch();
  const env = new MockActivityEnvironment();
  const outcome = (await env.run(() => auditLiveUrl('https://www.mattpyle.com/', { runners, fetch: fetchImpl }))) as PageAuditOutcome;

  assert.equal(axeOpts[0].userAgent, AUDIT_USER_AGENT);
  assert.deepEqual(lighthouseOpts[0].flags, { emulatedUserAgent: AUDIT_USER_AGENT });
  assert.match(AUDIT_USER_AGENT, /^steward-audit\//);

  // The two reading-budget fetches carry the same identity, and ask for each
  // variant by name.
  assert.deepEqual(asked, [
    { accept: 'text/html', ua: AUDIT_USER_AGENT },
    { accept: 'text/markdown', ua: AUDIT_USER_AGENT },
  ]);
  assert.ok(outcome.ok);
  assert.ok(outcome.ok && outcome.readingBudget, 'the page carries its reading budget');
  if (outcome.ok && outcome.readingBudget) {
    assert.ok(outcome.readingBudget.text.share > 0 && outcome.readingBudget.text.share < 100);
    assert.ok(outcome.readingBudget.markdown && outcome.readingBudget.markdown.share < 100);
  }
});

test('auditLiveUrl keeps the page when the reading-budget fetch fails', async () => {
  const { runners } = recordingRunners();
  const failing = (async () => {
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;
  const env = new MockActivityEnvironment();
  const outcome = (await env.run(() => auditLiveUrl('https://www.mattpyle.com/', { runners, fetch: failing }))) as PageAuditOutcome;
  assert.ok(outcome.ok);
  assert.equal(outcome.ok && outcome.readingBudget, undefined);
});

test('auditLiveUrl carries the Lighthouse version the report stamped', async () => {
  const { runners } = recordingRunners();
  const stamped: AuditRunners = {
    ...runners,
    async lighthouse(...args) {
      const lhr = await runners.lighthouse(...args);
      return { ...lhr, lighthouseVersion: '13.5.0' };
    },
  };
  const { fetch: fetchImpl } = recordingFetch();
  const env = new MockActivityEnvironment();
  const outcome = (await env.run(() => auditLiveUrl('https://www.mattpyle.com/', { runners: stamped, fetch: fetchImpl }))) as PageAuditOutcome;
  assert.ok(outcome.ok);
  assert.equal(outcome.ok && outcome.lighthouseVersion, '13.5.0');

  // A report with no stamp leaves the field off rather than inventing one.
  const bare = (await env.run(() => auditLiveUrl('https://www.mattpyle.com/', { runners, fetch: fetchImpl }))) as PageAuditOutcome;
  assert.ok(bare.ok);
  assert.equal(bare.ok && 'lighthouseVersion' in bare, false);
});
