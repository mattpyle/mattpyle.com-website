import type { APIRoute } from 'astro';
import {
  MCP_CLIENTS_LEGEND,
  MCP_COUNTS_NOTE,
  MCP_METHODS_LEGEND,
  SIGNERS_LEGEND,
  buildActivity,
} from '../lib/activity-summary.mjs';
import { flattenMcpHashes, flattenSignerHashes, flattenTraffic, hourStart, readAgentTraffic } from '../lib/agent-traffic.mjs';
import {
  MAX_MCP_CLIENTS_PER_DAY,
  MAX_MCP_VERSIONS_PER_DAY,
  MAX_SIGNER_HOSTS_PER_DAY,
  OTHER_MCP_CLIENT,
  OTHER_MCP_METHOD,
  OTHER_MCP_VERSION,
  OTHER_SIGNER_HOST,
  UNNAMED_MCP_CLIENT,
  UNSTATED_MCP_VERSION,
} from '../lib/agent-hits.mjs';
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

  const activity = buildActivity(flattenTraffic(traffic), renderedAt, {
    signers: flattenSignerHashes(traffic.signerHashes),
    mcp: flattenMcpHashes(traffic.mcpHashes),
  });

  const body = {
    source: CANONICAL,
    renderedAt: renderedAt.toISOString(),
    /** What one row of this payload is a count of. The store keeps nothing finer. */
    resolution: 'utc-hour',
    /**
     * What is counted, in the payload rather than only in the page's prose: a reader of the JSON
     * gets the same scope statement a reader of the page does.
     */
    counts: 'Fetches of this site\'s agent surfaces, pages served as Markdown to clients that asked for them, and pages fetched by a bot this site can name by its user agent. Page views by a browser, and by any client this site cannot name, are not counted. A request whose Web Bot Auth signature verified under a signer this site does not name is also counted by the hostname of the key directory that verified it, and by nothing else. ' + MCP_COUNTS_NOTE,
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
    /**
     * What the site could prove about who sent each counted request, per Web Bot Auth: `signed`
     * (a signature verified against the operator's published key), `ip-verified` (an address in
     * the operator's published ranges) or `claimed` (the user agent alone). A request in none of
     * the three is not in this list.
     */
    verification: activity.verification.map(row => ({
      state: row.state,
      last24Hours: row.day,
      last7Days: row.week,
      last30Days: row.month,
      recorded: row.total,
    })),
    /**
     * One row per client and verification state. `verification` is null for an ordinary visitor
     * and for a hit counted before checks began on 2026-10-17.
     */
    clients: {
      rows: activity.clients.rows.map(row => ({
        client: row.family,
        kind: row.kind,
        verification: row.verification || null,
        last7Days: row.week,
        last30Days: row.month,
        recorded: row.total,
      })),
      omitted: activity.clients.omitted,
    },
    /**
     * Verified signatures from signers this site does not name, by the hostname of the key
     * directory that verified them. A host is an operator's domain, stored alone. A day names at
     * most `namedHostsPerDay` hosts; the rest are counted under `otherHost`. A host that proves to
     * be an operator is added to the site's known signers by hand and then appears in `clients`
     * under its family instead of here.
     */
    signers: {
      proves: SIGNERS_LEGEND,
      namedHostsPerDay: MAX_SIGNER_HOSTS_PER_DAY,
      otherHost: OTHER_SIGNER_HOST,
      rows: activity.signers.rows.map(row => ({
        host: row.host,
        last7Days: row.week,
        last30Days: row.month,
      })),
      omitted: activity.signers.omitted,
    },
    /**
     * The MCP census: what clients send the /mcp endpoint. `methods` has a row for every counted
     * method, zeros included, so a method nobody has sent reads as zero and not as absent.
     * `clients` has a row for every client name and protocol revision an initialize request gave.
     * A day names at most `namedClientsPerDay` names and `namedVersionsPerDay` revisions; the
     * rest are counted under `otherClient` and `otherVersion`. `unnamed` and `unstated` are
     * requests that gave none.
     */
    mcp: {
      methods: {
        proves: MCP_METHODS_LEGEND,
        otherMethod: OTHER_MCP_METHOD,
        rows: activity.mcp.methods.rows.map(row => ({
          method: row.method,
          last24Hours: row.day,
          last7Days: row.week,
          last30Days: row.month,
        })),
      },
      clients: {
        proves: MCP_CLIENTS_LEGEND,
        namedClientsPerDay: MAX_MCP_CLIENTS_PER_DAY,
        namedVersionsPerDay: MAX_MCP_VERSIONS_PER_DAY,
        otherClient: OTHER_MCP_CLIENT,
        otherVersion: OTHER_MCP_VERSION,
        unnamed: UNNAMED_MCP_CLIENT,
        unstated: UNSTATED_MCP_VERSION,
        rows: activity.mcp.clients.rows.map(row => ({
          client: row.name,
          protocolVersion: row.protocolVersion,
          last7Days: row.week,
          last30Days: row.month,
        })),
        omitted: activity.mcp.clients.omitted,
      },
    },
    /**
     * The `page` event class: which of this site's pages named bots read as ordinary HTML.
     *
     * Separate from `markdown` below, which is the same site's pages served to a client that
     * negotiated for them. One is a crawler reading the page; the other is an agent asking for a
     * different representation of it.
     */
    botPages: {
      rows: activity.botPages.rows.map(row => ({
        page: row.path,
        last7Days: row.week,
        last30Days: row.month,
        recorded: row.total,
      })),
      omitted: activity.botPages.omitted,
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
