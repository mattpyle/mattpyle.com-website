import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TABLE_ROWS,
  ROLLUP_MARGIN_HOURS,
  WINDOW_HOURS,
  bucketHour,
  epochHour,
  flattenDayHashes,
  flattenMonthHashes,
  flattenTraffic,
  foldDayFields,
  hourStart,
  readAgentTraffic,
  rollupCommands,
  rollupEligibleDays,
  summarizeTraffic,
  toFieldMap,
  windowStart,
} from '../src/lib/agent-traffic.mjs';
import {
  DAYS_KEY,
  MONTHS_KEY,
  ROLLUP_LOCK_KEY,
  dayKeyFor,
  hitKeys,
  monthKeyFor,
} from '../src/lib/agent-hits.mjs';

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

// ── The monthly rollup ───────────────────────────────────────────────────────────────────────

/**
 * A toy store that understands exactly the commands rollupCommands() emits, so the identity test
 * below runs the real command sequence rather than a paraphrase of it. An unknown verb throws:
 * teaching this function a new command should be a deliberate edit.
 */
function applyRollup(state, commands) {
  for (const [verb, ...args] of commands) {
    if (verb === 'SREM') state.days.delete(args[1]);
    else if (verb === 'SADD') state.months.add(args[1]);
    else if (verb === 'DEL') state.dayFields.delete(args[0]);
    else if (verb === 'HINCRBY') {
      const [key, field, by] = args;
      const fields = state.monthFields.get(key) ?? {};
      fields[field] = String(Number(fields[field] ?? 0) + Number(by));
      state.monthFields.set(key, fields);
    } else throw new Error(`applyRollup does not know the command ${verb}`);
  }
}

function storeFrom(buckets) {
  const state = { days: new Set(), months: new Set(), dayFields: new Map(), monthFields: new Map() };
  for (const { day, fields } of dayHashesFrom(buckets)) {
    state.days.add(day);
    state.dayFields.set(dayKeyFor(day), fields);
  }
  return state;
}

function readFrom(state) {
  return {
    dayHashes: [...state.days].sort().map((day) => ({ day, fields: state.dayFields.get(dayKeyFor(day)) ?? {} })),
    monthHashes: [...state.months]
      .sort()
      .map((month) => ({ month, fields: state.monthFields.get(monthKeyFor(month)) ?? {} })),
  };
}

test('a day is only eligible once no window can reach any hour in it', () => {
  const cutoffHoursAgo = WINDOW_HOURS.month - 1 + ROLLUP_MARGIN_HOURS;
  const dayOf = (hoursAgo) =>
    hourStart(NOW_HOUR - hoursAgo)
      .toISOString()
      .slice(0, 10);

  // Judged on the day's own 23:00 bucket, so the day containing the cutoff is never eligible.
  assert.deepEqual(rollupEligibleDays([dayOf(0), dayOf(cutoffHoursAgo)], NOW), []);
  assert.deepEqual(rollupEligibleDays([dayOf(cutoffHoursAgo + 48)], NOW), [dayOf(cutoffHoursAgo + 48)]);
});

test('a day name that is not a date is left alone rather than rewritten', () => {
  assert.deepEqual(rollupEligibleDays(['not-a-day', '', 'hits:v1:day:2020-01-01'], NOW), []);
});

test('folding sums the hours away and drops exactly what the reader drops', () => {
  assert.deepEqual(
    foldDayFields({
      '06|surface|curl|/llms.txt': '2',
      '09|surface|curl|/llms.txt': '3', // same three components, a different hour
      '11|surface|gptbot|/llms.txt': '1',
      '06|surface|curl': '9', // too few parts
      '06|invented|curl|/llms.txt': '9', // unknown event class
      'xx|surface|curl|/llms.txt': '9', // not an hour
      '07|surface|curl|/agents.md': 'not-a-number',
      '08|surface|curl|/agents.md': '0',
    }),
    { 'surface|curl|/llms.txt': 5, 'surface|gptbot|/llms.txt': 1 }
  );
});

