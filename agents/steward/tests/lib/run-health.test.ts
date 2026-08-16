import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_WARNING_DAYS,
  HEALTH_CHECK_SLUGS,
  TRACKED_CREDENTIALS,
  credentialExpiryShape,
  credentialsDueWithin,
  daysUntilExpiry,
  deepAuditShape,
  healthPingUrl,
  scorecardRunShape,
  type TrackedCredential,
} from '../../src/lib/run-health.js';

/**
 * The alerting rules, which are the whole of the alerting decision: everything
 * downstream of here is one HTTP POST.
 *
 * The two shape rules exist because both of the hosted worker's first-day
 * failures were success-shaped (build-log entry 30, postscript 2), so these
 * tests are written against those two incidents rather than against the general
 * idea of a bad run.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// --- the scorecard's rule ---------------------------------------------------

test('a run where every page was audited is a good shape', () => {
  const shape = scorecardRunShape({
    pages: [
      { url: 'https://www.mattpyle.com/', ok: true },
      { url: 'https://www.mattpyle.com/about', ok: true },
    ],
    decision: 'no-op',
    iso: '2026-08-16',
  });
  assert.equal(shape.ok, true);
  assert.match(shape.summary, /2 page\(s\) audited, none failed/);
});

test('one failed page out of many is a bad shape — the rule is a count, not a ratio', () => {
  // The 2026-08-15 incident in miniature: the run completed, the numbers were
  // published-shaped, and every axe run had failed. A ratio rule would have
  // called 1-of-23 healthy.
  const pages = Array.from({ length: 23 }, (_, i) => ({
    url: `https://www.mattpyle.com/p${i}`,
    ok: i !== 7,
    error: i === 7 ? 'axe produced no result file (exit -1)' : undefined,
  }));
  const shape = scorecardRunShape({ pages, decision: 'open-pr', iso: '2026-08-15' });
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /1 of 23 page\(s\) could not be audited/);
  assert.match(shape.summary, /axe produced no result file/);
});

test('the failure summary names a handful of pages and counts the rest', () => {
  const pages = Array.from({ length: 12 }, (_, i) => ({ url: `https://x.test/${i}`, ok: false }));
  const shape = scorecardRunShape({ pages, decision: 'open-pr', iso: '2026-08-15' });
  // Bounded because the body is quoted into an email, and twelve URLs is a wall
  // rather than a message.
  assert.equal(shape.summary.match(/https:\/\/x\.test\//g)?.length, 5);
  assert.match(shape.summary, /and 7 more/);
});

// --- the deep tier's rule ---------------------------------------------------

test('zero rendered pages from a nonzero sample is a bad shape', () => {
  const shape = deepAuditShape({ origin: 'https://example.test', sampled: 3, rendered: 0 });
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /0 of 3 sampled page\(s\) rendered/);
});

test('one rendered page of three is a good shape — partial coverage is reported, not alerted', () => {
  const shape = deepAuditShape({ origin: 'https://example.test', sampled: 3, rendered: 1 });
  assert.equal(shape.ok, true);
});

test('a sample of zero is a good shape', () => {
  // A site whose robots.txt refuses the auditor, or one with nothing to sample,
  // legitimately renders nothing and the report says so. Alerting here would
  // fire on the target's choices rather than on this stack's health.
  const shape = deepAuditShape({ origin: 'https://example.test', sampled: 0, rendered: 0 });
  assert.equal(shape.ok, true);
});

// --- credential expiry ------------------------------------------------------

const NOW = Date.parse('2026-08-15T12:00:00Z');

function credential(name: string, expires: string): TrackedCredential {
  return { name, expires, failure: 'something breaks' };
}

test('a credential is usable through the whole of its expiry day', () => {
  // Not the start of the day: warning "0 days left" on a morning the token
  // still works reads as already-broken.
  assert.equal(daysUntilExpiry('2026-08-15', NOW), 0);
  assert.equal(daysUntilExpiry('2026-08-16', NOW), 1);
  assert.equal(daysUntilExpiry('2026-08-14', NOW), -1);
});

test('nothing inside the window is silence, and the summary still names the nearest', () => {
  const shape = credentialExpiryShape([credential('a key', '2027-01-01')], NOW);
  assert.equal(shape.ok, true);
  assert.match(shape.summary, /the nearest is a key, 139 days out/);
});

test('a credential inside the window fails the check and says what breaks', () => {
  const soon = new Date(NOW + 10 * DAY).toISOString().slice(0, 10);
  const shape = credentialExpiryShape([credential('a key', soon)], NOW);
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /a key expires in 10 day\(s\)/);
  assert.match(shape.summary, /something breaks/);
  // Points at the private guide rather than reproducing it.
  assert.match(shape.summary, /"Rotating a credential" in the steward user guide/);
});

test('the boundary is inclusive, and a day outside it is silent', () => {
  const inside = new Date(NOW + CREDENTIAL_WARNING_DAYS * DAY).toISOString().slice(0, 10);
  const outside = new Date(NOW + (CREDENTIAL_WARNING_DAYS + 2) * DAY).toISOString().slice(0, 10);
  assert.equal(credentialExpiryShape([credential('k', inside)], NOW).ok, false);
  assert.equal(credentialExpiryShape([credential('k', outside)], NOW).ok, true);
});

test('an already-expired credential says so rather than counting down past zero', () => {
  const shape = credentialExpiryShape([credential('a key', '2026-08-01')], NOW);
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /EXPIRED 14 day\(s\) ago on 2026-08-01/);
});

test('the soonest credential is listed first', () => {
  const shape = credentialExpiryShape(
    [credential('later', '2026-09-10'), credential('sooner', '2026-08-20')],
    NOW,
    60,
  );
  assert.ok(shape.summary.indexOf('sooner') < shape.summary.indexOf('later'));
});

test('the tracked list is real, dated, and matches what the summary counts', () => {
  // The list is the feature (card, task 4): a credential with a fixed lifetime
  // that is not in here is one nothing will warn about.
  assert.ok(TRACKED_CREDENTIALS.length >= 2);
  for (const c of TRACKED_CREDENTIALS) {
    assert.match(c.expires, /^\d{4}-\d{2}-\d{2}$/, `${c.name} needs a YYYY-MM-DD expiry`);
    assert.ok(c.failure.length > 0, `${c.name} needs failure prose`);
  }
  const due = credentialsDueWithin(TRACKED_CREDENTIALS, NOW);
  assert.equal(credentialExpiryShape(TRACKED_CREDENTIALS, NOW).ok, due.length === 0);
});

test('no tracked credential names where its copies live — this file is public', () => {
  // The boundary rule, from the secret-management card: credential metadata
  // defaults private, and public code carries only what an alert body needs.
  // `agents/steward/` is public, and a list of every place a token is stored is
  // a map worth more to a stranger than to the operator, who owns the secrets
  // and does not need an email telling him where they are. The locations live
  // in the private user guide under "Rotating a credential", and the alert
  // points at it by name.
  //
  // Asserted over the serialised rows *and* the rendered summary, because the
  // leak this guards against is a helpful sentence added to either one.
  const soon = new Date(NOW + 5 * DAY).toISOString().slice(0, 10);
  const surfaces = [
    JSON.stringify(TRACKED_CREDENTIALS),
    credentialExpiryShape(TRACKED_CREDENTIALS, NOW).summary,
    credentialExpiryShape([credential('a key', soon)], NOW).summary,
  ];
  for (const surface of surfaces) {
    for (const marker of ['.env', 'Variables', 'Railway', 'agents/steward/.env', 'TEMPORAL_API_KEY', 'GITHUB_TOKEN']) {
      assert.ok(
        !surface.includes(marker),
        `"${marker}" names a credential's storage location and must stay in the private guide`,
      );
    }
  }
});

// --- the ping URL -----------------------------------------------------------

test('a healthy signal pings the slug and a failed one pings /fail under it', () => {
  const base = 'https://hc-ping.com/KEY';
  assert.equal(healthPingUrl(base, 'nightly-scorecard', true), `${base}/steward-nightly-scorecard`);
  assert.equal(
    healthPingUrl(base, 'nightly-scorecard', false),
    `${base}/steward-nightly-scorecard/fail`,
  );
});

test('a trailing slash on the configured base does not double up', () => {
  assert.equal(healthPingUrl('https://hc-ping.com/KEY/', 'run-shape', true), 'https://hc-ping.com/KEY/steward-run-shape');
});

test('every signal has a distinct slug', () => {
  const slugs = Object.values(HEALTH_CHECK_SLUGS);
  assert.equal(new Set(slugs).size, slugs.length);
});
