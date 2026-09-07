import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockActivityEnvironment } from '@temporalio/testing';
import { auditUrl } from '../../src/lib/audit-engine.js';
import type { AuditRunners } from '../../src/lib/audit-engine.js';
import { AUDIT_USER_AGENT } from '../../src/lib/agent-audit/safe-fetch.js';

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
 * tool was asked for, not what Chrome then did with it. `Verify 2` of this
 * build's handoff measured the same thing on the wire.
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

test('auditLiveUrl audits as steward-audit', async () => {
  const { runners, axeOpts, lighthouseOpts } = recordingRunners();
  const env = new MockActivityEnvironment();
  await env.run(() => auditLiveUrl('https://www.mattpyle.com/', { runners }));

  assert.equal(axeOpts[0].userAgent, AUDIT_USER_AGENT);
  assert.deepEqual(lighthouseOpts[0].flags, { emulatedUserAgent: AUDIT_USER_AGENT });
  assert.match(AUDIT_USER_AGENT, /^steward-audit\//);
});
