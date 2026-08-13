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
 * Two limits, both fixed-window, both env-configurable:
 *
 * | Limit | Default | Window | Key |
 * |---|---|---|---|
 * | Per caller | 10 audits | rolling hour, aligned to the epoch | `mcp:v1:caller:<hmac>:<window>` |
 * | Global | 500 audits | UTC day | `mcp:v1:global:<utc-day>` |
 *
 * The environment it reads, all of it optional except the first:
 *
 * | Variable | Effect |
 * |---|---|
 * | `MCP_AUDIT_RATE_SECRET` | The HMAC key. **Required** — absent, every audit is refused. |
 * | `MCP_AUDIT_RATE_PER_CALLER` | Audits one caller may run per window. Default 10. |
 * | `MCP_AUDIT_RATE_WINDOW_SECONDS` | The per-caller window. Default 3600. |
 * | `MCP_AUDIT_RATE_GLOBAL_PER_DAY` | Audits the endpoint runs per UTC day. Default 500. |
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
 * The client's address, from the headers the platform sets.
 *
 * `x-forwarded-for` is a list and the **first** entry is the client; the rest are proxies. Reading
 * the last entry, which is the other common spelling, would key every caller behind Vercel's own
 * edge to the same bucket. A caller can forge the header, but not what Vercel prepends to it, so
 * the first entry is attacker-controlled — that is a reason to treat this as a coarse limit rather
 * than an identity, not a reason to key on something worse.
 *
 * Returns null when nothing usable is present, which is a refusal upstream rather than a free pass:
 * "the platform sent no address" must not be the cheapest way to get an unlimited audit.
 *
 * @param {Headers} headers
 * @returns {string | null}
 */
export function clientIpFrom(headers) {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip')?.trim();
  return real || null;
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
 * @param {{
 *   ip: string | null,
 *   env?: Record<string, string | undefined>,
 *   now?: Date,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<{ allowed: true, caller: { used: number, limit: number },
 *                     global: { used: number, limit: number } }
 *                 | { allowed: false, scope: string, reason: string, retryAfterSeconds: number,
 *                     used?: number, limit?: number }>}
 */
export async function checkRateLimit({ ip, env = process.env, now = new Date(), fetchImpl = fetch }) {
  const limits = readLimits(env);
  const secret = env.MCP_AUDIT_RATE_SECRET;

  // The three refusals that are the endpoint's own fault. Each says which, because an operator
  // reading a 429 in the logs needs to know it was not a caller misbehaving.
  if (!secret) {
    return {
      allowed: false,
      scope: 'config',
      reason: 'the endpoint has no rate-limit secret configured, so it cannot tell callers apart',
      retryAfterSeconds: INFRASTRUCTURE_RETRY_SECONDS,
    };
  }
  const store = readStoreConfig(env);
  if (!store) {
    return {
      allowed: false,
      scope: 'store',
      reason: 'the endpoint has no rate-limit store configured',
      retryAfterSeconds: INFRASTRUCTURE_RETRY_SECONDS,
    };
  }
  if (!ip) {
    return {
      allowed: false,
      scope: 'caller-unknown',
      reason: 'the request carried no client address, so it cannot be rate limited',
      retryAfterSeconds: INFRASTRUCTURE_RETRY_SECONDS,
    };
  }

  const window = windowFor(now, limits.windowSeconds);
  const day = utcDayFor(now);

  try {
    // Caller first, and only then global: a caller past their own limit must not spend the day's
    // allowance on the way to being refused.
    const callerUsed = await increment(
      store,
      fetchImpl,
      callerKeyFor(callerHash(ip, secret), window.index),
      window.secondsRemaining,
    );
    if (callerUsed > limits.perCaller) {
      return {
        allowed: false,
        scope: 'caller',
        reason: `this caller has used ${limits.perCaller} audits in the current window`,
        retryAfterSeconds: window.secondsRemaining,
        used: callerUsed,
        limit: limits.perCaller,
      };
    }

    const globalUsed = await increment(store, fetchImpl, globalKeyFor(day.day), day.secondsRemaining);
    if (globalUsed > limits.globalPerDay) {
      return {
        allowed: false,
        scope: 'global',
        reason: `this endpoint has run ${limits.globalPerDay} audits today`,
        retryAfterSeconds: day.secondsRemaining,
        used: globalUsed,
        limit: limits.globalPerDay,
      };
    }

    return {
      allowed: true,
      caller: { used: callerUsed, limit: limits.perCaller },
      global: { used: globalUsed, limit: limits.globalPerDay },
    };
  } catch (error) {
    // The whole posture of this module, in one branch. An audit that cannot be counted does not run.
    return {
      allowed: false,
      scope: 'store',
      reason: `the rate-limit store could not be reached: ${error instanceof Error ? error.name : 'error'}`,
      retryAfterSeconds: INFRASTRUCTURE_RETRY_SECONDS,
    };
  }
}
