/**
 * The rate limit in front of the public MCP endpoint: what it counts, what it stores, and what it
 * does when it cannot reach the store.
 *
 * `/mcp` lets a stranger point this site's auditor at a URL of their choosing. Every accepted call
 * spends a dozen HTTP requests at a third party's origin under this site's name, from Vercel's
 * addresses, so an unbounded endpoint is not a cost problem, it is an open relay with an honest
 * User-Agent. The limit is what makes the endpoint publishable at all — it is the last item on the
 * stage-2 card's blocker list, and it is enforced from the first request the endpoint ever answers.
 * There is no unlimited window, not even a day of one.
 *
 * Four tiers, all fixed-window and all env-configurable. Three count work and have two limits
 * each. The fourth, `read`, counts reads of a run and has one:
 *
 * | Tier | Limit | Default | Window | Key |
 * |---|---|---|---|---|
 * | fast | Per caller | 10 audits | rolling hour, aligned to the epoch | `mcp:v1:caller:<hmac>:<window>` |
 * | fast | Global | 500 audits | UTC day | `mcp:v1:global:<utc-day>` |
 * | deep | Per caller | 2 audits | UTC day | `mcp:v1:deep:caller:<hmac>:<utc-day>` |
 * | deep | Global | 10 audits | UTC day | `mcp:v1:deep:global:<utc-day>` |
 * | session | Per caller | 3 sessions | UTC day | `mcp:v1:session:caller:<hmac>:<utc-day>` |
 * | session | Global | 20 sessions | UTC day | `mcp:v1:session:global:<utc-day>` |
 * | read | Per caller | 60 reads | rolling minute, aligned to the epoch | `mcp:v1:read:caller:<hmac>:<window>` |
 *
 * **The read tier bounds the reads that reach Temporal and spend no allowance.** It charges the
 * MCP `get_audit` tool, every view, and the A2A `GetTask` method. Each is a describe and a Query
 * or two against Temporal Cloud, answered by the hosted worker, and nothing else bounded how often
 * one caller could ask. Sixty a minute is far above a polite poll: the status view tells a caller
 * to wait five seconds between reads, which is twelve a minute. A read still spends no audit
 * allowance, so a caller can always read back a run they started.
 *
 * It differs from the other three tiers in three ways, each a column of the `TIERS` table:
 *
 * - **No global budget.** A shared read budget would let one caller lock every other caller out of
 *   reading their own reports. So a read is one store round trip, allowed or refused.
 * - **It fails open.** See property 2 below.
 * - **A shorter store timeout**, 500 ms against 1500 ms, so a slow store adds at most half a second
 *   to a read before the read goes ahead uncounted.
 *
 * Not charged: the handshakes (`initialize`, `tools/list`, `ping`, notifications), which are
 * answered from memory; `ask-about-site`; a later message on a consultant session, which the
 * session's own caps bound; the consultant skill's own wait for a reply; a GET; a read whose id is
 * malformed, which is refused before any Temporal call; and `CancelTask`, because a cancel lowers
 * cost and a caller over the read limit must still be able to close a session.
 *
 * **The edge rule, which this repository does not enforce.** Every POST this module refuses has
 * already cost a function invocation and a store write, so the limiter cannot protect the store
 * from a flood. That is the job of one Vercel Firewall rate-limit rule, kept by hand in the Vercel
 * dashboard: POST requests to `/mcp` and `/a2a`, about 200 per 60 seconds per IP address, action
 * 429. It cannot live in `vercel.json`, whose `mitigate` action supports only challenge and deny.
 * Nothing in this repository creates the rule or checks that it exists. `README.md`, "Operations",
 * carries the same values for whoever has to recreate it.
 *
 * **The session tier bounds the audit consultant** (src/lib/a2a-consultant-skill.mjs). One session
 * is a Claude-driven conversation whose own caps (turns, tokens, one deep audit) bound what it can
 * spend; these counters bound how many sessions strangers can open in a day, which is the bound
 * the consultant's caps leave to its starter. A session is charged once, when it starts, and never
 * for a later message on it. Its audits are not charged here: the agent reaches the audit tiers
 * through `/mcp` like any other caller, on the counters above.
 *
 * **Why the deep numbers are two orders of magnitude smaller.** A fast audit is a
 * dozen HTTP round trips inside the function that answered the request: it prices
 * seconds of function time, and the cost that bounds it is the target's origin
 * rather than this site's bill. A deep audit starts a durable workflow that
 * renders up to three of the target's pages in a real browser on a paid always-on
 * worker. It prices minutes of worker and Temporal Cloud time, and it is the first
 * thing on this site a stranger can spend real money on. Ten a day is the ceiling
 * that makes the worst case — somebody finds the endpoint and loops it — a number
 * Matt can look at rather than an incident. Two per caller is enough to try it,
 * read the report, and try a second site.
 *
 * The cap is a spend limit and nothing more, and it is worth saying so because it
 * briefly stood in for a concurrency limit the worker did not have. Measured
 * 2026-08-15: two deep audits started a second apart both rendered at once on the
 * one hosted worker, because nothing set `maxConcurrentActivityTaskExecutions` on
 * it — the `marky` contention the scorecard's `AUDIT_CONCURRENCY` docblock warns
 * about, reachable by strangers for the first time. The worker now sets it to 1
 * (`HOSTED_ACTIVITY_CONCURRENCY` in `agents/steward/src/config.ts`), so concurrent
 * deep audits serialise and the second one reports `queued: true` with a position.
 * These counters bound the day's bill; the worker option bounds what runs at once.
 *
 * **The two tiers count separately, and neither spends the other's budget.** A
 * deep call touches only the deep counters. That is deliberate: charging a deep
 * audit against the fast tier's hourly allowance would let one deep run lock a
 * caller out of the cheap tier, and the two costs have nothing to do with each
 * other.
 *
 * **No operator bypass, decided 2026-08-15.** There is no header, token or
 * allowlist that skips these counters, because a bypass on a public surface is an
 * authentication story the endpoint would then have to keep. Matt's own runs go
 * through the CLI or a direct workflow start, both of which never touch this file;
 * for testing the endpoint itself, the user guide documents deleting the day's
 * counter keys from the Upstash console.
 *
 * The environment it reads, all of it optional except the first:
 *
 * | Variable | Effect |
 * |---|---|
 * | `MCP_AUDIT_RATE_SECRET` | The HMAC key. **Required** — absent, every audit is refused. |
 * | `MCP_AUDIT_RATE_PER_CALLER` | Fast audits one caller may run per window. Default 10. |
 * | `MCP_AUDIT_RATE_WINDOW_SECONDS` | The fast per-caller window. Default 3600. |
 * | `MCP_AUDIT_RATE_GLOBAL_PER_DAY` | Fast audits the endpoint runs per UTC day. Default 500. |
 * | `MCP_DEEP_RATE_PER_CALLER` | Deep audits one caller may start per UTC day. Default 2. |
 * | `MCP_DEEP_RATE_GLOBAL_PER_DAY` | Deep audits the endpoint starts per UTC day. Default 10. |
 * | `A2A_SESSION_RATE_PER_CALLER` | Consultant sessions one caller may start per UTC day. Default 3. |
 * | `A2A_SESSION_RATE_GLOBAL_PER_DAY` | Consultant sessions the endpoint starts per UTC day. Default 20. |
 * | `MCP_READ_RATE_PER_CALLER` | Reads of a run one caller may make per window, on `/mcp` and `/a2a` together. Default 60. |
 * | `MCP_READ_RATE_WINDOW_SECONDS` | The read window. Default 60. |
 * | `UPSTASH_REDIS_REST_URL` / `_TOKEN` | The store. `KV_REST_API_URL` / `_TOKEN` is read too. |
 *
 * Setting the secret is what turns the endpoint on, which is the right way round: a deploy that
 * forgets it serves 429s rather than unlimited audits.
 *
 * Three properties are load-bearing, and every change here has to keep them.
 *
 * 1. **The stored key is an HMAC of the client IP, never the IP.** This site's counters have never
 *    held anything personal (src/lib/agent-hits.mjs, property 1), and a rate limiter is exactly the
 *    kind of exception that would quietly end that: it is the one thing on the site that genuinely
 *    needs to tell one caller from another. It does it with a keyed hash under a server-side secret
 *    and a TTL no longer than the window, so the store holds an opaque 128-bit label that stops
 *    existing when the window does. The secret is what makes it opaque — an IPv4 space is 2^32
 *    wide, so a plain hash would be reversible by enumeration in seconds — which is why a missing
 *    secret is a refusal rather than a fallback to something weaker.
 *
 * 2. **It fails closed.** A missing store, a missing secret, a timeout, a 500 from Upstash: all of
 *    them refuse the audit. That is the opposite of the posture in agent-hits.mjs, deliberately and
 *    for the same reason — there, the failure is one uncounted hit, and an unanswered request would
 *    be worse than a lost data point. Here the failure is an unlimited stranger, and a lost data
 *    point is better than an incident.
 *
 *    **The read tier is the one exception, and it fails open** (`onFailure: 'allow'` in the table).
 *    A read that cannot be counted is allowed. A store outage must not stop a caller reading an
 *    audit that is already running, and while the store is down the three tiers that start work
 *    still refuse, so few new runs exist to read. The edge rule above bounds what is left. A read
 *    that the store did count past the limit is still refused.
 *
 * 3. **Refusal costs no global budget.** The two limits are two round trips rather than one
 *    pipeline, so a single caller hammering the endpoint past their own limit cannot burn the day's
 *    global allowance and lock everyone else out. The caller check runs first; the global counter is
 *    only touched by a request that passed it.
 *
 * Everything above the transport is pure, so tests/mcp-rate-limit.test.mjs can assert the key
 * schema, the window arithmetic, the header parsing and the fail-closed paths with no store and no
 * deploy. Same split as src/lib/a2a-responder.mjs and src/lib/agent-hits.mjs.
 */

