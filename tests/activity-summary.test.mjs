import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BAR_CEILING_PERCENT,
  CHART_HOURS,
  buildActivity,
  clientKind,
  hourlySeries,
  lastHourRows,
} from '../src/lib/activity-summary.mjs';
import { epochHour } from '../src/lib/agent-traffic.mjs';

// The derivations behind /activity, against fabricated buckets rather than a store. The layer
// below (rolling windows, the rollup, the transport) is tests/agent-traffic.test.mjs's; this file
// covers what the redesigned page added on top of it.

const NOW = new Date('2026-08-22T06:20:00.000Z');
const NOW_HOUR = epochHour(NOW);

/** @param {number} hoursAgo @param {string} family @param {string} path @param {number} count */
function row(hoursAgo, family, path, count, event = 'surface') {
  return { hour: NOW_HOUR - hoursAgo, event, family, path, count };
}

test('the chart is always 24 buckets, oldest first, ending with the hour in progress', () => {
  const series = hourlySeries([row(0, 'curl', '/llms.txt', 3)], NOW);
  assert.equal(series.length, CHART_HOURS);
  assert.equal(series[0].bucket, NOW_HOUR - (CHART_HOURS - 1));
  assert.equal(series.at(-1).bucket, NOW_HOUR);
  assert.equal(series.at(-1).utcHour, 6);
});

test('an hour with nothing in it draws no bar at all', () => {
  // Not the 4% floor: a stub of colour on an hour that saw no requests is a picture of a number
  // that is not there.
  const series = hourlySeries([row(0, 'curl', '/llms.txt', 9)], NOW);
  assert.equal(series.at(-1).percent, BAR_CEILING_PERCENT);
  assert.equal(series.at(-2).count, 0);
  assert.equal(series.at(-2).percent, 0);
});

test('a single request still draws a visible bar beside a tall one', () => {
  const series = hourlySeries([row(0, 'curl', '/a', 400), row(1, 'curl', '/b', 1)], NOW);
  assert.equal(series.at(-1).percent, BAR_CEILING_PERCENT);
  assert.ok(series.at(-2).percent >= 4, 'a counted hour must not round to nothing');
});

test('ticks are printed every six hours and nowhere else', () => {
  const series = hourlySeries([], NOW);
  for (const hour of series) {
    assert.equal(hour.tick, hour.utcHour % 6 === 0 ? String(hour.utcHour).padStart(2, '0') : '');
  }
  assert.equal(series.filter((hour) => hour.tick).length, 4);
});

test('a rolled-up month row is in no bucket and never reaches the chart', () => {
  const series = hourlySeries([{ hour: null, event: 'surface', family: 'curl', path: '/x', count: 99 }], NOW);
  assert.deepEqual(new Set(series.map((hour) => hour.count)), new Set([0]));
});

test('the last-hour rows sum to the newest bar of the chart', () => {
  // The one invariant the design names explicitly: the band and the chart are the same bucket
  // rendered twice, so they cannot be allowed to disagree.
  const rows = [
    row(0, 'claudebot', '/llms.txt', 3),
    row(0, 'browser', '/', 2),
    row(0, 'claudebot', '/llms.txt', 1),
    row(1, 'gptbot', '/llms.txt', 40),
  ];
  const series = hourlySeries(rows, NOW);
  const lastHour = lastHourRows(rows, NOW);

  assert.equal(lastHour.total, series.at(-1).count);
  assert.equal(
    lastHour.rows.reduce((total, entry) => total + entry.count, 0),
    series.at(-1).count
  );
});

test('the last hour groups by client AND path, newest-largest first', () => {
  const rows = [
    row(0, 'claudebot', '/llms.txt', 3),
    row(0, 'claudebot', '/agents.md', 1),
    row(0, 'claudebot', '/llms.txt', 1),
  ];
  const { rows: grouped } = lastHourRows(rows, NOW);
  assert.deepEqual(
    grouped.map((entry) => [entry.family, entry.path, entry.count]),
    [
      ['claudebot', '/llms.txt', 4],
      ['claudebot', '/agents.md', 1],
    ]
  );
});

test('client kinds are the four the design distinguishes', () => {
  assert.equal(clientKind('claudebot'), 'agent');
  assert.equal(clientKind('googlebot'), 'agent');
  assert.equal(clientKind('curl'), 'tool');
  assert.equal(clientKind('python'), 'tool');
  assert.equal(clientKind('browser'), 'browser');
  assert.equal(clientKind('other'), 'unknown');
  assert.equal(clientKind('none'), 'unknown');
  // A client that says it is a robot without saying which one has not named itself, and the marker
  // means "a named bot or agent". The mockup leaves this row's marker blank; so does this.
  assert.equal(clientKind('other-bot'), 'unknown');
});

test('buildActivity hands every band its numbers from one read', () => {
  const rows = [
    row(0, 'claudebot', '/llms.txt', 3),
    row(5, 'curl', '/robots.txt', 8),
    row(200, 'browser', '/', 4),
    row(9, 'claude-user', '/about', 2, 'markdown'),
  ];
  const activity = buildActivity(rows, NOW);

  assert.equal(activity.counted, true);
  assert.equal(activity.totals.total, 17);
  assert.equal(activity.totals.day, 13, 'the 200-hour-old row is outside the 24-hour window');
  assert.equal(activity.hours.length, CHART_HOURS);
  assert.equal(activity.lastHour.total, 3);
  assert.equal(activity.lastCountedHour, NOW_HOUR);

  // The markdown table reports pages, the surfaces table reports surfaces, and neither borrows the
  // other's rows.
  assert.deepEqual(activity.pages.rows.map((entry) => entry.path), ['/about']);
  assert.equal(activity.surfaces.rows.some((entry) => entry.path === '/about'), false);

  // Every client row carries its kind, which is what the marker column reads.
  for (const entry of activity.clients.rows) {
    assert.equal(entry.kind, clientKind(entry.family));
  }
});

test('an empty store is counted: false rather than a thrown render', () => {
  const activity = buildActivity([], NOW);
  assert.equal(activity.counted, false);
  assert.equal(activity.lastCountedHour, null);
  assert.equal(activity.lastHour.total, 0);
  assert.deepEqual(activity.lastHour.rows, []);
});
