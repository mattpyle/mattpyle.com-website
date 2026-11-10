import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_RATE_ALERT_PER_SECOND,
  HEALTH_CHECK_SLUGS,
  findingsRecheckSignal,
  healthCheckSlug,
  actionUsageShape,
  actionUsageUnavailableShape,
  deepAuditShape,
  healthPingUrl,
  recheckShape,
  scorecardRunShape,
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

test('pages measured by two Lighthouse versions are a bad shape naming each version and its page count', () => {
  const pages = [
    { url: 'https://www.mattpyle.com/', ok: true, lighthouseVersion: '13.5.0' },
    { url: 'https://www.mattpyle.com/a', ok: true, lighthouseVersion: '13.4.1' },
    { url: 'https://www.mattpyle.com/b', ok: true, lighthouseVersion: '13.4.1' },
    { url: 'https://www.mattpyle.com/c', ok: true },
  ];
  const shape = scorecardRunShape({ pages, decision: 'no-op', iso: '2026-10-29' });
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /Lighthouse 13\.5\.0 on 1 page\(s\), Lighthouse 13\.4\.1 on 2 page\(s\)/);
});

test('one Lighthouse version, or none, across the pages is a good shape', () => {
  const same = scorecardRunShape({
    pages: [
      { url: 'u1', ok: true, lighthouseVersion: '13.5.0' },
      { url: 'u2', ok: true, lighthouseVersion: '13.5.0' },
      { url: 'u3', ok: true },
    ],
    decision: 'no-op',
    iso: '2026-10-29',
  });
  assert.equal(same.ok, true);
});

const MERGE_PAGES = { pages: [{ url: 'https://www.mattpyle.com/', ok: true }], decision: 'open-pr', iso: '2026-11-10' };
const PR = 'https://github.com/o/r/pull/9';

test('a merged run-log PR keeps the run healthy and names the merge commit', () => {
  const shape = scorecardRunShape({ ...MERGE_PAGES, merge: { merged: true, mergeSha: 'abc123', prUrl: PR } });
  assert.equal(shape.ok, true);
  assert.match(shape.summary, /merged as abc123/);
});

for (const condition of ['wrong-pr', 'extra-files', 'head-moved', 'checks-failed', 'checks-pending', 'github-refused', 'error']) {
  test(`a run-log PR left open for ${condition} is a bad shape that names the condition and the PR`, () => {
    const shape = scorecardRunShape({ ...MERGE_PAGES, merge: { merged: false, condition, detail: 'the reason', prUrl: PR } });
    assert.equal(shape.ok, false);
    assert.ok(shape.summary.includes(`(${condition})`), shape.summary);
    assert.ok(shape.summary.includes('the reason'));
    assert.ok(shape.summary.includes(PR));
    assert.match(shape.summary, /run and its archive are good/);
  });
}

test('a refused merge on a run with a failed page reports both problems', () => {
  const shape = scorecardRunShape({
    pages: [
      { url: 'https://www.mattpyle.com/', ok: true },
      { url: 'https://www.mattpyle.com/x/', ok: false, error: 'timeout' },
    ],
    decision: 'open-pr',
    iso: '2026-11-10',
    merge: { merged: false, condition: 'checks-failed', detail: 'failing: axe', prUrl: PR },
  });
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /checks-failed/);
  assert.match(shape.summary, /1 of 2 page\(s\) could not be audited/);
});

test('one failed page out of many is a bad shape — the rule is a count, not a ratio', () => {
  // The 2026-08-15 incident in miniature: the run completed, the numbers were
  // published-shaped, and every axe run had failed. A ratio rule would have
  // called 1-of-23 healthy.
  const pages = Array.from({ length: 23 }, (_, i) => ({
    url: `https://www.mattpyle.com/p${i}/`,
    ok: i !== 7,
    error: i === 7 ? 'axe produced no result file (exit -1)' : undefined,
  }));
  const shape = scorecardRunShape({ pages, decision: 'open-pr', iso: '2026-08-15' });
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /1 of 23 page\(s\) could not be audited/);
  assert.match(shape.summary, /axe produced no result file/);
});

// The 2026-09-27 chromedriver outage: every page errored, the run scored the
// site 0 and opened a run-log PR six nights running. These three pin the split
// the workflow now makes at step 3, from the alert's side.