import { createHmac } from 'node:crypto';
import { readStoreConfig } from './agent-hits.mjs';

/**
 * Version prefix on every key, for the same reason agent-hits.mjs carries one: a later reshape
 * writes `v2` beside `v1` rather than leaving a reader guessing which shape a key predates.
 */
export const KEY_VERSION = 'v1';

/** The defaults, named so the tests and the docs read the same numbers the code does. */
export const DEFAULT_PER_CALLER = 10;
export const DEFAULT_WINDOW_SECONDS = 3600;
export const DEFAULT_GLOBAL_PER_DAY = 500;

/**
 * The deep tier's, both per UTC day. See the module docblock for why they are
 * this much smaller than the fast tier's; the short version is that a deep audit
 * spends minutes of paid worker time where a fast one spends seconds of function
 * time.
 */
export const DEFAULT_DEEP_PER_CALLER = 2;
export const DEFAULT_DEEP_GLOBAL_PER_DAY = 10;

/** The session tier's, both per UTC day: the audit consultant's new sessions. */
export const DEFAULT_SESSION_PER_CALLER = 3;
export const DEFAULT_SESSION_GLOBAL_PER_DAY = 20;

/**
 * The read tier's: reads of a run one caller may make per window, and the window. A minute rather
 * than an hour, so a caller who polls too fast waits seconds rather than the rest of an hour.
 */
