/**
 * Everything /activity renders, derived once from the store's hour buckets.
 *
 * src/lib/agent-traffic.mjs owns the read and the rolling-window maths that the Agent traffic
 * block on /scorecard used. This module is the layer the redesigned page needed on top of it: the
 * 24-hour series, the newest hour's rows, and the client classification the marker column reads
 * (docs/projects/redesign/design-export-remaining/design_handoff_activity).
 *
 * ONE DERIVATION PER SURFACE, TWO RENDERS. `src/pages/activity.astro` and
 * `src/pages/activity.json.ts` both call `buildActivity()` and neither computes anything of its
 * own, so the page and the endpoint cannot report different numbers for the same instant.
 *
 * THE HOUR IS THE FLOOR OF THE RESOLUTION, EVERYWHERE. The store keeps counts per UTC hour bucket
 * and never individual requests, so nothing here returns a minute, a relative time or a per-request
 * row. `lastHour.rows` is one row per client-and-path pair inside the newest bucket, and its counts
 * sum to `hours.at(-1).count` by construction — the chart's newest bar and the band beneath it are
 * the same bucket read twice, which is what the spec asks for.
 *
 * Pure and dependency-light, so tests/activity-summary.test.mjs asserts it against fabricated
 * buckets with no store and no deploy. Same split as agent-traffic.mjs itself.
 */

import { epochHour, hourStart, summarizeTraffic } from './agent-traffic.mjs';

/** How many hour buckets the chart shows. One day, ending with the hour in progress. */
export const CHART_HOURS = 24;

/**
 * The tallest bar, as a percentage of the chart band.
 *
 * The remaining 18% is the count label that sits above each bar. The geometry is the label's — if
 * the labels ever go, this goes back to 100 (the bundle says so explicitly).
 */
export const BAR_CEILING_PERCENT = 82;

/** The shortest bar a non-zero hour draws, so a single request is still visible. */
const BAR_FLOOR_PERCENT = 4;

/**
 * The client families that are a named machine agent, and take the marker.
 *
 * Derived from CLIENT_FAMILIES in src/lib/agent-hits.mjs rather than re-listed: the named crawlers
 * at the head of that list are exactly the agents, and the tail of it is the script tells. Naming
 * them twice would mean a new crawler quietly rendering as `unknown` here.
 */
const TOOL_FAMILIES = new Set(['curl', 'wget', 'python', 'node', 'go']);
const BROWSER_FAMILIES = new Set(['browser']);

/**
 * Families that are neither a named agent nor a tool nor a browser.
 *
 * `other-bot` sits here rather than under `agent`, and that is a judgement the design made: the
 * marker means "a named bot or agent", and a client that says it is a robot without saying which
 * one has not told us who it is. The mockup marks the twenty named crawlers and leaves this row
 * blank, which is what the four-way classification has to reproduce.
 */
const UNKNOWN_FAMILIES = new Set(['other', 'none', 'other-bot']);

/**
 * A stored client family as one of the four kinds the page distinguishes.
 *
 * @param {string} family
 * @returns {'agent' | 'browser' | 'tool' | 'unknown'}
 */
export function clientKind(family) {
  if (BROWSER_FAMILIES.has(family)) return 'browser';
  if (TOOL_FAMILIES.has(family)) return 'tool';
  if (UNKNOWN_FAMILIES.has(family)) return 'unknown';
  return 'agent';
}

/**
 * Two families are not crawler names and read as jargon without a gloss. The wording is the one
 * /scorecard's traffic block shipped, carried over with the block.
 */
export const FAMILY_NOTES = Object.freeze({
  none: 'sent no user agent',
  other: 'unrecognised',
  'other-bot': 'says it is a bot, unnamed here',
});

/** Two-digit UTC hour, the form the chart's ticks are written in. @param {number} hour */
function hourLabel(hour) {
  return String(hour).padStart(2, '0');
}