test('a run where every page failed is a bad shape that says no run-log PR opened', () => {
  const pages = Array.from({ length: 26 }, (_, i) => ({
    url: `https://www.mattpyle.com/p${i}/`,
    ok: false,
    error: 'session not created: chromedriver only supports Chrome version 140',
  }));
  const shape = scorecardRunShape({ pages, decision: 'no-op', iso: '2026-09-27' });
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /0 of 26 page\(s\) could be audited/);
  assert.match(shape.summary, /No run-log PR opened/);
  assert.match(shape.summary, /chromedriver only supports/);
});

test('one failed page keeps the partial-failure summary, which allows for a PR', () => {
  const pages = [
    { url: 'https://www.mattpyle.com/', ok: true },
    { url: 'https://www.mattpyle.com/broken/', ok: false, error: 'Lighthouse timed out' },
  ];
  const shape = scorecardRunShape({ pages, decision: 'open-pr', iso: '2026-09-27' });
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /1 of 2 page\(s\) could not be audited/);
  assert.match(shape.summary, /run-log PR \(if one opened\)/);
  assert.doesNotMatch(shape.summary, /No run-log PR opened/);
});

test('a healthy run keeps its summary', () => {
  const pages = [
    { url: 'https://www.mattpyle.com/', ok: true },
    { url: 'https://www.mattpyle.com/about/', ok: true },
  ];
  const shape = scorecardRunShape({ pages, decision: 'open-pr', iso: '2026-09-27' });
  assert.equal(shape.ok, true);
  assert.equal(shape.summary, 'Scorecard 2026-09-27: 2 page(s) audited, none failed, decision open-pr.');
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

// --- the recheck rule ---------------------------------------------------------

type RecheckRows = Parameters<typeof recheckShape>[0]['rows'];
const recheck = (rows: RecheckRows) => ({ site: 'temporal-io', at: '2026-11-09T03:30:00.000Z', rows });

test('a recheck with no approved finding is healthy and says so', () => {
  const shape = recheckShape(recheck([]));
  assert.equal(shape.ok, true);
  assert.equal(shape.summary, 'Findings recheck of temporal-io: no approved finding to recheck.');
});

test('resolved, still present, no checks, open run and skipped rows are all healthy', () => {
  const shape = recheckShape(
    recheck([
      { key: 'a', outcome: 'resolved' },
      { key: 'b', outcome: 'still present' },
      { key: 'c', outcome: 'no checks' },
      { key: 'd', outcome: 'has an open run' },
      { key: 'e', outcome: 'skipped' },
    ]),
  );
  assert.equal(shape.ok, true);
  assert.match(shape.summary, /^Findings recheck of temporal-io: 5 approved, /);
});

for (const outcome of ['write failed', 'could not measure'] as const) {
  test(`one ${outcome} row makes the run a bad shape and the body names the finding`, () => {
    const shape = recheckShape(
      recheck([
        { key: 'fine', outcome: 'resolved' },
        { key: 'broken', keyShort: 'TI-9', outcome, detail: 'the reason' },
      ]),
    );
    assert.equal(shape.ok, false);
    assert.ok(shape.summary.startsWith('Findings recheck of temporal-io: 2 approved, '));
    assert.ok(shape.summary.includes(`1 of 2 finding(s) were not rechecked cleanly: TI-9 ${outcome} (the reason).`));
    assert.match(shape.summary, /live_on may be stale/);
  });
}

test('a bad recheck names five findings and counts the rest', () => {
  const rows: RecheckRows = Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, outcome: 'write failed' as const }));
  const shape = recheckShape(recheck(rows));
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /k0 write failed; k1 write failed; k2 write failed; k3 write failed; k4 write failed, and 2 more\./);
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

test('the recheck signal is per site and its slug names the site', () => {
  assert.equal(findingsRecheckSignal('temporal-io'), 'findings-recheck:temporal-io');
  assert.equal(healthCheckSlug(findingsRecheckSignal('temporal-io')), 'steward-findings-recheck-temporal-io');
  assert.equal(healthCheckSlug('findings-reconcile'), 'steward-findings-reconcile');
  const base = 'https://hc-ping.com/KEY';
  assert.equal(
    healthPingUrl(base, findingsRecheckSignal('temporal-io'), true),
    `${base}/steward-findings-recheck-temporal-io`,
  );
  assert.equal(
    healthPingUrl(base, findingsRecheckSignal('temporal-io'), false),
    `${base}/steward-findings-recheck-temporal-io/fail`,
  );
  assert.notEqual(
    healthCheckSlug(findingsRecheckSignal('mattpyle-com')),
    healthCheckSlug(findingsRecheckSignal('temporal-io')),
  );
});