export const DEFAULT_READ_PER_CALLER = 60;
export const DEFAULT_READ_WINDOW_SECONDS = 60;

/** One request's worth of budget against the store. Past this the audit is refused, not admitted. */
const STORE_TIMEOUT_MS = 1500;

/** The read tier's, shorter because a read that cannot be counted goes ahead: this is all it waits. */
const READ_STORE_TIMEOUT_MS = 500;

/**
 * How long a refused caller is told to wait when the refusal is the endpoint's own fault rather
 * than theirs. Short, because a config or store problem is fixed by the operator and not by the
 * caller waiting out a window.
 */
const INFRASTRUCTURE_RETRY_SECONDS = 60;

/**
 * The tiers, as data. `checkRateLimit`, the `read*Limits` functions and the key builders below all
 * read this table, so a tier is described once.
 *
 * - `limits`: each limit's environment variable and its default.
 * - `window`: the per-caller window. `'fixed'` is a window of `limits.windowSeconds`, aligned to the
 *   epoch. `'utc-day'` is the UTC day, with no variable to change it. The global budget is always
 *   the UTC day.
 * - `callerPrefix`, `globalPrefix`: what follows `mcp:v1:` in the tier's two keys. A null
 *   `globalPrefix` is a tier with no global budget, and its check is one store round trip.
 * - `unit`: what the tier counts, for the refusal's sentence. `callerReason` replaces that sentence
 *   where a count would not help the caller.
 * - `onFailure`: what a check does when it cannot count, for want of a secret, a store, an address
 *   or an answer. `'refuse'` is property 2 of the module docblock. `'allow'` is its one exception.
 * - `storeTimeoutMs`: how long one store request may take.
 */
