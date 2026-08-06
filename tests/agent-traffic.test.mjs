import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TABLE_ROWS,
  WINDOW_HOURS,
  bucketHour,
  epochHour,
  flattenDayHashes,
  hourStart,
  readAgentTraffic,
  summarizeTraffic,
  toFieldMap,
  windowStart,
} from '../src/lib/agent-traffic.mjs';
import { DAYS_KEY, dayKeyFor, hitKeys } from '../src/lib/agent-hits.mjs';

// The read side of the hit counter. The window math is the part worth guarding: it is arithmetic
// over UTC hour buckets that renders as three numbers a reader takes at face value, and nothing
// about it is visible from the page if it is wrong by an hour.

const NOW = new Date('2026-08-06T14:37:00.000Z');
const NOW_HOUR = epochHour(NOW);

/** A day hash built the way the middleware would have built it. */
function bucket(hoursAgo, event, family, path, count) {
  const at = hourStart(NOW_HOUR - hoursAgo);
  return {
    day: at.toISOString().slice(0, 10),
    field: `${at.toISOString().slice(11, 13)}|${event}|${family}|${path}`,
    count: String(count),
  };
}

function dayHashesFrom(buckets) {
  const byDay = new Map();
  for (const { day, field, count } of buckets) {
    const fields = byDay.get(day) ?? {};
    fields[field] = count;
    byDay.set(day, fields);
  }
  return [...byDay.entries()].map(([day, fields]) => ({ day, fields }));
}

function summarize(buckets, now = NOW) {
  return summarizeTraffic(flattenDayHashes(dayHashesFrom(buckets)), now);
}

// ── The schema round trip ────────────────────────────────────────────────────────────────────

test('a field the writer produced is a field the reader parses', () => {
  const written = hitKeys({
    event: 'surface',
    path: '/llms.txt',
    ua: 'curl/8.4.0',
    now: new Date('2026-08-06T06:12:00.000Z'),
  });

  const [row] = flattenDayHashes([{ day: written.day, fields: { [written.field]: '3' } }]);

  assert.equal(row.event, 'surface');
  assert.equal(row.family, 'curl');
  assert.equal(row.path, '/llms.txt');
  assert.equal(row.count, 3);
  assert.equal(hourStart(row.hour).toISOString(), '2026-08-06T06:00:00.000Z');
});

test('a field that does not match the schema is dropped, not guessed at', () => {
  const rows = flattenDayHashes([
    {
      day: '2026-08-06',
      fields: {
        '06|surface|curl|/llms.txt': '2',
        '06|surface|curl': '9', // too few parts
        '06|invented|curl|/llms.txt': '9', // unknown event class
        'xx|surface|curl|/llms.txt': '9', // not an hour
        '07|surface|curl|/agents.md': 'not-a-number',
        '08|surface|curl|/agents.md': '0',
      },
    },
  ]);

  assert.deepEqual(
    rows.map((row) => row.path),
    ['/llms.txt']
  );
});

test('a day that is not a date contributes nothing', () => {
  assert.equal(bucketHour('not-a-day', '06'), null);
  assert.equal(flattenDayHashes([{ day: 'not-a-day', fields: { '06|surface|curl|/llms.txt': '1' } }]).length, 0);
});

// ── Rolling windows ──────────────────────────────────────────────────────────────────────────

test('a window is the last N hour buckets, ending with the one in progress', () => {
  assert.equal(windowStart(NOW_HOUR, 24), NOW_HOUR - 23);
  assert.equal(windowStart(NOW_HOUR, 168), NOW_HOUR - 167);
  assert.equal(windowStart(NOW_HOUR, 720), NOW_HOUR - 719);
});

