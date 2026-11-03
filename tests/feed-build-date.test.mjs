import assert from 'node:assert/strict';
import test from 'node:test';
import { dateOnlyToFeedInstant, lastBuildDateElement } from '../src/lib/feed-build-date.mjs';

test('lastBuildDate is the newest date, in RFC 822 form', () => {
  const element = lastBuildDateElement([
    new Date('2026-07-01T00:00:00.000Z'),
    undefined,
    new Date('2026-10-17T09:30:00.000Z'),
    new Date('2026-09-02T00:00:00.000Z'),
  ]);
  assert.equal(element, '<lastBuildDate>Sat, 17 Oct 2026 09:30:00 GMT</lastBuildDate>');
});

test('lastBuildDate is omitted when no item carries a date, never invented', () => {
  assert.equal(lastBuildDateElement([]), '');
  assert.equal(lastBuildDateElement([undefined, new Date('not a date')]), '');
});

test('a date-only value becomes noon UTC, the same calendar day west of UTC', () => {
  const instant = dateOnlyToFeedInstant(new Date('2026-09-03'));
  assert.equal(instant.toUTCString(), 'Thu, 03 Sep 2026 12:00:00 GMT');
  assert.equal(
    instant.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }),
    '9/3/2026'
  );
});