// --- the action-usage rule --------------------------------------------------

/**
 * The threshold rule, and the two bodies it produces.
 *
 * The bodies are asserted as hard as the verdict is, which is unusual for prose
 * and deliberate here. The failing body is the whole of what Matt gets at three
 * in the morning: if it does not name the workflow type, the alert says only
 * that something is wrong and leaves the diagnosis where it started. The healthy
 * body is the record the threshold gets tuned from — the alerting service keeps
 * every ping's body, so a week of them is the dataset, and an OK body that said
 * only "fine" would throw that away one night at a time.
 */

function sample(overrides: Partial<Parameters<typeof actionUsageShape>[0]> = {}) {
  return {
    namespace: 'steward.acct1',
    foregroundPerSecond: 0.25,
    billable: [
      { actionType: 'signal_workflow', workflowType: 'scorecardAuditWorkflow', rate: 0.133 },
      { actionType: 'start_workflow', workflowType: 'metricsProbeWorkflow', rate: 0.05 },
    ],
    idle: false,
    ...overrides,
  };
}

test('a rate below the threshold is a good shape, and says what it observed', () => {
  const shape = actionUsageShape(sample());
  assert.equal(shape.ok, true);
  assert.match(shape.summary, /0\.25\/s/);
  assert.match(shape.summary, /5\.00\/s/);
  assert.match(shape.summary, /scorecardAuditWorkflow/);
});

test('a rate exactly at the threshold is still a good shape', () => {
  // The rule is "above", not "at or above". A boundary that alerts is a
  // boundary that alerts on the first night the threshold is tuned to the
  // observed maximum, which is exactly how it will be tuned.
  const shape = actionUsageShape(sample({ foregroundPerSecond: ACTION_RATE_ALERT_PER_SECOND }));
  assert.equal(shape.ok, true);
});

test('a rate above the threshold fails, naming the rate, the threshold and where to look', () => {
  const shape = actionUsageShape(sample({ foregroundPerSecond: 47.5 }));
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /47\.50\/s/);
  assert.match(shape.summary, /5\.00\/s/);
  assert.match(shape.summary, /cloud\.temporal\.io\/usage/);
});

test('a failing body names the top three billable rows and no more', () => {
  const busy = sample({
    foregroundPerSecond: 60,
    billable: [
      { actionType: 'start_workflow', workflowType: 'runawayLoop', rate: 40 },
      { actionType: 'signal_workflow', workflowType: 'secondBusiest', rate: 12 },
      { actionType: 'start_workflow', workflowType: 'thirdBusiest', rate: 3 },
      { actionType: 'start_workflow', workflowType: 'fourthBusiest', rate: 1 },
    ],
  });
  const shape = actionUsageShape(busy);
  // The workflow type is the actionable half: it is what somebody terminates.
  assert.match(shape.summary, /runawayLoop/);
  assert.match(shape.summary, /secondBusiest/);
  assert.match(shape.summary, /thirdBusiest/);
  assert.ok(!shape.summary.includes('fourthBusiest'), 'four rows in an email is a list, not an alert');
});

test('an idle sample is a good shape that says the minute was idle, not zero', () => {
  // The difference matters to whoever reads the check's history: "0.00/s" reads
  // as a measurement and "no series at all" reads as the namespace at rest,
  // and only one of them is what the endpoint actually reported.
  const shape = actionUsageShape(sample({ foregroundPerSecond: 0, billable: [], idle: true }));
  assert.equal(shape.ok, true);
  assert.match(shape.summary, /idle/);
  assert.ok(!shape.summary.includes('0.00/s'));
});

test('a good shape with no billable series still reads as a sentence', () => {
  const shape = actionUsageShape(sample({ foregroundPerSecond: 0.05, billable: [] }));
  assert.equal(shape.ok, true);
  assert.match(shape.summary, /no billable series/);
});

test('a sample that could not be taken is a failure that names the reason', () => {
  const shape = actionUsageUnavailableShape('steward.acct1', 'the metrics endpoint answered 401');
  assert.equal(shape.ok, false);
  assert.match(shape.summary, /401/);
  // And says the run itself is fine, because the first instinct on an alert at
  // 03:42 is that the nightly scorecard broke.
  assert.match(shape.summary, /Nothing else in the run is affected/);
});
