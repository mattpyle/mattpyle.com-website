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
 * Two tiers, two limits each, all fixed-window and all env-configurable:
 *
 * | Tier | Limit | Default | Window | Key |
 * |---|---|---|---|---|
 * | fast | Per caller | 10 audits | rolling hour, aligned to the epoch | `mcp:v1:caller:<hmac>:<window>` |
 * | fast | Global | 500 audits | UTC day | `mcp:v1:global:<utc-day>` |
 * | deep | Per caller | 2 audits | UTC day | `mcp:v1:deep:caller:<hmac>:<utc-day>` |
 * | deep | Global | 10 audits | UTC day | `mcp:v1:deep:global:<utc-day>` |
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

/** One request's worth of budget against the store. Past this the audit is refused, not admitted. */
const STORE_TIMEOUT_MS = 1500;

/**
 * How long a refused caller is told to wait when the refusal is the endpoint's own fault rather
 * than theirs. Short, because a config or store problem is fixed by the operator and not by the
 * caller waiting out a window.
 */
const INFRASTRUCTURE_RETRY_SECONDS = 60;

/**
 * The limits, from the environment, with the documented defaults.
 *
 * A malformed value falls back to the default rather than throwing. The alternative is an endpoint
 * that 500s on a typo in a dashboard field, and a limiter that refuses to start is a limiter that
 * gets switched off.
 *
 * @param {Record<string, string | undefined>} env
 */
export function readLimits(env) {
  const positive = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    perCaller: positive(env.MCP_AUDIT_RATE_PER_CALLER, DEFAULT_PER_CALLER),
    windowSeconds: positive(env.MCP_AUDIT_RATE_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS),
    globalPerDay: positive(env.MCP_AUDIT_RATE_GLOBAL_PER_DAY, DEFAULT_GLOBAL_PER_DAY),
  };
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
 */
export function readDeepLimits(env) {
  const positive = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    perCaller: positive(env.MCP_DEEP_RATE_PER_CALLER, DEFAULT_DEEP_PER_CALLER),
    globalPerDay: positive(env.MCP_DEEP_RATE_GLOBAL_PER_DAY, DEFAULT_DEEP_GLOBAL_PER_DAY),
  };
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
  return `mcp:${KEY_VERSION}:caller:${hash}:${windowIndex}`;
}

/** `mcp:v1:global:<utc-day>` — everyone, one UTC day. */
export function globalKeyFor(day) {
  return `mcp:${KEY_VERSION}:global:${day}`;
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
  return `mcp:${KEY_VERSION}:deep:caller:${hash}:${day}`;
}

/** `mcp:v1:deep:global:<utc-day>` — everyone, one UTC day, deep tier. */
export function deepGlobalKeyFor(day) {
  return `mcp:${KEY_VERSION}:deep:global:${day}`;
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
async function increment(store, fetchImpl, key, ttlSeconds) {
  const response = await fetchImpl(`${store.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${store.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(counterCommands(key, ttlSeconds)),
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
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
 * Decides whether one audit may run, and counts it if it may.
 *
 * Counted before the audit rather than after, so a caller cannot hold ten slow audits open at once
 * by never letting any of them finish.
 *
 * `tier` picks which pair of counters is touched, and nothing else about the
 * function changes: the secret, the store, the fail-closed posture and the
 * caller-before-global ordering are the same for both, because the properties
 * they hold are the same for both.
 *
 * @param {{
 *   ip: string | null,
 *   tier?: 'fast' | 'deep',
 *   env?: Record<string, string | undefined>,
 *   now?: Date,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<{ allowed: true, tier: 'fast' | 'deep',
 *                     caller: { used: number, limit: number },
 *                     global: { used: number, limit: number } }
 *                 | { allowed: false, tier: 'fast' | 'deep', scope: string, reason: string,
 *                     retryAfterSeconds: number, used?: number, limit?: number }>}
 */
export async function checkRateLimit({
  ip,
  tier = 'fast',
  env = process.env,
  now = new Date(),
  fetchImpl = fetch,
}) {
  const fast = readLimits(env);
  const deep = readDeepLimits(env);
  const limits = tier === 'deep' ? deep : fast;
  const secret = env.MCP_AUDIT_RATE_SECRET;

  // The three refusals that are the endpoint's own fault. Each says which, because an operator
  // reading a 429 in the logs needs to know it was not a caller misbehaving.
  if (!secret) {
    return {
      allowed: false,
      tier,
      scope: 'config',
      reason: 'the endpoint has no rate-limit secret configured, so it cannot tell callers apart',
      retryAfterSeconds: INFRASTRUCTURE_RETRY_SECONDS,
    };
  }
  const store = readStoreConfig(env);
  if (!store) {
    return {
      allowed: false,
      tier,
      scope: 'store',
      reason: 'the endpoint has no rate-limit store configured',
      retryAfterSeconds: INFRASTRUCTURE_RETRY_SECONDS,
    };
  }
  if (!ip) {
    return {
      allowed: false,
      tier,
      scope: 'caller-unknown',
      reason: 'the request carried no client address, so it cannot be rate limited',
      retryAfterSeconds: INFRASTRUCTURE_RETRY_SECONDS,
    };
  }

  const day = utcDayFor(now);
  const hash = callerHash(ip, secret);
  // The two tiers differ in exactly two places: which keys are incremented, and
  // how long the per-caller window is. The deep tier's per-caller window is the
  // UTC day, so both of its counters expire together.
  const window = tier === 'deep' ? day : windowFor(now, fast.windowSeconds);
  const callerKey =
    tier === 'deep' ? deepCallerKeyFor(hash, day.day) : callerKeyFor(hash, window.index);
  const globalKey = tier === 'deep' ? deepGlobalKeyFor(day.day) : globalKeyFor(day.day);
  const unit = tier === 'deep' ? 'deep audits' : 'audits';
  const per = tier === 'deep' ? 'today' : 'in the current window';

  try {
    // Caller first, and only then global: a caller past their own limit must not spend the day's
    // allowance on the way to being refused.
    const callerUsed = await increment(store, fetchImpl, callerKey, window.secondsRemaining);
    if (callerUsed > limits.perCaller) {
      return {
        allowed: false,
        tier,
        scope: 'caller',
        reason: `this caller has used ${limits.perCaller} ${unit} ${per}`,
        retryAfterSeconds: window.secondsRemaining,
        used: callerUsed,
        limit: limits.perCaller,
      };
    }

    const globalUsed = await increment(store, fetchImpl, globalKey, day.secondsRemaining);
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
    // The whole posture of this module, in one branch. An audit that cannot be counted does not run.
    return {
      allowed: false,
      tier,
      scope: 'store',
      reason: `the rate-limit store could not be reached: ${error instanceof Error ? error.name : 'error'}`,
      retryAfterSeconds: INFRASTRUCTURE_RETRY_SECONDS,
    };
  }
}