test('each window counts exactly the buckets inside it', () => {
  const summary = summarize([
    bucket(0, 'surface', 'curl', '/llms.txt', 1), // this hour
    bucket(23, 'surface', 'curl', '/llms.txt', 1), // oldest hour still inside 24
    bucket(24, 'surface', 'curl', '/llms.txt', 1), // first hour outside it
    bucket(167, 'surface', 'curl', '/llms.txt', 1), // oldest inside 7 days
    bucket(168, 'surface', 'curl', '/llms.txt', 1), // outside it
    bucket(719, 'surface', 'curl', '/llms.txt', 1), // oldest inside 30 days
    bucket(720, 'surface', 'curl', '/llms.txt', 1), // outside it
  ]);

  assert.equal(summary.totals.day, 2); // 0 and 23 hours ago
  assert.equal(summary.totals.week, 4); // plus 24 and 167
  assert.equal(summary.totals.month, 6); // plus 168 and 719
  assert.equal(summary.totals.total, 7); // plus 720, which no window reaches
});

test('a window has no timezone: the same buckets give the same numbers whatever the wall clock', () => {
  // Two renders an hour apart, both with a bucket 12 hours before each. The rolling window means
  // the answer is 1 both times — a calendar day would have flipped between them at UTC midnight.
  const midnightish = new Date('2026-08-06T00:30:00.000Z');
  const before = summarizeTraffic(
    flattenDayHashes(
      dayHashesFrom([
        {
          day: hourStart(epochHour(midnightish) - 12)
            .toISOString()
            .slice(0, 10),
          field: `${hourStart(epochHour(midnightish) - 12)
            .toISOString()
            .slice(11, 13)}|surface|curl|/llms.txt`,
          count: '1',
        },
      ])
    ),
    midnightish
  );
  assert.equal(before.totals.day, 1);
  assert.equal(before.totals.total, 1);
});

test('the windows are the ones the section renders', () => {
  assert.deepEqual(WINDOW_HOURS, { day: 24, week: 168, month: 720 });
});

// ── Grouping ─────────────────────────────────────────────────────────────────────────────────

test('surfaces, clients and pages split by event class the way the tables do', () => {
  const summary = summarize([
    bucket(1, 'surface', 'claudebot', '/agents.md', 4),
    bucket(2, 'surface', 'curl', '/llms.txt', 6),
    bucket(3, 'markdown', 'claudebot', '/about', 2),
  ]);

  // By surface: surface events only.
  assert.deepEqual(
    summary.surfaces.rows.map((row) => [row.path, row.total]),
    [
      ['/llms.txt', 6],
      ['/agents.md', 4],
    ]
  );
  // Markdown negotiation: markdown events only.
  assert.deepEqual(
    summary.pages.rows.map((row) => [row.path, row.total]),
    [['/about', 2]]
  );
  // By client: both, which is why it totals the headline number.
  assert.deepEqual(
    summary.clients.rows.map((row) => [row.family, row.total]),
    [
      ['claudebot', 6],
      ['curl', 6],
    ]
  );
  assert.equal(summary.totals.total, 12);
  assert.equal(summary.surfaceTotals.total, 10);
  assert.equal(summary.markdownTotals.total, 2);
});

test('rows sort by all-time count, ties broken by name so the order is stable', () => {
  const summary = summarize([
    bucket(1, 'surface', 'curl', '/zebra.txt', 5),
    bucket(1, 'surface', 'curl', '/alpha.txt', 5),
    bucket(1, 'surface', 'curl', '/middle.txt', 9),
  ]);
  assert.deepEqual(
    summary.surfaces.rows.map((row) => row.path),
    ['/middle.txt', '/alpha.txt', '/zebra.txt']
  );
});

test('last fetched is the newest bucket that surface appeared in', () => {
  const summary = summarize([
    bucket(50, 'surface', 'curl', '/llms.txt', 1),
    bucket(3, 'surface', 'gptbot', '/llms.txt', 1),
    bucket(90, 'surface', 'curl', '/llms.txt', 1),
  ]);
  const [row] = summary.surfaces.rows;
  assert.equal(hourStart(row.lastHour).toISOString(), hourStart(NOW_HOUR - 3).toISOString());
  assert.equal(hourStart(summary.lastHour).toISOString(), hourStart(NOW_HOUR - 3).toISOString());
});

test('a table is capped and says how many rows it dropped', () => {
  const buckets = Array.from({ length: MAX_TABLE_ROWS + 3 }, (_, index) =>
    bucket(1, 'surface', 'curl', `/surface-${String(index).padStart(2, '0')}.txt`, index + 1)
  );
  const summary = summarize(buckets);
  assert.equal(summary.surfaces.rows.length, MAX_TABLE_ROWS);
  assert.equal(summary.surfaces.omitted, 3);
});