const TIERS = Object.freeze({
  fast: {
    limits: {
      perCaller: ['MCP_AUDIT_RATE_PER_CALLER', DEFAULT_PER_CALLER],
      windowSeconds: ['MCP_AUDIT_RATE_WINDOW_SECONDS', DEFAULT_WINDOW_SECONDS],
      globalPerDay: ['MCP_AUDIT_RATE_GLOBAL_PER_DAY', DEFAULT_GLOBAL_PER_DAY],
    },
    window: 'fixed',
    callerPrefix: 'caller',
    globalPrefix: 'global',
    unit: 'audits',
    onFailure: 'refuse',
    storeTimeoutMs: STORE_TIMEOUT_MS,
  },
  deep: {
    limits: {
      perCaller: ['MCP_DEEP_RATE_PER_CALLER', DEFAULT_DEEP_PER_CALLER],
      globalPerDay: ['MCP_DEEP_RATE_GLOBAL_PER_DAY', DEFAULT_DEEP_GLOBAL_PER_DAY],
    },
    window: 'utc-day',
    callerPrefix: 'deep:caller',
    globalPrefix: 'deep:global',
    unit: 'deep audits',
    onFailure: 'refuse',
    storeTimeoutMs: STORE_TIMEOUT_MS,
  },
  session: {
    limits: {
      perCaller: ['A2A_SESSION_RATE_PER_CALLER', DEFAULT_SESSION_PER_CALLER],
      globalPerDay: ['A2A_SESSION_RATE_GLOBAL_PER_DAY', DEFAULT_SESSION_GLOBAL_PER_DAY],
    },
    window: 'utc-day',
    callerPrefix: 'session:caller',
    globalPrefix: 'session:global',
    unit: 'consultant sessions',
    onFailure: 'refuse',
    storeTimeoutMs: STORE_TIMEOUT_MS,
  },
  read: {
    limits: {
      perCaller: ['MCP_READ_RATE_PER_CALLER', DEFAULT_READ_PER_CALLER],
      windowSeconds: ['MCP_READ_RATE_WINDOW_SECONDS', DEFAULT_READ_WINDOW_SECONDS],
    },
    window: 'fixed',
    callerPrefix: 'read:caller',
    globalPrefix: null,
    callerReason: 'this caller is reading too fast',
    onFailure: 'allow',
    storeTimeoutMs: READ_STORE_TIMEOUT_MS,
  },
});

/**
 * One tier's limits, from the environment, with the table's defaults.
 *
 * A malformed value falls back to the default rather than throwing. The alternative is an endpoint
 * that 500s on a typo in a dashboard field, and a limiter that refuses to start is a limiter that
 * gets switched off.
 *
 * @param {{ limits: Record<string, [string, number]> }} spec
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, number>}
 */
function limitsFor(spec, env) {
  const positive = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return Object.fromEntries(
    Object.entries(spec.limits).map(([name, [variable, fallback]]) => [name, positive(env[variable], fallback)])
  );
}

/** A key under the version prefix: `mcp:v1:<prefix>:<part>:<part>`. */
function keyFor(prefix, ...parts) {
  return ['mcp', KEY_VERSION, prefix, ...parts].join(':');
}

/**
 * The fast tier's limits, from the environment, with the documented defaults and the
 * malformed-falls-back-to-the-default rule of `limitsFor`.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ perCaller: number, windowSeconds: number, globalPerDay: number }}
 */
export function readLimits(env) {
  return limitsFor(TIERS.fast, env);
}

