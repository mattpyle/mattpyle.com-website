import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// config.ts resolves SITE_DIR from the environment at import time — irrelevant
// to resolveRunStamp itself, but every activity module pulls in config.ts on
// import, so the fixture root has to be set the same way the other activity
// tests do it.
process.env.STEWARD_SITE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

const { resolveRunStamp } = await import('../../src/activities/scorecard.js');

/**
 * `resolveRunStamp` can't take a fixed instant as an argument — it always
 * reads the real clock — so these tests only assert shape and internal
 * consistency (iso matches the timestamp's own date, offset is well-formed),
 * not a specific mapped day. The DST-crossing claim from the spec ("an
 * 06:00Z instant is the *previous* day in America/Vancouver") is exercised
 * directly against `Intl.DateTimeFormat`, not through the activity, since
 * the activity has no injectable clock.
 */
test('iso is YYYY-MM-DD and matches the calendar date embedded in timestamp', async () => {
  const stamp = await resolveRunStamp('America/Vancouver');
  assert.match(stamp.iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(stamp.timestamp.startsWith(stamp.iso), `timestamp ${stamp.timestamp} should start with iso ${stamp.iso}`);
});

test('timestamp carries a real UTC offset, never Z', async () => {
  const stamp = await resolveRunStamp('America/Vancouver');
  assert.match(stamp.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.ok(!stamp.timestamp.endsWith('Z'));
});

test('UTC timezone produces a +00:00 offset', async () => {
  const stamp = await resolveRunStamp('UTC');
  assert.match(stamp.timestamp, /\+00:00$/);
});

test('a known 06:00Z instant falls on the previous calendar day in America/Vancouver', () => {
  // Documents the exact scenario the timezone fix exists for: without it,
  // `new Date().toISOString().slice(0, 10)` would date a run one day late
  // for any run kicked off after ~5pm Pacific. Exercised against
  // Intl.DateTimeFormat directly (the same primitive resolveRunStamp uses)
  // since the activity itself has no injectable clock.
  const instant = new Date('2026-07-23T06:00:00.000Z');
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  assert.equal(iso, '2026-07-22');
});
