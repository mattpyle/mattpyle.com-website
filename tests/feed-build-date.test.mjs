import assert from 'node:assert/strict';
import test from 'node:test';
import { lastBuildDateElement } from '../src/lib/feed-build-date.mjs';

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
