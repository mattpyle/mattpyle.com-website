/**
 * The read side of the agent hit counter: turn the store's hour buckets into the numbers
 * /scorecard renders.
 *
 * Layer three of the agent-hit-counter card. src/lib/agent-hits.mjs owns the write side and the
 * key schema; nothing here rebuilds a key name, it imports them, so a reshape of the schema is one
 * file rather than a hunt through two.
 *
 * Everything above the transport is pure, so tests/agent-traffic.test.mjs asserts the window math
 * against fabricated hour buckets without a store and without a deploy. Same split as
 * agent-hits.mjs, a2a-responder.mjs and agent-surfaces.mjs.
 *
 * Two properties are load-bearing:
 *
 * 1. NO CALENDAR DAY LEAVES THIS MODULE AS A NUMBER'S FRAME. The store is UTC at hour resolution,
 *    and every window here is a rolling run of hour buckets ending at render time. A rolling
 *    window has no timezone, which is the point: the page is cached and served identically to a
 *    reader in Vancouver, Lagos or Osaka, and "the last 24 hours" means the same thing to all
 *    three. Timestamps are returned as instants for the page to emit as machine-readable UTC and
 *    localise in the browser. Decided with Matt 2026-08-06; see the card's Notes.
 * 2. Fail soft. A missing env var, a slow store, a malformed field: all of them are a page that
 *    renders without the section's numbers, never a page that 500s. The conformance sections on
 *    /scorecard render from committed JSON and must be unaffected by anything in here.
 *
 * This module also owns the monthly rollup, which is the only thing on the read side that writes.
 * See "The monthly rollup" below for why it lives here and what it is allowed to lose.
 */

import {
  DAYS_KEY,
  MONTHS_KEY,
  ROLLUP_LOCK_KEY,
  dayKeyFor,
  isCounterMonth,
  monthFieldFor,
  monthKeyFor,
  monthOf,
  parseHitField,
  parseMonthField,
  readStoreConfig,
} from './agent-hits.mjs';

const MS_PER_HOUR = 3_600_000;

/**
 * The rolling windows the section renders, in hours. 24, 168 and 720 rather than "today",
 * "this week" and "this month" for the reason above: a calendar window would have to pick a
 * timezone, and this page has no standing to pick one on a reader's behalf.
 */
export const WINDOW_HOURS = Object.freeze({ day: 24, week: 168, month: 720 });

/**
 * Rows past this are dropped from a table, with the count reported so the page can say so.
 * The key space is bounded by construction (agent-hits.mjs), so this is not a correctness
 * measure — it is the difference between a table and a wall.
 */
export const MAX_TABLE_ROWS = 25;

/** The hour a Date falls in, as hours since the epoch. @param {Date} date */
export function epochHour(date) {
  return Math.floor(date.getTime() / MS_PER_HOUR);
}

/** The instant an hour bucket starts. @param {number} hour */
export function hourStart(hour) {
  return new Date(hour * MS_PER_HOUR);
}

/**
 * A stored bucket (`2026-08-05`, `06`) as hours since the epoch, or null if either part is not
 * what the schema promises.
 *
 * @param {string} day YYYY-MM-DD, UTC
 * @param {string} hour HH, UTC
 */