test('the fold order removes a day from the set before it adds it to a month', () => {
  // The crash-safety argument in the module: interrupted anywhere, this loses counts rather than
  // adding a day to its month twice. Asserted as an order because that is what it is.
  const commands = rollupCommands([{ day: '2026-05-04', fields: { '06|surface|curl|/llms.txt': '2' } }]);
  assert.deepEqual(commands, [
    ['SREM', DAYS_KEY, '2026-05-04'],
    ['SADD', MONTHS_KEY, '2026-05'],
    ['HINCRBY', monthKeyFor('2026-05'), 'surface|curl|/llms.txt', '2'],
    ['DEL', dayKeyFor('2026-05-04')],
  ]);
});

test('a day with nothing foldable in it is removed without minting a month', () => {
  assert.deepEqual(rollupCommands([{ day: '2026-05-04', fields: { 'xx|bad|field': '3' } }]), [
    ['SREM', DAYS_KEY, '2026-05-04'],
    ['DEL', dayKeyFor('2026-05-04')],
  ]);
});

test('month rows carry no hour, so they reach the all-time total and no rolling window', () => {
  const rows = flattenMonthHashes([{ month: '2026-05', fields: { 'surface|curl|/llms.txt': '7' } }]);
  assert.deepEqual(rows, [{ hour: null, event: 'surface', family: 'curl', path: '/llms.txt', count: 7 }]);

  const summary = summarizeTraffic(rows, NOW);
  assert.equal(summary.totals.total, 7);
  assert.deepEqual([summary.totals.day, summary.totals.week, summary.totals.month], [0, 0, 0]);
  assert.equal(summary.lastHour, null);
  assert.equal(summary.surfaces.rows[0].lastHour, null);
});

test('a month field that is not what the schema promises is dropped, not guessed at', () => {
  assert.deepEqual(
    flattenMonthHashes([
      {
        month: '2026-05',
        fields: {
          'surface|curl|/llms.txt': '2',
          '06|surface|curl|/llms.txt': '9', // a day field, four parts
          'surface|curl': '9', // too few parts
          'invented|curl|/llms.txt': '9', // unknown event class
          'surface|curl|/agents.md': '0',
        },
      },
    ]).map((row) => row.path),
    ['/llms.txt']
  );
});

// THE CORE CORRECTNESS TEST. Everything else in this section is a detail of how the rollup gets
// there; this is the property that makes it allowed to happen at all.
test('rolling old days up changes no number the page renders', () => {
  const buckets = [
    bucket(0, 'surface', 'curl', '/llms.txt', 4),
    bucket(30, 'surface', 'claudebot', '/agents.md', 3),
    bucket(700, 'markdown', 'curl', '/about', 2),
    // Past every window plus the margin, so these are the ones that fold.
    bucket(1000, 'surface', 'curl', '/llms.txt', 5),
    bucket(1001, 'surface', 'curl', '/llms.txt', 1),
    bucket(1400, 'surface', 'googlebot', '/sitemap-index.xml', 8),
    bucket(1600, 'markdown', 'claude-user', '/writing/accessibility-and-ai', 6),
  ];

  const state = storeFrom(buckets);
  const before = summarizeTraffic(flattenTraffic(readFrom(state)), NOW);

  const read = readFrom(state);
  const eligible = new Set(rollupEligibleDays([...state.days], NOW));
  assert.ok(eligible.size >= 3, 'the fixture must actually have days to roll up');
  applyRollup(state, rollupCommands(read.dayHashes.filter(({ day }) => eligible.has(day))));

  const after = summarizeTraffic(flattenTraffic(readFrom(state)), NOW);

  assert.deepEqual(after.totals, before.totals);
  assert.deepEqual(after.surfaceTotals, before.surfaceTotals);
  assert.deepEqual(after.markdownTotals, before.markdownTotals);
  for (const table of ['surfaces', 'clients', 'pages']) {
    assert.deepEqual(
      after[table].rows.map(({ lastHour, ...rest }) => rest),
      before[table].rows.map(({ lastHour, ...rest }) => rest),
      table
    );
    assert.equal(after[table].omitted, before[table].omitted, table);
  }
  // lastHour is the one thing a fold gives up, and only for a group with nothing recent left.
  assert.equal(after.lastHour, before.lastHour);
  const googlebot = after.clients.rows.find((row) => row.family === 'googlebot');
  assert.equal(googlebot.lastHour, null);
  assert.equal(googlebot.total, 8);

  // And the state it left behind: the recent days survive, the old ones are months now.
  assert.equal(state.days.size, 3);
  assert.ok(state.months.size > 0);
});

