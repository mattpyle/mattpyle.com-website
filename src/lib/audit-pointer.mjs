/**
 * What the /audit page remembers between a POST and the GET that follows it.
 *
 * The form's POST runs an audit and answers with a 303 to `/audit/?url=<origin>`, so the GET that
 * renders the report is a *different request* — a bookmarkable one, and one a link-preview bot or
 * a crawler can follow. That GET must never visit the target, which means the run has to be
 * findable from the origin alone. This module is that lookup: one key per origin, in the store the
 * rate limiter already uses.
 *
 * **`audit:last:<origin>`, TTL 90 days** (Matt, 2026-09-05). The hour bucket in the activity ID is
 * a deduplication window, not a lifetime: a finished run stays readable for the namespace's
 * retention, and the page shows an old report with its date and a Run again button rather than
 * pretending it does not exist.
 *
 * **The value is an envelope, and it has two shapes, because a run has two ways of finishing.**
 *
 * | Shape | Written when | Read by |
 * |---|---|---|
 * | `{ v: 1, activityId }` | the audit ran as a standalone activity on Temporal | `client.activity.getHandle(id).result()` |
 * | `{ v: 1, report }` | the audit ran inside the function | the envelope itself |
 *
 * The first is the normal path and the reason this is a pointer at all: the result already exists,
 * durably, on the namespace, and storing an ID keeps this store holding labels rather than
 * documents. The second exists because the fallback in src/lib/mcp-fast-standalone.mjs is not a
 * rare event — it is the whole path on any deployment with no Temporal configuration, which
 * includes every preview deploy and every locally served build. Without it, a POST on such a
 * deployment runs a real audit, redirects, finds no pointer, and renders the empty form with the
 * address filled in: the page looks broken in exactly the environment it is tested in. Storing the
 * document there costs a few tens of kilobytes against a key that already exists, and it is the
 * only shape that makes the page work with no Temporal at all.
 *
 * **Every failure is a missing report, never an error page.** A store that is not configured, a
 * timeout, a 500, a value that does not parse: all of them return `null`, and the route renders
 * the form with the address in it and no message. That is the opposite posture to the rate
 * limiter, which fails closed, and the reason is that the two failures cost different things —
 * there, an unbounded stranger; here, one visitor pressing the button again. Nothing about
 * retention or expiry is surfaced either way (Matt, 2026-09-05).
 *
 * A write failure is swallowed for the same reason and one more: the audit has already run and
 * the visitor is already being redirected, so a throw here would turn a successful audit into a
 * 500 over a cache miss.
 */

import { readStoreConfig } from './agent-hits.mjs';

/** 90 days, in seconds. The retention Matt set on 2026-09-05. */
export const POINTER_TTL_SECONDS = 90 * 24 * 60 * 60;

/** One request's worth of budget against the store, matching the limiter's. */
const STORE_TIMEOUT_MS = 1500;

/** `audit:last:<origin>` — one origin, one remembered run. */
export function pointerKeyFor(origin) {
  return `audit:last:${origin}`;
}

/**
 * Runs one Upstash pipeline and returns the results array.
 *
 * The same `/pipeline` endpoint and the same bearer shape the limiter's `increment` uses, kept
 * here rather than shared because that function's contract is "throw on anything that is not a
 * clean count" and this one's callers want a null.
 */
async function pipeline(store, fetchImpl, commands) {
  const response = await fetchImpl(`${store.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`store returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error('store returned an unexpected body');
  return body;
}

/**
 * Remember which run answers for this origin.
 *
 * Never throws and never rejects: the caller is mid-redirect on a successful audit.
 *
 * @param {{ origin: string, activityId?: string, report?: unknown,
 *           env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function writePointer({ origin, activityId, report, env = process.env, fetchImpl = fetch }) {
  const store = readStoreConfig(env);
  if (!store) return { ok: false, reason: 'no-store' };
  const envelope = activityId ? { v: 1, activityId } : { v: 1, report };
  try {
    await pipeline(store, fetchImpl, [
      ['SET', pointerKeyFor(origin), JSON.stringify(envelope), 'EX', String(POINTER_TTL_SECONDS)],
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'error' };
  }
}

/**
 * The envelope remembered for this origin, or `null` for every kind of nothing.
 *
 * "No store", "no key", "the store is down" and "the value is not an envelope this version
 * understands" are one answer on purpose: they are indistinguishable to the visitor, who is shown
 * the form with their address in it either way, and collapsing them here is what stops the route
 * growing a branch per failure that renders the same page.
 *
 * @param {{ origin: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ activityId?: string, report?: unknown } | null>}
 */
export async function readPointer({ origin, env = process.env, fetchImpl = fetch }) {
  const store = readStoreConfig(env);
  if (!store) return null;
  try {
    const [entry] = await pipeline(store, fetchImpl, [['GET', pointerKeyFor(origin)]]);
    const raw = entry?.result;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const envelope = JSON.parse(raw);
    if (!envelope || envelope.v !== 1) return null;
    if (typeof envelope.activityId === 'string') return { activityId: envelope.activityId };
    if (envelope.report) return { report: envelope.report };
    return null;
  } catch {
    return null;
  }
}
