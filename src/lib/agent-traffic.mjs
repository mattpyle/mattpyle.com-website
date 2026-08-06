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
 */

import { DAYS_KEY, dayKeyFor, parseHitField, readStoreConfig } from './agent-hits.mjs';

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
 * @param {Array<{ hour: number, count: number }>} rows
 * @param {number} nowHour
 */
function windowTotals(rows, nowHour) {
  const totals = { total: 0, day: 0, week: 0, month: 0 };
  for (const row of rows) {
    totals.total += row.count;
    for (const [id, hours] of Object.entries(WINDOW_HOURS)) {
      if (row.hour >= windowStart(nowHour, hours)) totals[id] += row.count;
    }
  }
  return totals;
}

/**
 * @typedef {{ path?: string, family?: string, total: number, day: number, week: number,
 *             month: number, lastHour: number }} TallyRow
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
      if (row.hour >= windowStart(nowHour, hours)) group[id] += row.count;
    }
    if (row.hour > group.lastHour) group.lastHour = row.hour;
  }

  const sorted = [...groups.values()].sort(
    (a, b) => b.total - a.total || String(a[keyName]).localeCompare(String(b[keyName]))
  );
  return { rows: sorted.slice(0, MAX_TABLE_ROWS), omitted: Math.max(0, sorted.length - MAX_TABLE_ROWS) };
}

/**
 * Everything the section renders, from flat rows.
 *
 * The headline numbers count both event classes: a surface fetch and a negotiated-markdown serve
 * are both an agent asking this site for something, and the page says which is which underneath.
 *
 * @param {Array<{ hour: number, event: string, family: string, path: string, count: number }>} rows
 * @param {Date} now
 */
export function summarizeTraffic(rows, now = new Date()) {
  const nowHour = epochHour(now);
  const surfaceRows = rows.filter((row) => row.event === 'surface');
  const markdownRows = rows.filter((row) => row.event === 'markdown');

  return {
    counted: rows.length > 0,
    totals: windowTotals(rows, nowHour),
    surfaceTotals: windowTotals(surfaceRows, nowHour),
    markdownTotals: windowTotals(markdownRows, nowHour),
    surfaces: tally(surfaceRows, (row) => row.path, nowHour, 'path'),
    clients: tally(rows, (row) => row.family, nowHour, 'family'),
    pages: tally(markdownRows, (row) => row.path, nowHour, 'path'),
    /** The newest bucket anything landed in, for "last counted". Null when nothing has. */
    lastHour: rows.length === 0 ? null : Math.max(...rows.map((row) => row.hour)),
  };
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
 * Read the whole store: which days exist, then every day's hash.
 *
 * Two round trips, because the day list has to come back before the hashes can be asked for. The
 * second is pipelined into one request whatever the day count. Reading every day is what the
 * all-time total costs, and at this site's scale that is a few dozen fields per day and a handful
 * of days; a monthly rollup key is the named later fix when it stops being.
 *
 * The fixture branch is for the accessibility suite and local preview: no store exists there, and
 * a section that only ever renders its unavailable state is a section whose tables were never
 * audited by axe, never reflowed at 320px, and never in the aria golden. Opt-in by env var, never
 * set in production, and it produces its buckets relative to `now` so every window is populated.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, now?: Date }} options
 * @returns {Promise<{ ok: true, dayHashes: Array<{ day: string, fields: Record<string, string> }> }
 *                  | { ok: false, reason: string }>}
 */
export async function readAgentTraffic({ env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  try {
    if (env.AGENT_TRAFFIC_FIXTURE === '1') return { ok: true, dayHashes: fixtureDayHashes(now) };

    const store = readStoreConfig(env);
    if (!store) return { ok: false, reason: 'no-store' };

    const [days] = await pipeline(store, [['SMEMBERS', DAYS_KEY]], fetchImpl);
    if (!Array.isArray(days) || days.length === 0) return { ok: true, dayHashes: [] };

    const ordered = [...days].map(String).sort();
    const hashes = await pipeline(
      store,
      ordered.map((day) => ['HGETALL', dayKeyFor(day)]),
      fetchImpl
    );

    return {
      ok: true,
      dayHashes: ordered.map((day, index) => ({ day, fields: toFieldMap(hashes[index]) })),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name || error.message : 'error' };
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
