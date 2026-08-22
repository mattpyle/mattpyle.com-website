import type { APIRoute } from 'astro';
import { buildActivity } from '../lib/activity-summary.mjs';
import { flattenTraffic, hourStart, readAgentTraffic } from '../lib/agent-traffic.mjs';
import { markdownSiblingFor } from '../lib/markdown-negotiation.mjs';
import { SITE_ORIGIN } from '../data/site-origin.mjs';

/**
 * /activity.json — the same numbers /activity displays, as data.
 *
 * The other half of the "The same numbers, as data" block both redesign bundles end on, confirmed
 * with Matt 2026-08-22. /scorecard.json prerenders from committed JSON; this one renders per
 * request, from the same store read and through the same `buildActivity()` the page calls. One
 * derivation per surface, two renders: the page and this endpoint cannot report different numbers
 * for the same instant.
 *
 * EVERY FIGURE IS AN HOUR BUCKET OR A ROLLING WINDOW OVER HOUR BUCKETS, and the payload says so in
 * `resolution`. There are no per-request records to serve and no sub-hour timestamps, so a
 * consumer that wants a feed of individual requests will not find one here — the store does not
 * hold one. `lastHour.rows` sum to `lastHour.total`, which is the last entry of `hours`.
 *
 * Fails soft the same way the page does: a store that does not answer is `counted: false` with a
 * `reason`, never a 500.
 */
export const prerender = false;

const CANONICAL = `${SITE_ORIGIN}/activity/`;

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  Link: `<${CANONICAL}>; rel="canonical"`,
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400',
  'Access-Control-Allow-Origin': '*',
};

export const GET: APIRoute = async () => {
  const renderedAt = new Date();
  const traffic = await readAgentTraffic({ now: renderedAt });

  if (!traffic.ok) {
    return new Response(
      `${JSON.stringify(
        {
          source: CANONICAL,
          renderedAt: renderedAt.toISOString(),
          resolution: 'utc-hour',
          counted: false,
          reason: traffic.reason,
        },
        null,
        2
      )}\n`,
      { headers: HEADERS }
    );
  }

  const activity = buildActivity(flattenTraffic(traffic), renderedAt);

  const body = {
    source: CANONICAL,
    renderedAt: renderedAt.toISOString(),
    /** What one row of this payload is a count of. The store keeps nothing finer. */
    resolution: 'utc-hour',
    /**
     * What is counted, in the payload rather than only in the page's prose: a reader of the JSON
     * gets the same scope statement a reader of the page does.
     */
    counts: 'Fetches of this site\'s agent surfaces, and pages served as Markdown to clients that asked for them. Page views are not counted.',
    counted: activity.counted,
    /** Rolling windows ending at `renderedAt`, so none of them is a calendar period in any zone. */
    totals: {
      last24Hours: activity.totals.day,
      last7Days: activity.totals.week,
      last30Days: activity.totals.month,
      recorded: activity.totals.total,
    },
    hours: activity.hours.map(hour => ({
      startedAt: hourStart(hour.bucket).toISOString(),
      utcHour: hour.utcHour,
      count: hour.count,
    })),
    lastHour: {
      startedAt: hourStart(activity.hours[activity.hours.length - 1].bucket).toISOString(),
      total: activity.lastHour.total,
      rows: activity.lastHour.rows.map(row => ({
        client: row.family,
        kind: row.kind,
        path: row.path,
        count: row.count,
      })),
    },
    surfaces: {
      rows: activity.surfaces.rows.map(row => ({
        path: row.path,
        last7Days: row.week,
        last30Days: row.month,
        recorded: row.total,
      })),
      omitted: activity.surfaces.omitted,
    },
    clients: {
      rows: activity.clients.rows.map(row => ({
        client: row.family,
        kind: row.kind,
        last7Days: row.week,
        last30Days: row.month,
        recorded: row.total,
      })),
      omitted: activity.clients.omitted,
    },
    markdown: {
      // The store counts the page path a client asked for; this reports the sibling URL that
      // answered, exactly as the table does, derived through the same function the middleware uses.
      rows: activity.pages.rows.map(row => ({
        page: row.path,
        markdown: markdownSiblingFor(row.path ?? '') ?? row.path,
        last7Days: row.week,
        last30Days: row.month,
        recorded: row.total,
      })),
      omitted: activity.pages.omitted,
    },
  };

  return new Response(`${JSON.stringify(body, null, 2)}\n`, { headers: HEADERS });
};