/**
 * The deep tier's limits, from the environment, with the same
 * malformed-falls-back-to-the-default rule as `readLimits`.
 *
 * There is no window variable: both deep limits are the UTC day, and that is a
 * design choice rather than a default. An hourly deep allowance would let one
 * caller spend the day's global cap in a few hours of patient looping, and the
 * cost being bounded here is a daily bill.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ perCaller: number, globalPerDay: number }}
 */
export function readDeepLimits(env) {
  return limitsFor(TIERS.deep, env);
}

/**
 * The session tier's limits, from the environment, with the same rule. Both are per UTC day, for
 * the deep tier's reason: the cost being bounded is a daily model bill.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ perCaller: number, globalPerDay: number }}
 */
export function readSessionLimits(env) {
  return limitsFor(TIERS.session, env);
}

/**
 * The read tier's limits, from the environment, with the same rule. One limit and its window: the
 * tier has no global budget.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ perCaller: number, windowSeconds: number }}
 */
export function readReadLimits(env) {
  return limitsFor(TIERS.read, env);
}

/**
 * The client's address, from the headers the platform sets.
 *
 * **This function's correctness rests on one platform guarantee, and it is load-bearing.** Vercel
 * *overwrites* `x-forwarded-for` and `x-real-ip` on every inbound request with the address it
 * accepted the connection from; it does not append to whatever the caller sent. So these headers
 * are set by the infrastructure, not by the caller, and the address they carry is one a caller
 * cannot choose.
 *
 * That guarantee is the whole limit. If a caller could set their own address, they could mint a
 * fresh one per request: the per-caller counter would never reach 10, every request would go
 * straight through to the global counter, and 500 requests would drain the day's budget and lock
 * out everyone else — a denial of service costing one loop. The per-caller limit would not be weak,
 * it would be decorative, and the global limit would become the attacker's weapon.
 *
 * **Deploying this code anywhere but Vercel means deciding this header again**, and deciding it
 * wrong is silent: the limiter still counts, still expires, still returns clean 429s, and stops
 * bounding anything. Behind a proxy that appends rather than overwrites, the trustworthy value is
 * the Nth entry from the *right*, where N is the number of proxies you control — never the first
 * from the left, which is then the one part of the header the caller wrote.
 *
 * `x-real-ip` is preferred because it is a single value with no parsing and no ambiguity about
 * which entry is the client. `x-forwarded-for`'s first entry is the fallback for the same address:
 * on Vercel the header is the client alone, and where a proxy chain does exist the client is
 * conventionally first. Reading the *last* entry, the other common spelling, would key every caller
 * behind the edge into one bucket and block the site's own callers as one.
 *
 * Returns null when nothing usable is present, which is a refusal upstream rather than a free pass:
 * "the platform sent no address" must not be the cheapest way to get an unlimited audit.
 *
 * @param {Headers} headers
 * @returns {string | null}
 */
export function clientIpFrom(headers) {
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return null;
}

/**
 * The per-caller key's identifying half: a keyed hash of the address, truncated to 128 bits.
 *
 * Domain-separated by a literal prefix so the same secret can key something else later without the
 * two schemes ever agreeing on a value. Truncation is a key-size choice, not a security one — 128
 * bits is far past any collision that matters at this volume, and the secret is what makes the
 * value opaque.
 *
 * @param {string} ip
 * @param {string} secret
 * @returns {string}
 */
export function callerHash(ip, secret) {
  return createHmac('sha256', secret).update(`mcp-audit:${ip}`).digest('hex').slice(0, 32);
}

/**
 * The fixed window a moment falls in, and how much of it is left.
 *
 * Aligned to the epoch rather than to the caller's first request, which is what makes the window
 * derivable from the clock alone: no stored start time, so the key is the only state and its TTL
 * can be exactly the time remaining. The cost of a fixed window is the usual one — a caller can
 * spend two windows' worth across a boundary — and it is the right trade for a limit whose job is
 * to bound a stranger's cost rather than to shape traffic.
 *
 * @param {Date} now
 * @param {number} windowSeconds
 */
export function windowFor(now, windowSeconds) {
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const index = Math.floor(epochSeconds / windowSeconds);
  const secondsRemaining = windowSeconds - (epochSeconds % windowSeconds);
  return { index, secondsRemaining };
}