test('rolling up twice is not a double count, because a folded day leaves the set', () => {
  const state = storeFrom([bucket(1000, 'surface', 'curl', '/llms.txt', 5)]);
  const first = readFrom(state);
  applyRollup(state, rollupCommands(first.dayHashes));

  const second = readFrom(state);
  assert.deepEqual(second.dayHashes, []);
  applyRollup(state, rollupCommands(second.dayHashes));

  assert.equal(summarizeTraffic(flattenTraffic(readFrom(state)), NOW).totals.total, 5);
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

test('the reader asks for both sets, then one HGETALL per day and per month, by imported key names', async () => {
  const sent = [];
  const result = await readAgentTraffic({
    env: { UPSTASH_REDIS_REST_URL: 'https://store.example/', UPSTASH_REDIS_REST_TOKEN: 't' },
    now: NOW,
    fetchImpl: async (url, init) => {
      sent.push({ url, commands: JSON.parse(init.body) });
      const first = sent.length === 1;
      return new Response(
        JSON.stringify(
          first
            ? [{ result: ['2026-08-06', '2026-08-05'] }, { result: ['2026-05'] }]
            : [
                { result: ['06|surface|curl|/llms.txt', '2'] },
                { result: ['14|surface|gptbot|/agents.md', '1'] },
                { result: ['surface|curl|/llms.txt', '40'] },
              ]
        ),
        { status: 200 }
      );
    },
  });

  assert.equal(sent[0].url, 'https://store.example/pipeline');
  assert.deepEqual(sent[0].commands, [
    ['SMEMBERS', DAYS_KEY],
    ['SMEMBERS', MONTHS_KEY],
  ]);
  // Sorted, so the hashes line up with the days and months they came from.
  assert.deepEqual(sent[1].commands, [
    ['HGETALL', dayKeyFor('2026-08-05')],
    ['HGETALL', dayKeyFor('2026-08-06')],
    ['HGETALL', monthKeyFor('2026-05')],
  ]);
  // No day is eligible here, so no lock is taken and no third round trip happens.
  assert.equal(sent.length, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dayHashes[0], { day: '2026-08-05', fields: { '06|surface|curl|/llms.txt': '2' } });
  assert.deepEqual(result.monthHashes[0], { month: '2026-05', fields: { 'surface|curl|/llms.txt': '40' } });
});

test('a month name the schema would not have written is never turned into a key', async () => {
  // A month member is used to BUILD a key and is written by the rollup, so a garbage member is a
  // minted key rather than an absent read. Days are read-only and are left as found.
  const sent = [];
  const result = await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    now: NOW,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify(
          sent.length === 1 ? [{ result: [] }, { result: ['2026-13', 'nonsense', '2026-07'] }] : [{ result: [] }]
        ),
        { status: 200 }
      );
    },
  });

  assert.deepEqual(sent[1], [['HGETALL', monthKeyFor('2026-07')]]);
  assert.equal(result.ok, true);
});

test('two empty sets are a successful read of nothing', async () => {
  const result = await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    fetchImpl: async () => new Response(JSON.stringify([{ result: [] }, { result: [] }]), { status: 200 }),
  });
  assert.deepEqual(result, { ok: true, dayHashes: [], monthHashes: [] });
});

