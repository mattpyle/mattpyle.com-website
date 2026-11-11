import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { setFrontmatterLiveOn, summariseRecheck, vancouverDay } from '../../src/lib/findings-recheck.js';
import { siteHosts } from '../../src/activities/findings-recheck.js';
import { buildRecheckScheduleOptions, recheckScheduleId } from '../../src/lib/recheck-schedule.js';

/** The recheck's pure parts (STW-543): the day, the `live_on` edit, the hosts read, the Schedule. */

const FINDING = [
  '---',
  'key: some-finding',
  'key_short: TI-1',
  'status: approved',
  'importance: low',
  'importance_reason: "why"',
  'evidence: read',
  'lives_in: page',
  'verify: []',
  '---',
  '',
  '# A finding',
  '',
].join('\n');

test('the day is America/Vancouver, not UTC', () => {
  // 03:30 UTC on the 9th is the evening of the 8th in Vancouver.
  assert.equal(vancouverDay('2026-11-09T03:30:00.000Z'), '2026-11-08');
  assert.equal(vancouverDay('2026-11-08T20:00:00.000Z'), '2026-11-08');
});

test('live_on goes after lives_in, and replaces itself on the next recheck', () => {
  const once = setFrontmatterLiveOn(FINDING, '2026-11-08');
  const lines = once.split('\n');
  assert.equal(lines[lines.indexOf('lives_in: page') + 1], 'live_on: 2026-11-08');
  assert.equal(lines[lines.indexOf('live_on: 2026-11-08') + 1], 'live_by: check');
  const twice = setFrontmatterLiveOn(once, '2026-11-09');
  assert.equal(twice, once.replace('live_on: 2026-11-08', 'live_on: 2026-11-09'));
  assert.equal(setFrontmatterLiveOn(once, '2026-11-08'), once, 'the same day writes nothing new');
});

test('live_by: review becomes live_by: check, as the one live_by line', () => {
  const reviewed = FINDING.replace('lives_in: page\n', 'lives_in: page\nlive_on: 2026-11-08\nlive_by: review\n');
  const after = setFrontmatterLiveOn(reviewed, '2026-11-09');
  assert.equal(after, FINDING.replace('lives_in: page\n', 'lives_in: page\nlive_on: 2026-11-09\nlive_by: check\n'));
  assert.equal(after.split('\n').filter((l) => l.startsWith('live_by:')).length, 1);
  // A live_by that sits before live_on, or with no live_on at all, still ends as one line after live_on.
  const before = FINDING.replace('lives_in: page\n', 'live_by: review\nlives_in: page\nlive_on: 2026-11-08\n');
  assert.equal(setFrontmatterLiveOn(before, '2026-11-09'), FINDING.replace('lives_in: page\n', 'lives_in: page\nlive_on: 2026-11-09\nlive_by: check\n'));
  const lone = FINDING.replace('lives_in: page\n', 'lives_in: page\nlive_by: review\n');
  assert.equal(setFrontmatterLiveOn(lone, '2026-11-09'), FINDING.replace('lives_in: page\n', 'lives_in: page\nlive_on: 2026-11-09\nlive_by: check\n'));
});

test('live_on keeps CRLF and lands at the end of a block without recheck fields', () => {
  const bare = ['---', 'key: k', 'status: approved', '---', '', 'body'].join('\r\n');
  assert.equal(setFrontmatterLiveOn(bare, '2026-11-08'), ['---', 'key: k', 'status: approved', 'live_on: 2026-11-08', 'live_by: check', '---', '', 'body'].join('\r\n'));
  assert.throws(() => setFrontmatterLiveOn(bare, '8 Nov'), /YYYY-MM-DD/);
});

test('site hosts come from config.yaml, and a malformed one fails loudly', () => {
  assert.deepEqual(siteHosts('site:\n  url: https://temporal.io\n  hosts:\n    - temporal.io\n    - docs.temporal.io\n'), {
    origin: 'https://temporal.io',
    hosts: ['temporal.io', 'docs.temporal.io'],
  });
  assert.deepEqual(siteHosts('site:\n  url: https://www.mattpyle.com/\n'), { origin: 'https://www.mattpyle.com', hosts: [] });
  assert.throws(() => siteHosts('site:\n  url: https://temporal.io\n  hosts:\n    - https://docs.temporal.io\n'), /bare lower-case hostname/);
  assert.throws(() => siteHosts('site:\n  name: x\n'), /no site.url/);
});

test('the summary counts each outcome', () => {
  const summary = summariseRecheck({
    site: 'temporal-io',
    at: '2026-11-08T14:20:00.000Z',
    rows: [
      { key: 'a', outcome: 'resolved' },
      { key: 'b', outcome: 'no checks' },
      { key: 'c', outcome: 'no checks' },
    ],
  });
  assert.equal(summary, 'Findings recheck of temporal-io: 3 approved, resolved 1, no checks 2.');
});

test('the Schedule is daily at 06:20 Vancouver, per site, and never overlaps', () => {
  const options = buildRecheckScheduleOptions({ taskQueue: 'steward-findings', input: { repo: 'o/argus', site: 'temporal-io' } });
  assert.equal(options.scheduleId, recheckScheduleId('temporal-io'));
  assert.equal(options.scheduleId, 'steward-findings-recheck-temporal-io');
  assert.deepEqual(options.spec.calendars, [{ hour: 6, minute: 20 }]);
  assert.equal(options.spec.timezone, 'America/Vancouver');
  assert.equal(options.policies?.overlap, ScheduleOverlapPolicy.SKIP);
  assert.equal(options.action.type, 'startWorkflow');
  if (options.action.type === 'startWorkflow') {
    assert.equal(options.action.taskQueue, 'steward-findings');
    assert.deepEqual(options.action.args, [{ repo: 'o/argus', site: 'temporal-io' }]);
  }
});