/** The UTC day and the seconds left in it. UTC, because this is storage — see agent-hits.mjs. */
export function utcDayFor(now) {
  const day = now.toISOString().slice(0, 10);
  const endOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return { day, secondsRemaining: Math.ceil((endOfDay - now.getTime()) / 1000) };
}

/** `mcp:v1:caller:<hmac>:<window>` — one caller, one window. */
export function callerKeyFor(hash, windowIndex) {
  return keyFor(TIERS.fast.callerPrefix, hash, windowIndex);
}

/** `mcp:v1:global:<utc-day>` — everyone, one UTC day. */
export function globalKeyFor(day) {
  return keyFor(TIERS.fast.globalPrefix, day);
}

/**
 * `mcp:v1:deep:caller:<hmac>:<utc-day>` — one caller, one UTC day, deep tier.
 *
 * A separate key space rather than a shared counter with a different limit, so
 * the two tiers' arithmetic cannot interfere: a fast audit can never consume a
 * deep slot, and the operator reset documented in the user guide can drop the
 * day's deep counters without touching the fast tier's.
 */
export function deepCallerKeyFor(hash, day) {
  return keyFor(TIERS.deep.callerPrefix, hash, day);
}

/** `mcp:v1:deep:global:<utc-day>` — everyone, one UTC day, deep tier. */
export function deepGlobalKeyFor(day) {
  return keyFor(TIERS.deep.globalPrefix, day);
}

/** `mcp:v1:session:caller:<hmac>:<utc-day>`: one caller, one UTC day, consultant sessions. */
export function sessionCallerKeyFor(hash, day) {
  return keyFor(TIERS.session.callerPrefix, hash, day);
}

/** `mcp:v1:session:global:<utc-day>`: everyone, one UTC day, consultant sessions. */
export function sessionGlobalKeyFor(day) {
  return keyFor(TIERS.session.globalPrefix, day);
}

/** `mcp:v1:read:caller:<hmac>:<window>`: one caller, one window, reads of a run. No global key. */
export function readCallerKeyFor(hash, windowIndex) {
  return keyFor(TIERS.read.callerPrefix, hash, windowIndex);
}

/**
 * One counter's worth of Redis: increment it, then set its TTL to the time left in its window.
 *
 * `EXPIRE` unconditionally rather than `EXPIRE … NX`, and that is safe precisely because the window
 * is in the key name: the TTL being written is always the remaining life of *this* window, so
 * rewriting it every request is idempotent rather than a sliding expiry that never fires.
 *
 * @param {string} key
 * @param {number} ttlSeconds
 * @returns {string[][]}
 */
export function counterCommands(key, ttlSeconds) {
  return [
    ['INCR', key],
    ['EXPIRE', key, String(ttlSeconds)],
  ];
}

/**
 * Runs one Upstash pipeline and returns the `INCR` result.
 *
 * Throws on anything that is not a clean answer, so every failure lands in the single catch in
 * `checkRateLimit` and becomes a refusal. There is no branch here that returns a count it did not
 * read.
 */
async function increment(store, fetchImpl, key, ttlSeconds, timeoutMs) {
  const response = await fetchImpl(`${store.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${store.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(counterCommands(key, ttlSeconds)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`store returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body) || body.length === 0) throw new Error('store returned an unexpected body');
  const [incr] = body;
  if (incr?.error) throw new Error(`store refused INCR: ${incr.error}`);
  const used = Number(incr?.result);
  if (!Number.isInteger(used) || used < 1) throw new Error('store returned no count');
  return used;
}

/**
 * Decides whether one audit, session or read may go ahead, and counts it if it may.
 *
 * Counted before the audit rather than after, so a caller cannot hold ten slow audits open at once
 * by never letting any of them finish.
 *
 * `tier` picks a row of the `TIERS` table, and with it which pair of counters is
 * touched. Nothing else about the function changes: the secret, the store, the
 * caller-before-global ordering and the single place a failure is answered
 * are the same for every tier. The table says which tiers have a global
 * budget and what a tier does when it cannot count.
 *
 * @param {{
 *   ip: string | null,
 *   tier?: 'fast' | 'deep' | 'session' | 'read',
 *   env?: Record<string, string | undefined>,
 *   now?: Date,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<{ allowed: true, tier: string,
 *                     caller?: { used: number, limit: number },
 *                     global?: { used: number, limit: number },
 *                     counted?: false, scope?: string, reason?: string }
 *                 | { allowed: false, tier: string, scope: string, reason: string,
 *                     retryAfterSeconds: number, used?: number, limit?: number }>}
 *   An allowed verdict of the read tier has no `global`. When the read could not be counted it
 *   has no `caller` either, and carries `counted: false` with the `scope` and `reason` a refusal
 *   would have had.
 */
