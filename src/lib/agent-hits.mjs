/**
 * Durable counters for agent traffic: what the middleware increments, and the shape of the keys.
 *
 * Layer two of the agent-hit-counter card. Layer one (src/lib/agent-surfaces.mjs) writes one
 * console line per request, which the dashboard keeps for about an hour; this writes a count that
 * outlives it. The two are deliberately separate failure domains: the log line is the debugging
 * view, the counter is the record, and neither is allowed to break the other or the response.
 *
 * Everything above the transport is pure, so tests/agent-hits.test.mjs can assert the day
 * boundary, the classifier and the key schema without a store and without a deploy. Same split as
 * src/lib/a2a-responder.mjs and src/lib/agent-surfaces.mjs.
 *
 * Three properties are load-bearing and every change here has to preserve them:
 *
 * 1. Nothing personal is stored. Aggregate counts only, keyed by day, event class, client family
 *    and path. The raw user agent is classified and thrown away inside this module; no IP, no
 *    header, no per-request record ever reaches the store. The promise is structural, not a policy.
 * 2. Bounded cardinality. Every component of every key comes from a fixed list or is bucketed into
 *    one. Nothing a stranger can send mints a new key.
 * 3. Fail open. A missing env var, a slow store, a 500 from Upstash: all of them are undercounting,
 *    never a failed response. The caller fires this through `waitUntil` and this module never
 *    rejects.
 */

import { AGENT_SURFACE_PATHS, WELL_KNOWN_SURFACE_PATHS } from './agent-surfaces.mjs';

/**
 * Version prefix on every key. A later reshape of the schema writes `v2` beside `v1` and the
 * render layer decides what to do with both; without this, a reshape is a guess about which of two
 * incompatible shapes a given key predates.
 */
export const KEY_VERSION = 'v1';

/** The two event classes. A surface fetch and a negotiated-markdown serve are different findings. */
export const EVENTS = ['surface', 'markdown'];

/**
 * Buckets are UTC, and the field carries the UTC hour.
 *
 * This is the one place on the site that is not on Matt's local date, and it is deliberate. The
 * vault, the changelog and every rendered timestamp stay America/Vancouver (see CLAUDE.md); that
 * convention is about dates people read, and this is storage.
 *
 * Storing a local day would be a lossy, irreversible choice made at write time: a Vancouver day
 * cannot be re-projected into any other timezone afterwards, and the site's own timezone is not
 * obviously the right frame for a page about who is fetching this site from where. Hour resolution
 * in UTC is strictly more information than either: the render layer reconstructs a Vancouver day,
 * or any other, by summing the right 24 hours, and an hourly trend becomes a rendering rather than
 * a schema change. It also matches every system this data will ever be cross-referenced against,
 * starting with Vercel's own logs.
 *
 * The cost is 24x the fields per day hash in the worst case, which is a few hundred fields on a
 * site this size and still one HGETALL.
 */
export const COUNTER_TIME_ZONE = 'UTC';

/** @param {Date} date @returns {string} YYYY-MM-DD, UTC */
export function counterDay(date) {
  return date.toISOString().slice(0, 10);
}

/** @param {Date} date @returns {string} HH, 00 to 23, UTC */
export function counterHour(date) {
  return date.toISOString().slice(11, 13);
}

/**
 * The client families, as data rather than a switch, so welcoming a new crawler in robots.txt and
 * counting it separately is one line in one list.
 *
 * First match wins, so order is meaningful and there are two ordering rules:
 *
 * - A longer name goes above the shorter one it contains (`applebot-extended` before `applebot`).
 * - The generic-bot catch sits above `browser`, because most crawlers announce themselves inside a
 *   `Mozilla/5.0 (compatible; ...)` string and would otherwise be counted as people.
 *
 * The named entries are the crawlers src/pages/robots.txt.ts explicitly welcomes, kept one family
 * per token rather than grouped by vendor. ClaudeBot and Claude-User are the same company and a
 * completely different finding: one is a training crawl, the other is an agent fetching this page
 * because a person asked it something. Grouping is a render-time decision the store should not
 * make for slice three.
 */