test('nothing counted is a state the page can render, not an error', () => {
  const summary = summarize([]);
  assert.equal(summary.counted, false);
  assert.equal(summary.totals.total, 0);
  assert.equal(summary.lastHour, null);
  assert.deepEqual(summary.surfaces.rows, []);
});

// ── Transport ────────────────────────────────────────────────────────────────────────────────

test('HGETALL is accepted as a flat array or as an object', () => {
  assert.deepEqual(toFieldMap(['06|surface|curl|/llms.txt', '3']), { '06|surface|curl|/llms.txt': '3' });
  assert.deepEqual(toFieldMap({ '06|surface|curl|/llms.txt': 3 }), { '06|surface|curl|/llms.txt': '3' });
  assert.deepEqual(toFieldMap(null), {});
});

test('no store configured makes no network call at all', async () => {
  let called = false;
  const result = await readAgentTraffic({
    env: {},
    fetchImpl: async () => {
      called = true;
      throw new Error('should not be called');
    },
  });
  assert.equal(called, false);
  assert.deepEqual(result, { ok: false, reason: 'no-store' });
});

test('the reader asks for the day set, then one HGETALL per day, by imported key names', async () => {
  const sent = [];
  const result = await readAgentTraffic({
    env: { UPSTASH_REDIS_REST_URL: 'https://store.example/', UPSTASH_REDIS_REST_TOKEN: 't' },
    fetchImpl: async (url, init) => {
      sent.push({ url, commands: JSON.parse(init.body) });
      const first = sent.length === 1;
      return new Response(
        JSON.stringify(
          first
            ? [{ result: ['2026-08-06', '2026-08-05'] }]
            : [
                { result: ['06|surface|curl|/llms.txt', '2'] },
                { result: ['14|surface|gptbot|/agents.md', '1'] },
              ]
        ),
        { status: 200 }
      );
    },
  });

  assert.equal(sent[0].url, 'https://store.example/pipeline');
  assert.deepEqual(sent[0].commands, [['SMEMBERS', DAYS_KEY]]);
  // Sorted, so the hashes line up with the days they came from.
  assert.deepEqual(sent[1].commands, [
    ['HGETALL', dayKeyFor('2026-08-05')],
    ['HGETALL', dayKeyFor('2026-08-06')],
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dayHashes[0], { day: '2026-08-05', fields: { '06|surface|curl|/llms.txt': '2' } });
});

test('an empty day set is a successful read of nothing', async () => {
  const result = await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    fetchImpl: async () => new Response(JSON.stringify([{ result: [] }]), { status: 200 }),
  });
  assert.deepEqual(result, { ok: true, dayHashes: [] });
});

test('a store that errors is a reason, never a throw', async () => {
  const status = await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    fetchImpl: async () => new Response('nope', { status: 500 }),
  });
  assert.equal(status.ok, false);

  const thrown = await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(thrown.ok, false);

  const garbage = await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    fetchImpl: async () => new Response('{"not":"an array"}', { status: 200 }),
  });
  assert.equal(garbage.ok, false);
});

test('the fixture is opt-in, never reaches a store, and fills every window', async () => {
  let called = false;
  const result = await readAgentTraffic({
    env: {
      AGENT_TRAFFIC_FIXTURE: '1',
      UPSTASH_REDIS_REST_URL: 'https://store.example',
      UPSTASH_REDIS_REST_TOKEN: 't',
    },
    fetchImpl: async () => {
      called = true;
      throw new Error('should not be called');
    },
    now: NOW,
  });

  assert.equal(called, false);
  assert.equal(result.ok, true);
  const summary = summarizeTraffic(flattenDayHashes(result.dayHashes), NOW);
  assert.ok(summary.totals.day > 0, '24-hour window is populated');
  assert.ok(summary.totals.week > summary.totals.day, '7-day window is larger');
  assert.ok(summary.totals.month > summary.totals.week, '30-day window is larger');
  assert.ok(summary.pages.rows.length > 0, 'the markdown table has rows');
});