export function bucketHour(day, hour) {
  const parsed = Date.parse(`${day}T${hour}:00:00.000Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / MS_PER_HOUR) : null;
}

/**
 * Day hashes in, one flat row per bucket out.
 *
 * A field that does not parse, or a value that is not a positive integer, is dropped rather than
 * guessed at: the only way either exists is a schema change that forgot to bump the key version,
 * and a dropped row is a smaller lie than an invented one.
 *
 * @param {Array<{ day: string, fields: Record<string, string | number> }>} dayHashes
 * @returns {Array<{ hour: number, event: string, family: string, path: string, count: number }>}
 */
export function flattenDayHashes(dayHashes) {
  const rows = [];
  for (const { day, fields } of dayHashes) {
    for (const [field, rawCount] of Object.entries(fields ?? {})) {
      const parsed = parseHitField(field);
      if (!parsed) continue;
      const hour = bucketHour(day, parsed.hour);
      if (hour === null) continue;
      const count = Number(rawCount);
      if (!Number.isFinite(count) || count <= 0) continue;
      rows.push({ hour, event: parsed.event, family: parsed.family, path: parsed.path, count });
    }
  }
  return rows;
}

/**
 * Month hashes in, one flat row per bucket out, with `hour: null`.
 *
 * A null hour is not a missing value, it is the shape of the fact: a rolled-up month knows what
 * was fetched and how often, and deliberately no longer knows when within the month. Everything
 * downstream treats a null hour as "inside no rolling window", which is exactly true — a month
 * only ever gets rolled up once every window has moved past every hour in it.
 *
 * Same drop-rather-than-guess rule as flattenDayHashes().
 *
 * @param {Array<{ month: string, fields: Record<string, string | number> }>} monthHashes
 * @returns {Array<{ hour: null, event: string, family: string, path: string, count: number }>}
 */
export function flattenMonthHashes(monthHashes) {
  const rows = [];
  for (const { fields } of monthHashes ?? []) {
    for (const [field, rawCount] of Object.entries(fields ?? {})) {
      const parsed = parseMonthField(field);
      if (!parsed) continue;
      const count = Number(rawCount);
      if (!Number.isFinite(count) || count <= 0) continue;
      rows.push({ hour: null, event: parsed.event, family: parsed.family, path: parsed.path, count });
    }
  }
  return rows;
}

/**
 * A whole read, flattened: the recent days and the rolled-up months as one row list.
 *
 * The one function a page should call, so neither /scorecard nor /scorecard.md can render a
 * lopsided total by forgetting half the store.
 *
 * @param {{ dayHashes?: Array<{ day: string, fields: Record<string, string> }>,
 *           monthHashes?: Array<{ month: string, fields: Record<string, string> }> }} read
 */
export function flattenTraffic({ dayHashes = [], monthHashes = [] } = {}) {
  return [...flattenDayHashes(dayHashes), ...flattenMonthHashes(monthHashes)];
}

/**
 * The oldest hour bucket inside a window ending now.
 *
 * A window of N hours is the last N hour buckets, the newest of which is the one in progress. So
 * "last 24 hours" covers between 23 and 24 hours of elapsed time depending on where in the hour
 * the render lands, and never 25. Erring short rather than long is deliberate: a number labelled
 * "last 24 hours" that quietly covers 25 is the kind of thing nobody notices and everybody
 * mis-reads later.
 *
 * @param {number} nowHour @param {number} hours
 */
export function windowStart(nowHour, hours) {
  return nowHour - (hours - 1);
}

/**
 * Is this row inside the given rolling window?
 *
 * A rolled-up month row (`hour: null`) is inside no window and every all-time total. That is not a
 * fallback, it is the invariant the rollup is built on: a day is only folded once every window has
 * moved past its last hour, so a month row answering "no" here is answering correctly.
 *
 * @param {{ hour: number | null }} row @param {number} nowHour @param {number} hours
 */
function inWindow(row, nowHour, hours) {
  return row.hour !== null && row.hour >= windowStart(nowHour, hours);
}

/**
 * @param {Array<{ hour: number | null, count: number }>} rows
 * @param {number} nowHour
 */
function windowTotals(rows, nowHour) {
  const totals = { total: 0, day: 0, week: 0, month: 0 };
  for (const row of rows) {
    totals.total += row.count;
    for (const [id, hours] of Object.entries(WINDOW_HOURS)) {
      if (inWindow(row, nowHour, hours)) totals[id] += row.count;
    }
  }
  return totals;
}

/**
 * @typedef {{ path?: string, family?: string, total: number, day: number, week: number,
 *             month: number, lastHour: number | null }} TallyRow
 */

/**
 * Group rows by a key and total each group over every window, newest-first by all-time count.
 *
 * @param {Array<{ hour: number, count: number }>} rows
 * @param {(row: any) => string} keyOf
 * @param {number} nowHour
 * @param {'path' | 'family'} keyName the property the key lands on
 * @returns {{ rows: TallyRow[], omitted: number }}
 */
function tally(rows, keyOf, nowHour, keyName) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    let group = groups.get(key);
    if (!group) {
      group = { [keyName]: key, total: 0, day: 0, week: 0, month: 0, lastHour: row.hour };
      groups.set(key, group);
    }
    group.total += row.count;
    for (const [id, hours] of Object.entries(WINDOW_HOURS)) {
      if (inWindow(row, nowHour, hours)) group[id] += row.count;
    }
    // A group seen only in rolled-up months has no last hour to report, which is the one thing the
    // rollup gives up. Nothing renders this today; the tables render the three window columns.
    if (row.hour !== null && (group.lastHour === null || row.hour > group.lastHour)) {
      group.lastHour = row.hour;
    }
  }

  const sorted = [...groups.values()].sort(
    (a, b) => b.total - a.total || String(a[keyName]).localeCompare(String(b[keyName]))
  );
  return { rows: sorted.slice(0, MAX_TABLE_ROWS), omitted: Math.max(0, sorted.length - MAX_TABLE_ROWS) };
}

/**
 * Everything the section renders, from flat rows.
 *
 * The headline numbers count every event class: a surface fetch, a negotiated-markdown serve and a
 * named bot reading an ordinary page are all an agent asking this site for something, and the page
 * says which is which underneath.
 *
 * @param {Array<{ hour: number | null, event: string, family: string, path: string,
 *                 count: number }>} rows
 * @param {Date} now
 */
export function summarizeTraffic(rows, now = new Date()) {
  const nowHour = epochHour(now);
  const surfaceRows = rows.filter((row) => row.event === 'surface');
  const markdownRows = rows.filter((row) => row.event === 'markdown');
  // The `page` class, added 2026-08-26. Every row here is a named bot by construction — the write
  // path refuses the class for a browser, an unrecognised client and an absent user agent — so
  // nothing downstream has to filter it again, and nothing downstream may assume it can.
  const pageRows = rows.filter((row) => row.event === 'page');
  const hours = rows.map((row) => row.hour).filter((hour) => hour !== null);

  return {
    counted: rows.length > 0,
    totals: windowTotals(rows, nowHour),
    surfaceTotals: windowTotals(surfaceRows, nowHour),
    markdownTotals: windowTotals(markdownRows, nowHour),
    botPageTotals: windowTotals(pageRows, nowHour),
    surfaces: tally(surfaceRows, (row) => row.path, nowHour, 'path'),
    clients: tally(rows, (row) => row.family, nowHour, 'family'),
    pages: tally(markdownRows, (row) => row.path, nowHour, 'path'),
    /** Which pages bots read, which is the question the `page` class was added to answer. */
    botPages: tally(pageRows, (row) => row.path, nowHour, 'path'),
    /**
     * The newest bucket anything landed in, for "last counted". Null when nothing has, and null
     * when everything there is has been rolled up into months, which is the same statement: no
     * hour is known.
     */
    lastHour: hours.length === 0 ? null : Math.max(...hours),
  };
}

// ── The monthly rollup ───────────────────────────────────────────────────────────────────────

/**
 * Why this exists: before it, one render cost `1 + N` Redis commands where N was every day the
 * site had ever counted, so the cost of an attack grew with the site's age while the cost of
 * mounting it stayed one HTTP request (security audit, 2026-08-06, finding 2). Now a render costs
 * roughly 33 days plus one command per month of site age, which grows twelve a year rather than
 * three hundred and sixty-five.
 *
 * Why dropping the hour is not a loss: every number this module renders is either a rolling window
 * over the last 720 hours or an all-time tally with no time frame at all. Past the window, hour
 * resolution is provably unread. The rollup keeps every count and discards only the part of the
 * key that nothing can ask about any more.
 *
 * This is a deliberate narrowing of the UTC-hour storage decision recorded in CLAUDE.md, which
 * asks for hour granularity "or finer where practical". Recent history keeps it; history past
 * every window keeps month granularity instead.
 */

/**
 * How far past the longest window a day has to be before it can be folded.
 *
 * The window itself is the correctness boundary; this margin is the safety belt on it. Two whole
 * days covers a render whose clock is skewed, a rollup that started just before a window boundary
 * and finished after it, and the fact that eligibility is judged on a day name while the window is
 * judged on an hour. Nothing renders differently for a wider margin — it only means a handful of
 * extra day keys survive a little longer.
 */
export const ROLLUP_MARGIN_HOURS = 48;

/** The hour bucket a day must be entirely older than to be eligible. @param {Date} now */
export function rollupCutoffHour(now) {
  return windowStart(epochHour(now), WINDOW_HOURS.month) - ROLLUP_MARGIN_HOURS;
}

/**
 * Which of these days can be folded, judged on the day's LAST possible hour bucket (its 23:00), so
 * a day is only ever eligible when no hour in it can still fall inside a window.
 *
 * A day name that is not a date is never eligible: it cannot be parsed, so it is left alone for a
 * human to find rather than quietly rewritten.
 *
 * @param {string[]} days @param {Date} now @returns {string[]}
 */
export function rollupEligibleDays(days, now) {
  const cutoff = rollupCutoffHour(now);
  return days.filter((day) => {
    const lastHour = bucketHour(day, '23');
    return lastHour !== null && lastHour < cutoff;
  });
}

/**
 * One day hash's fields, summed into the month fields they roll up into.
 *
 * Drops exactly what flattenDayHashes() drops, by the same rules, which is what makes the rollup
 * numerically invisible: a field the reader would have ignored is not smuggled into a total by
 * being folded.
 *
 * @param {Record<string, string | number>} fields
 * @returns {Record<string, number>}
 */
export function foldDayFields(fields) {
  /** @type {Record<string, number>} */
  const folded = {};
  for (const [field, rawCount] of Object.entries(fields ?? {})) {
    const parsed = parseHitField(field);
    if (!parsed) continue;
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count <= 0) continue;
    const monthField = monthFieldFor(parsed);
    folded[monthField] = (folded[monthField] ?? 0) + count;
  }
  return folded;
}

/**
 * The commands that fold these day hashes into their months.
 *
 * ORDER IS THE CRASH SAFETY, and it is chosen so every interruption undercounts rather than
 * double-counts, matching the posture the whole counter inherits:
 *
 * 1. `SREM` the day from the day set. After this the day is invisible to a reader, so no second
 *    render can fold it again even if this one dies on the next line.
 * 2. `SADD` the month to the month set, before anything lands in the month hash, so a hash can
 *    never exist unreachably.
 * 3. `HINCRBY` the folded counts.
 * 4. `DEL` the day hash.
 *
 * Interrupted between 1 and 3, one old day's counts are gone from the all-time total. Interrupted
 * between 3 and 4, an orphan day hash is left behind that nothing reads. The reverse order would
 * risk adding a day's counts to its month twice, which is the one failure that would show up on
 * the page as a number that grew on its own.
 *
 * @param {Array<{ day: string, fields: Record<string, string> }>} dayHashes
 * @returns {string[][]}
 */
export function rollupCommands(dayHashes) {
  const commands = [];
  for (const { day, fields } of dayHashes) {
    const month = monthOf(day);
    const folded = foldDayFields(fields);
    commands.push(['SREM', DAYS_KEY, day]);
    if (Object.keys(folded).length > 0) {
      commands.push(['SADD', MONTHS_KEY, month]);
      for (const [field, count] of Object.entries(folded)) {
        commands.push(['HINCRBY', monthKeyFor(month), field, String(count)]);
      }
    }
    commands.push(['DEL', dayKeyFor(day)]);
  }
  return commands;
}

/**
 * How long the rollup lock lives. Long enough to outlast a render that is mid-rollup, short enough
 * that a lost lock costs one missed rollup rather than a stuck one.
 */
export const ROLLUP_LOCK_TTL_SECONDS = 60;

/**
 * Take the lock, or find out somebody else has it. `SET ... NX` answers `OK` or null, so the race
 * is settled by the store in one command rather than by a read-then-write this code would lose.
 *
 * The lock is never released explicitly: the TTL is the release. If the holder dies mid-rollup,
 * nothing rolls up for up to a minute and the next render retries — and because rollupCommands()
 * removes each day from the set before it folds it, the retry sees only the days the dead render
 * never reached. The failure mode of a lost lock is therefore a delay, plus at most the counts of
 * whichever single day it died inside.
 *
 * @param {string} token written only so a human reading the store can see which render holds it
 */
export function rollupLockCommand(token) {
  return ['SET', ROLLUP_LOCK_KEY, token, 'NX', 'EX', String(ROLLUP_LOCK_TTL_SECONDS)];
}

// ── Transport ────────────────────────────────────────────────────────────────────────────────

/** One render's worth of budget. Past this the section shows unavailable, which the cache hides. */
const READ_TIMEOUT_MS = 2500;

/**
 * Upstash returns HGETALL over REST as a flat [field, value, field, value] array; some client
 * versions return an object. Accept both rather than betting on one.
 *
 * @param {unknown} result
 * @returns {Record<string, string>}
 */
export function toFieldMap(result) {
  if (Array.isArray(result)) {
    /** @type {Record<string, string>} */
    const fields = {};
    for (let i = 0; i + 1 < result.length; i += 2) fields[String(result[i])] = String(result[i + 1]);
    return fields;
  }
  if (result && typeof result === 'object') {
    return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, String(value)]));
  }
  return {};
}

/**
 * @param {{ url: string, token: string }} store
 * @param {string[][]} commands
 * @param {typeof fetch} fetchImpl
 */
async function pipeline(store, commands, fetchImpl) {
  const response = await fetchImpl(`${store.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`status-${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('malformed-pipeline-response');
  return payload.map((entry) => {
    if (entry && typeof entry === 'object' && 'error' in entry && entry.error) {
      throw new Error(String(entry.error));
    }
    return entry?.result ?? null;
  });
}

/**
 * Read the whole store: which days and months exist, then one hash for each.
 *
 * Two round trips, because the two sets have to come back before the hashes can be asked for. The
 * second is pipelined into one request whatever the count. The bill for a render is therefore
 * `2 + D + M`, where D is capped by the rollup at around 33 recent days and M grows twelve a year.
 *
 * The rollup rides along rather than costing a third round trip: eligibility is decided from the
 * day NAMES, which the first round trip already returned, so the lock attempt is appended to the
 * second pipeline and only exists at all on a render that has something to fold.
 *
 * A render that wins the lock does the fold before returning, which is one extra pipeline on
 * roughly one render a day. Awaited rather than fired and forgotten because there is no
 * `waitUntil` in a page render, and an unawaited promise here is a promise the platform may kill
 * halfway. The days it folds are still returned to this caller: the fold is invisible to the
 * numbers on the page, which is the whole design.
 *
 * The fixture branch is for the accessibility suite and local preview: no store exists there, and
 * a section that only ever renders its unavailable state is a section whose tables were never
 * audited by axe, never reflowed at 320px, and never in the aria golden. Opt-in by env var, never
 * set in production, and it produces its buckets relative to `now` so every window is populated.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, now?: Date }} options
 * @returns {Promise<{ ok: true, dayHashes: Array<{ day: string, fields: Record<string, string> }>,
 *                     monthHashes: Array<{ month: string, fields: Record<string, string> }> }
 *                  | { ok: false, reason: string }>}
 */
export async function readAgentTraffic({ env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  try {
    if (env.AGENT_TRAFFIC_FIXTURE === '1') {
      return { ok: true, dayHashes: fixtureDayHashes(now), monthHashes: fixtureMonthHashes(now) };
    }

    const store = readStoreConfig(env);
    if (!store) return { ok: false, reason: 'no-store' };

    const [days, months] = await pipeline(
      store,
      [
        ['SMEMBERS', DAYS_KEY],
        ['SMEMBERS', MONTHS_KEY],
      ],
      fetchImpl
    );

    const orderedDays = Array.isArray(days) ? [...days].map(String).sort() : [];
    // Months are filtered where days are not: a month name is used to build a key AND is the thing
    // the rollup writes, so a garbage member would mint a key rather than just read an absent one.
    const orderedMonths = Array.isArray(months) ? [...months].map(String).filter(isCounterMonth).sort() : [];
    if (orderedDays.length === 0 && orderedMonths.length === 0) {
      return { ok: true, dayHashes: [], monthHashes: [] };
    }

    const eligible = rollupEligibleDays(orderedDays, now);
    const commands = [
      ...orderedDays.map((day) => ['HGETALL', dayKeyFor(day)]),
      ...orderedMonths.map((month) => ['HGETALL', monthKeyFor(month)]),
    ];
    if (eligible.length > 0) commands.push(rollupLockCommand(now.toISOString()));

    const results = await pipeline(store, commands, fetchImpl);

    const dayHashes = orderedDays.map((day, index) => ({ day, fields: toFieldMap(results[index]) }));
    const monthHashes = orderedMonths.map((month, index) => ({
      month,
      fields: toFieldMap(results[orderedDays.length + index]),
    }));

    // Null means another render holds the lock, which is a reason to do nothing at all: the read
    // above is already complete and correct, and the fold will happen on some later render.
    if (eligible.length > 0 && results[commands.length - 1] !== null) {
      const eligibleSet = new Set(eligible);
      await rollUp(store, dayHashes.filter(({ day }) => eligibleSet.has(day)), fetchImpl);
    }

    return { ok: true, dayHashes, monthHashes };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name || error.message : 'error' };
  }
}

/**
 * Fold these day hashes into their months, and never let that be why a page failed.
 *
 * Its own try/catch because it is the one write on the read path: by the time it runs, the caller
 * already holds every number the page needs, so a store that refuses the fold is a rollup that
 * happens tomorrow instead. Fail open, exactly like everything else in these two modules.
 *
 * @param {{ url: string, token: string }} store
 * @param {Array<{ day: string, fields: Record<string, string> }>} dayHashes
 * @param {typeof fetch} fetchImpl
 */
async function rollUp(store, dayHashes, fetchImpl) {
  try {
    const commands = rollupCommands(dayHashes);
    if (commands.length > 0) await pipeline(store, commands, fetchImpl);
  } catch {
    // Deliberately swallowed: see above. The lock's TTL means the next render retries.
  }
}

/**
 * A canned day-hash set, shaped like a real one and positioned relative to `now` so the 24-hour,
 * 7-day and 30-day columns all differ. Deliberately boring numbers: this is scaffolding for the
 * accessibility checks, not a claim about traffic, and it never runs where a store is configured.
 *
 * @param {Date} now
 */
function fixtureDayHashes(now) {
  const nowHour = epochHour(now);
  /** @type {Array<[number, string, number]>} hours-ago, field, count */
  const seed = [
    [0, 'surface|curl|/llms.txt', 4],
    [1, 'surface|claudebot|/agents.md', 3],
    [2, 'surface|gptbot|/llms.txt', 2],
    [5, 'surface|none|/.well-known/agent-card.json', 2],
    [9, 'markdown|curl|/about', 1],
    [30, 'surface|perplexitybot|/robots.txt', 6],
    [40, 'surface|other|/.well-known/*', 3],
    [70, 'markdown|claude-user|/writing/accessibility-and-ai', 2],
    [150, 'surface|curl|/.well-known/agent-skills/index.json', 5],
    [400, 'surface|googlebot|/sitemap-index.xml', 8],
    [700, 'surface|browser|/llms-full.txt', 1],
    // The `page` class. Every family and path here already appears above, so the client table
    // gains no row and only the bot-pages table is new.
    [3, 'page|gptbot|/writing/accessibility-and-ai', 5],
    [12, 'page|perplexitybot|/about', 2],
    [80, 'page|claudebot|/writing/accessibility-and-ai', 4],
  ];

  /** @type {Map<string, Record<string, string>>} */
  const byDay = new Map();
  for (const [hoursAgo, suffix, count] of seed) {
    const at = hourStart(nowHour - hoursAgo);
    const day = at.toISOString().slice(0, 10);
    const hour = at.toISOString().slice(11, 13);
    const fields = byDay.get(day) ?? {};
    fields[`${hour}|${suffix}`] = String(count);
    byDay.set(day, fields);
  }
  return [...byDay.entries()].sort().map(([day, fields]) => ({ day, fields }));
}

/**
 * A canned rolled-up month, so the fixture exercises the merged day-plus-month path rather than
 * only the day half of it.
 *
 * Every surface, family and path here already appears in fixtureDayHashes(), on purpose: the
 * month contributes to the all-time column of rows that exist anyway, so no table gains or loses a
 * row and the committed aria goldens are untouched. It is dated well before the rollup cutoff so
 * it reads as what it is.
 *
 * @param {Date} now
 */
function fixtureMonthHashes(now) {
  const month = hourStart(epochHour(now) - 24 * 200)
    .toISOString()
    .slice(0, 7);
  return [
    {
      month,
      fields: {
        'surface|curl|/llms.txt': '12',
        'surface|googlebot|/sitemap-index.xml': '9',
        'markdown|claude-user|/writing/accessibility-and-ai': '4',
      },
    },
  ];
}