/**
 * The last 24 hour buckets, oldest first, with the bar geometry each one draws.
 *
 * A bucket with nothing in it draws NO bar rather than the floor: a stub of colour on an hour that
 * saw no requests is a picture of a number that is not there. Every other hour gets at least the
 * floor so one request is not rounded into invisibility.
 *
 * @param {Array<{ hour: number | null, count: number }>} rows
 * @param {Date} now
 */
export function hourlySeries(rows, now) {
  const nowHour = epochHour(now);
  const oldest = nowHour - (CHART_HOURS - 1);

  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const row of rows) {
    if (row.hour === null || row.hour < oldest || row.hour > nowHour) continue;
    counts.set(row.hour, (counts.get(row.hour) ?? 0) + row.count);
  }

  const peak = Math.max(0, ...counts.values());

  const series = [];
  for (let hour = oldest; hour <= nowHour; hour += 1) {
    const count = counts.get(hour) ?? 0;
    const utcHour = hourStart(hour).getUTCHours();
    series.push({
      /** Hours since the epoch — the bucket identity, so a consumer can join on it. */
      bucket: hour,
      /** The hour of the UTC day, 0–23. */
      utcHour,
      count,
      /** Percentage of the chart band this bar fills. */
      percent:
        count === 0 || peak === 0
          ? 0
          : Math.max(BAR_FLOOR_PERCENT, Math.round((count / peak) * BAR_CEILING_PERCENT)),
      /** Ticks are printed every six hours, and the blank slots keep the row's 24 columns. */
      tick: utcHour % 6 === 0 ? hourLabel(utcHour) : '',
    });
  }
  return series;
}

/**
 * The newest hour bucket, as one row per client-and-path pair.
 *
 * Returns the bucket's own total beside the rows so a caller can assert what the spec requires —
 * that these rows sum to the chart's last bar — without re-adding them.
 *
 * @param {Array<{ hour: number | null, event: string, family: string, path: string, count: number }>} rows
 * @param {Date} now
 */
export function lastHourRows(rows, now) {
  const nowHour = epochHour(now);

  /** @type {Map<string, { family: string, path: string, kind: string, count: number }>} */
  const pairs = new Map();
  let total = 0;
  for (const row of rows) {
    if (row.hour !== nowHour) continue;
    total += row.count;
    const key = `${row.family}\u0000${row.path}`;
    const found = pairs.get(key);
    if (found) found.count += row.count;
    else pairs.set(key, { family: row.family, path: row.path, kind: clientKind(row.family), count: row.count });
  }

  const sorted = [...pairs.values()].sort(
    (a, b) =>
      b.count - a.count || a.family.localeCompare(b.family) || a.path.localeCompare(b.path)
  );
  return { rows: sorted, total };
}

/** Hour resolution is all the store keeps, and UTC is how it keeps it. @param {Date} at */
export function utcStamp(at) {
  return `${at.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/**
 * Everything both /activity surfaces render, from one read at one instant.
 *
 * `counted` false means the store answered and has nothing in it yet; the caller distinguishes
 * that from a store that did not answer, which is `readAgentTraffic()`'s business rather than
 * this module's.
 *
 * @param {Array<{ hour: number | null, event: string, family: string, path: string, count: number }>} rows
 * @param {Date} now
 */
export function buildActivity(rows, now = new Date()) {
  const summary = summarizeTraffic(rows, now);
  const hours = hourlySeries(rows, now);
  const lastHour = lastHourRows(rows, now);

  return {
    renderedAt: now,
    counted: summary.counted,
    totals: summary.totals,
    hours,
    lastHour,
    surfaces: summary.surfaces,
    clients: {
      rows: summary.clients.rows.map((row) => ({ ...row, kind: clientKind(row.family ?? '') })),
      omitted: summary.clients.omitted,
    },
    pages: summary.pages,
    /**
     * Which of this site's pages named bots have read, from the `page` event class.
     *
     * Separate from `pages`, which is the markdown-negotiation table: one is "an agent asked for
     * this page as markdown", the other is "a crawler fetched the ordinary HTML". Merging them
     * would collapse the distinction the class was added to draw.
     */
    botPages: summary.botPages,
    /** The newest bucket anything landed in, or null when nothing has. */
    lastCountedHour: summary.lastHour,
  };
}