export const CLIENT_FAMILIES = [
  { family: 'gptbot', match: /gptbot/i },
  { family: 'chatgpt-user', match: /chatgpt-user/i },
  { family: 'oai-searchbot', match: /oai-searchbot/i },
  { family: 'claudebot', match: /claudebot/i },
  { family: 'claude-user', match: /claude-user/i },
  { family: 'claude-searchbot', match: /claude-searchbot/i },
  { family: 'anthropic-ai', match: /anthropic-ai/i },
  { family: 'perplexitybot', match: /perplexitybot/i },
  { family: 'perplexity-user', match: /perplexity-user/i },
  { family: 'google-extended', match: /google-extended/i },
  { family: 'googleother', match: /googleother/i },
  { family: 'googlebot', match: /googlebot/i },
  { family: 'bingbot', match: /bingbot/i },
  { family: 'ccbot', match: /ccbot/i },
  { family: 'bytespider', match: /bytespider/i },
  { family: 'meta-external', match: /meta-external/i },
  { family: 'applebot-extended', match: /applebot-extended/i },
  { family: 'applebot', match: /applebot/i },
  { family: 'cohere-ai', match: /cohere-ai/i },
  { family: 'amazonbot', match: /amazonbot/i },

  // The script tells. Somebody at a terminal or a small program is the second most interesting row
  // on this page after the named agents, and it is the one a live agent task usually shows up as.
  { family: 'curl', match: /^curl\//i },
  { family: 'wget', match: /^wget\//i },
  { family: 'python', match: /python-requests|python-httpx|aiohttp|httpx|^python\//i },
  { family: 'node', match: /^node(\.js)?[/ ]|undici|^got\/|axios/i },
  { family: 'go', match: /^go-http-client\//i },

  // Anything that says it is a robot but is not one we named. Above `browser` on purpose.
  { family: 'other-bot', match: /bot\b|crawler|spider|slurp|scrap|fetcher|feed|monitor|http-client/i },

  // A real engine token, not just `Mozilla/5.0`, which every crawler in the list above also sends.
  { family: 'browser', match: /mozilla\/5\.0.*\b(chrome|safari|firefox|edg|opr|trident)\//i },
];

/** Families that are not pattern matches: the two ends of the list. */
export const FALLBACK_FAMILY = 'other';
export const ABSENT_FAMILY = 'none';

/**
 * A user agent in, one bounded family out. This is where the raw string dies: nothing downstream
 * of here has it, which is what makes the privacy promise structural.
 *
 * An absent user agent gets its own family rather than falling into `other`. "Sent no UA at all"
 * is a distinct and common shape for scripted fetchers, and collapsing it into the unknown bucket
 * would throw away the difference between "we could not tell" and "it did not say".
 *
 * @param {string | null | undefined} ua
 * @returns {string}
 */
export function classifyClient(ua) {
  if (!ua || !ua.trim()) return ABSENT_FAMILY;
  const found = CLIENT_FAMILIES.find(({ match }) => match.test(ua));
  return found ? found.family : FALLBACK_FAMILY;
}

/** Every family that can ever appear in a key. The render layer can build its rows from this. */
export function knownFamilies() {
  return [...CLIENT_FAMILIES.map(({ family }) => family), FALLBACK_FAMILY, ABSENT_FAMILY];
}

/** The surfaces that get a key of their own; anything else under /.well-known/ buckets. */
const NAMED_SURFACES = new Set([...AGENT_SURFACE_PATHS, ...WELL_KNOWN_SURFACE_PATHS]);
const WELL_KNOWN_PREFIX = '/.well-known/';

/** The bucket for a well-known path the site does not publish. */
export const UNNAMED_WELL_KNOWN = '/.well-known/*';

/** The bucket for any path that fails the shape check below. */
export const UNNAMED_PAGE = '/*';

// A page path is only ever counted after the middleware has served its markdown sibling, so it is
// already bounded by the pages that exist. These caps are the second lock: if that call site ever
// moves ahead of the upstream check, an attacker still cannot mint keys, only inflate one bucket.
const MAX_PATH_LENGTH = 96;
const MAX_PATH_SEGMENTS = 4;
const PAGE_PATH_SHAPE = /^\/[a-z0-9\-/]*$/;

/** Trailing slash tolerated so /llms.txt/ counts as the same surface. Mirrors agent-surfaces.mjs. */
function normalize(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/**
 * The path component of a key, bucketed so the key space stays finite.
 *
 * @param {string} event one of EVENTS
 * @param {string} pathname
 * @returns {string}
 */
export function counterPath(event, pathname) {
  const path = normalize(pathname);
  if (event === 'surface') {
    if (NAMED_SURFACES.has(path)) return path;
    if (path.startsWith(WELL_KNOWN_PREFIX)) return UNNAMED_WELL_KNOWN;
    return UNNAMED_PAGE;
  }
  if (path === '') return '/';
  if (path.length > MAX_PATH_LENGTH) return UNNAMED_PAGE;
  if (path.split('/').length - 1 > MAX_PATH_SEGMENTS) return UNNAMED_PAGE;
  if (!PAGE_PATH_SHAPE.test(path)) return UNNAMED_PAGE;
  return path;
}

/** The set holding every UTC day that has a hash, so a reader never has to SCAN. */
export const DAYS_KEY = `hits:${KEY_VERSION}:days`;

/** The all-time counter. */
export const TOTAL_KEY = `hits:${KEY_VERSION}:total`;

/** The hash holding one UTC day. @param {string} day YYYY-MM-DD, UTC @returns {string} */
export function dayKeyFor(day) {
  return `hits:${KEY_VERSION}:day:${day}`;
}

/**
 * The rollup keys. Nothing in the write path below ever touches these: they are written by the
 * read path (src/lib/agent-traffic.mjs) when it notices a day old enough that no rendered number
 * can still reach its hours. They live here because the schema lives here, both directions.
 *
 * Month keys sit BESIDE the v1 day keys rather than reshaping them. A day hash still means exactly
 * what it meant; a month hash is the same counts with the hour dropped, because past the longest
 * rolling window the hour is provably unused (see agent-traffic.mjs for that argument).
 */

/** The set holding every UTC month that has a rollup hash, so a reader never has to SCAN. */
export const MONTHS_KEY = `hits:${KEY_VERSION}:months`;

/** The hash holding one rolled-up UTC month. @param {string} month YYYY-MM, UTC @returns {string} */
export function monthKeyFor(month) {
  return `hits:${KEY_VERSION}:month:${month}`;
}

/** The lock a render takes before it moves any day into a month. */
export const ROLLUP_LOCK_KEY = `hits:${KEY_VERSION}:rollup`;

/** The UTC month a stored day belongs to. @param {string} day YYYY-MM-DD @returns {string} */
export function monthOf(day) {
  return day.slice(0, 7);
}

/** Is this what the schema calls a month? Guards a key built from whatever SMEMBERS returned. */
export function isCounterMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

/** The field delimiter inside a day hash. Cannot appear in an hour, event, family or path. */
const FIELD_DELIMITER = '|';

/**
 * A day-hash field, back into its parts. The inverse of the `field` built in hitKeys(), and the
 * reason src/lib/agent-traffic.mjs never rebuilds the schema: both directions live here, so a
 * reshape of the key is one file rather than a hunt.
 *
 * A field that does not split into exactly four parts is returned as null rather than guessed at.
 * The only way one can exist is a schema change that forgot to bump KEY_VERSION, and a reader
 * dropping the row it cannot parse beats a reader inventing a path from it.
 *
 * @param {string} field
 * @returns {{ hour: string, event: string, family: string, path: string } | null}
 */
export function parseHitField(field) {
  const parts = field.split(FIELD_DELIMITER);
  if (parts.length !== 4) return null;
  const [hour, event, family, path] = parts;
  if (!/^\d{2}$/.test(hour) || !EVENTS.includes(event) || !family || !path) return null;
  return { hour, event, family, path };
}

/**
 * A day-hash row, as the month-hash field it rolls up into: the same three components with the
 * hour dropped. Three parts rather than four is what makes the two field shapes impossible to
 * confuse, in either direction, without a version bump.
 *
 * @param {{ event: string, family: string, path: string }} row
 * @returns {string}
 */
export function monthFieldFor({ event, family, path }) {
  return [event, family, path].join(FIELD_DELIMITER);
}

/**
 * A month-hash field, back into its parts. Same contract as parseHitField(): a field that is not
 * exactly what the schema promises is returned as null and dropped by the caller, never guessed at.
 *
 * @param {string} field
 * @returns {{ event: string, family: string, path: string } | null}
 */
export function parseMonthField(field) {
  const parts = field.split(FIELD_DELIMITER);
  if (parts.length !== 3) return null;
  const [event, family, path] = parts;
  if (!EVENTS.includes(event) || !family || !path) return null;
  return { event, family, path };
}

/**
 * The whole key schema, in one function, so the render layer reads it from here rather than
 * rebuilding string literals that can drift.
 *
 * Three keys per hit, because every later rendering should be a read rather than a regret:
 *
 * | Key | Type | Answers |
 * |---|---|---|
 * | `hits:v1:day:<utc-day>` | hash, field `<utc-hour>\|<event>\|<family>\|<path>` | everything about one UTC day, at hour resolution, in one HGETALL |
 * | `hits:v1:days` | set of UTC days | which days exist, so a trend view never has to SCAN |
 * | `hits:v1:total` | counter | the one number the retro homepage widget wants |
 *
 * And three more that no hit ever writes, added 2026-08-06 so a render's cost stops growing with
 * the site's age. The read path writes them; see src/lib/agent-traffic.mjs.
 *
 * | Key | Type | Answers |
 * |---|---|---|
 * | `hits:v1:month:<utc-month>` | hash, field `<event>\|<family>\|<path>` | one whole UTC month, hour dropped, in one HGETALL |
 * | `hits:v1:months` | set of UTC months | which months exist, the month set's twin |
 * | `hits:v1:rollup` | string with a TTL | the lock one render holds while it folds days into a month |
 *
 * The hour leads the field so a prefix match answers "this hour" without parsing, and so the
 * fields of a day sort into chronological order.
 *
 * A day's hash holds at most (24 hours x 2 events x ~30 families x ~40 paths) fields and
 * realistically a few dozen, so one round trip answers totals, per-client, per-path and per-hour
 * for any window, in any timezone. Nothing expires and nothing is thrown away: a day past every
 * rolling window is folded into its month rather than deleted, so the all-time numbers are
 * unchanged and only the hour, which nothing renders at that age, is gone.
 *
 * The field delimiter is `|`, which cannot appear in an hour, an event, a family or a bucketed
 * path.
 *
 * @param {{ event: string, path: string, ua?: string | null, now?: Date }} hit
 * @returns {{ day: string, hour: string, event: string, family: string, path: string,
 *             field: string, dayKey: string, daysKey: string, totalKey: string,
 *             commands: string[][] }}
 */
export function hitKeys({ event, path, ua, now = new Date() }) {
  if (!EVENTS.includes(event)) throw new Error(`unknown event class: ${event}`);
  const day = counterDay(now);
  const hour = counterHour(now);
  const family = classifyClient(ua);
  const countedPath = counterPath(event, path);
  const field = [hour, event, family, countedPath].join(FIELD_DELIMITER);

  const dayKey = dayKeyFor(day);
  const daysKey = DAYS_KEY;
  const totalKey = TOTAL_KEY;

  return {
    day,
    hour,
    event,
    family,
    path: countedPath,
    field,
    dayKey,
    daysKey,
    totalKey,
    commands: [
      ['HINCRBY', dayKey, field, '1'],
      ['SADD', daysKey, day],
      ['INCR', totalKey],
    ],
  };
}

/**
 * Where the store lives. Both name pairs are read because the Vercel marketplace has shipped
 * Upstash under both over the years, and which one a project got depends on when it was
 * provisioned. Absent means counting is off, which is a supported state: local dev never needs a
 * store, and this PR is mergeable before the integration exists.
 *
 * @param {Record<string, string | undefined>} env
 */
export function readStoreConfig(env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

/** One request's worth of budget. Past this the count is lost, which is the correct trade. */
const STORE_TIMEOUT_MS = 1500;

/**
 * Count one hit. Never throws, never rejects, and returns what it did so a test can assert the
 * env-absent path made no network call at all.
 *
 * The caller fires this through `waitUntil` so the response is already on its way out; the
 * try/catch here is belt to that braces, because a throw inside a `waitUntil` argument happens
 * before `waitUntil` ever sees a promise.
 *
 * @param {{ event: string, path: string, ua?: string | null, now?: Date,
 *           env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} hit
 * @returns {Promise<{ ok: boolean, reason?: string, field?: string, day?: string }>}
 */
export async function recordHit({ event, path, ua, now, env = process.env, fetchImpl = fetch }) {
  let keys;
  try {
    const store = readStoreConfig(env);
    if (!store) return { ok: false, reason: 'no-store' };

    keys = hitKeys({ event, path, ua, now });

    const response = await fetchImpl(`${store.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${store.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(keys.commands),
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
    });

    if (!response.ok) return { ok: false, reason: `status-${response.status}`, field: keys.field, day: keys.day };
    return { ok: true, field: keys.field, day: keys.day };
  } catch (error) {
    // Deliberately swallowed, per the posture this inherits from the middleware's surface branch:
    // observation is never worth a failed response. Undercounting is the acceptable failure.
    return { ok: false, reason: error instanceof Error ? error.name : 'error', field: keys?.field };
  }
}