export async function checkRateLimit({
  ip,
  tier = 'fast',
  env = process.env,
  now = new Date(),
  fetchImpl = fetch,
}) {
  // A name the table does not hold is counted as a fast audit, as it always has been.
  const spec = Object.hasOwn(TIERS, tier) ? TIERS[tier] : TIERS.fast;
  const limits = limitsFor(spec, env);
  const secret = env.MCP_AUDIT_RATE_SECRET;

  // What a check that cannot count answers. For three tiers it is a refusal that says whose fault
  // it was, because an operator reading a 429 in the logs needs to know it was not a caller
  // misbehaving. For the read tier it is an allowed read that says it was not counted.
  const uncounted = (scope, reason) =>
    spec.onFailure === 'allow'
      ? { allowed: true, tier, counted: false, scope, reason }
      : { allowed: false, tier, scope, reason, retryAfterSeconds: INFRASTRUCTURE_RETRY_SECONDS };

  if (!secret) {
    return uncounted('config', 'the endpoint has no rate-limit secret configured, so it cannot tell callers apart');
  }
  const store = readStoreConfig(env);
  if (!store) return uncounted('store', 'the endpoint has no rate-limit store configured');
  if (!ip) return uncounted('caller-unknown', 'the request carried no client address, so it cannot be rate limited');

  const day = utcDayFor(now);
  const hash = callerHash(ip, secret);
  // The tiers differ in two places, both read from the table: which keys are incremented, and how
  // long the per-caller window is. A daily tier's two counters expire together.
  const daily = spec.window === 'utc-day';
  const window = daily ? day : windowFor(now, limits.windowSeconds);
  const callerKey = keyFor(spec.callerPrefix, hash, daily ? day.day : window.index);
  const unit = spec.unit;
  const per = daily ? 'today' : 'in the current window';

  try {
    // Caller first, and only then global: a caller past their own limit must not spend the day's
    // allowance on the way to being refused.
    const callerUsed = await increment(store, fetchImpl, callerKey, window.secondsRemaining, spec.storeTimeoutMs);
    if (callerUsed > limits.perCaller) {
      return {
        allowed: false,
        tier,
        scope: 'caller',
        reason: spec.callerReason ?? `this caller has used ${limits.perCaller} ${unit} ${per}`,
        retryAfterSeconds: window.secondsRemaining,
        used: callerUsed,
        limit: limits.perCaller,
      };
    }

    // A tier with no global budget is done: one round trip, and nobody else's reads were spent.
    if (spec.globalPrefix === null) {
      return { allowed: true, tier, caller: { used: callerUsed, limit: limits.perCaller } };
    }

    const globalKey = keyFor(spec.globalPrefix, day.day);
    const globalUsed = await increment(store, fetchImpl, globalKey, day.secondsRemaining, spec.storeTimeoutMs);
    if (globalUsed > limits.globalPerDay) {
      return {
        allowed: false,
        tier,
        scope: 'global',
        reason: `this endpoint has run ${limits.globalPerDay} ${unit} today`,
        retryAfterSeconds: day.secondsRemaining,
        used: globalUsed,
        limit: limits.globalPerDay,
      };
    }

    return {
      allowed: true,
      tier,
      caller: { used: callerUsed, limit: limits.perCaller },
      global: { used: globalUsed, limit: limits.globalPerDay },
    };
  } catch (error) {
    // The whole posture of this module, in one branch. An audit that cannot be counted does not
    // run. A read that cannot be counted does, which is the table's one `onFailure: 'allow'`.
    return uncounted(
      'store',
      `the rate-limit store could not be reached: ${error instanceof Error ? error.name : 'error'}`
    );
  }
}