test('a store that errors is a reason, never a throw', async () => {
  // Every branch answers the two SMEMBERS commands with the same shape, so what is being tested is
  // the failure and not an arity mismatch.
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

/**
 * The store as the reader sees it: two SMEMBERS, then the hash pipeline (whose last command is the
 * lock attempt when a rollup is pending), then the rollup pipeline. `lock` decides what the SET NX
 * answers.
 */
function storeFetch({ days, months = [], dayFields = {}, lock = 'OK', sent }) {
  return async (_url, init) => {
    const commands = JSON.parse(init.body);
    sent.push(commands);
    if (commands.length === 2 && commands[0][0] === 'SMEMBERS') {
      return new Response(JSON.stringify([{ result: days }, { result: months }]), { status: 200 });
    }
    const results = commands.map((command) => {
      if (command[0] === 'SET') return { result: lock };
      if (command[0] === 'HGETALL') {
        const day = command[1].replace(/^hits:v1:day:/, '');
        return { result: dayFields[day] ?? [] };
      }
      return { result: 1 };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };
}

test('a render with an eligible day takes the lock in the read pipeline and then folds it', async () => {
  const old = hourStart(NOW_HOUR - 1200)
    .toISOString()
    .slice(0, 10);
  const today = NOW.toISOString().slice(0, 10);
  const sent = [];

  const result = await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    now: NOW,
    fetchImpl: storeFetch({
      days: [today, old],
      dayFields: { [old]: ['06|surface|curl|/llms.txt', '5'] },
      sent,
    }),
  });

  // The lock rides the read pipeline rather than costing a round trip of its own.
  assert.equal(sent[1].at(-1)[0], 'SET');
  assert.equal(sent[1].at(-1)[1], ROLLUP_LOCK_KEY);
  assert.deepEqual(sent[1].at(-1).slice(3), ['NX', 'EX', '60']);

  assert.equal(sent.length, 3, 'the fold is one further pipeline');
  assert.deepEqual(sent[2], [
    ['SREM', DAYS_KEY, old],
    ['SADD', MONTHS_KEY, old.slice(0, 7)],
    ['HINCRBY', monthKeyFor(old.slice(0, 7)), 'surface|curl|/llms.txt', '5'],
    ['DEL', dayKeyFor(old)],
  ]);

  // The render that folds still reports the day it folded, so its own numbers are unchanged.
  assert.equal(result.ok, true);
  assert.equal(summarizeTraffic(flattenTraffic(result), NOW).totals.total, 5);
});

test('losing the lock skips the fold and leaves the read exactly as it is', async () => {
  const old = hourStart(NOW_HOUR - 1200)
    .toISOString()
    .slice(0, 10);
  const sent = [];

  const result = await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    now: NOW,
    fetchImpl: storeFetch({ days: [old], dayFields: { [old]: ['06|surface|curl|/llms.txt', '5'] }, lock: null, sent }),
  });

  assert.equal(sent.length, 2, 'no fold pipeline is sent');
  assert.equal(result.ok, true);
  assert.equal(summarizeTraffic(flattenTraffic(result), NOW).totals.total, 5);
});

test('a render with nothing to fold never asks for the lock at all', async () => {
  const sent = [];
  await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    now: NOW,
    fetchImpl: storeFetch({ days: [NOW.toISOString().slice(0, 10)], sent }),
  });
  assert.equal(sent.length, 2);
  assert.ok(!sent[1].some((command) => command[0] === 'SET'));
});

test('a fold that fails is still a successful read', async () => {
  const old = hourStart(NOW_HOUR - 1200)
    .toISOString()
    .slice(0, 10);
  let call = 0;
  const result = await readAgentTraffic({
    env: { KV_REST_API_URL: 'https://store.example', KV_REST_API_TOKEN: 't' },
    now: NOW,
    fetchImpl: async (url, init) => {
      call += 1;
      if (call === 3) return new Response('nope', { status: 500 });
      return storeFetch({ days: [old], dayFields: { [old]: ['06|surface|curl|/llms.txt', '5'] }, sent: [] })(url, init);
    },
  });

  assert.equal(call, 3, 'the fold was attempted');
  assert.equal(result.ok, true);
  assert.equal(summarizeTraffic(flattenTraffic(result), NOW).totals.total, 5);
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
  const summary = summarizeTraffic(flattenTraffic(result), NOW);
  assert.ok(summary.totals.day > 0, '24-hour window is populated');
  assert.ok(summary.totals.week > summary.totals.day, '7-day window is larger');
  assert.ok(summary.totals.month > summary.totals.week, '30-day window is larger');
  assert.ok(summary.pages.rows.length > 0, 'the markdown table has rows');

  // The fixture covers the merged path too, and its month only ever adds to rows that already
  // exist, so the tables it produces are the same shape with or without it.
  assert.ok(result.monthHashes.length > 0, 'the fixture includes a rolled-up month');
  assert.ok(summary.totals.total > summary.totals.month, 'the month rows land in the all-time total');
  const daysOnly = summarizeTraffic(flattenDayHashes(result.dayHashes), NOW);
  assert.deepEqual(
    summary.surfaces.rows.map((row) => row.path).sort(),
    daysOnly.surfaces.rows.map((row) => row.path).sort()
  );
});
