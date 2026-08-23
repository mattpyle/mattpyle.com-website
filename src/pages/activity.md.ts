import type { APIRoute } from 'astro';
import { buildActivity, utcStamp } from '../lib/activity-summary.mjs';
import { flattenTraffic, readAgentTraffic } from '../lib/agent-traffic.mjs';
import { markdownSiblingFor } from '../lib/markdown-negotiation.mjs';
import { SITE_ORIGIN } from '../data/site-origin.mjs';

/**
 * The Markdown representation of /activity.
 *
 * Every other non-entry page's `.md` sibling is converted from its rendered HTML after the build
 * (scripts/emit-markdown-siblings.mjs). /activity cannot be: it renders on demand, so there is no
 * built HTML file to convert. This route replaces that conversion and joins writing/[slug].md.ts
 * and changelog/[slug].md.ts as a curated sibling — src/lib/markdown-negotiation.mjs lists it, and
 * scripts/validate-markdown-siblings.mjs fails the build if this file disappears.
 *
 * IT REPLACES src/pages/scorecard.md.ts, WHICH IS DELETED. That route existed for exactly the same
 * reason and stopped being needed the moment /scorecard went back to prerendering: the converter
 * has a built HTML file to work from again, so /scorecard.md is now an ordinary converted sibling.
 * The curated exception moved with the store read, not with the page.
 *
 * Curated is the better artifact here anyway. The converter would flatten the bar chart into a run
 * of orphan numbers; this emits real Markdown tables, which is what a model reading the page
 * actually wants.
 *
 * The numbers are included in full rather than summarised. This site's premise is that an agent
 * gets the same content a person does, and a page whose subject is agent traffic withholding it
 * from agents would be a joke at its own expense. Same store read, same rolling windows, same
 * cache window as the HTML.
 */
export const prerender = false;

const CANONICAL = `${SITE_ORIGIN}/activity/`;

/**
 * Pipes inside a cell would end it early. Nothing here should contain one; belt and braces.
 *
 * Backslashes are escaped first, and that order is the whole point: escaping only pipes leaves a
 * value ending in a backslash able to consume the backslash of the pipe escape that follows it
 * ("a\" + "\|" reads as an escaped backslash and then a live pipe), which breaks the row it was
 * meant to protect.
 */
function cell(value: string | number): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function table(headers: string[], rows: (string | number)[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

export const GET: APIRoute = async () => {
  const renderedAt = new Date();
  const traffic = await readAgentTraffic({ now: renderedAt });
  const activity = traffic.ok ? buildActivity(flattenTraffic(traffic), renderedAt) : null;

  const sections: string[] = [
    [
      '---',
      // Matches the HTML page's <title> (src/pages/activity.astro) so the two representations of
      // this route describe themselves the same way.
      'title: "Activity: agent traffic to mattpyle.com"',
      'description: "Requests to this site\'s agent surfaces and pages served as Markdown: the last 24 hours hour by hour, by surface, by client, and by page."',
      `canonical: ${CANONICAL}`,
      `source: ${CANONICAL}`,
      `rendered: ${renderedAt.toISOString()}`,
      'resolution: utc-hour',
      '---',
    ].join('\n'),

    '# Activity',
    "Fetches of this site's agent surfaces, and pages served as Markdown to clients that asked for them. Page views are not counted, and the nightly scorecard audit does not appear in these numbers.",
    `Read from the store at ${utcStamp(renderedAt)}. Every count is a UTC hour bucket or a rolling window over hour buckets; there are no per-request records and no sub-hour timestamps. The same figures as JSON: ${SITE_ORIGIN}/activity.json`,
  ];

  if (activity && activity.counted) {
    sections.push(
      '## Headline counts',
      table(
        ['Window', 'Requests'],
        [
          ['Last 24 hours', activity.totals.day],
          ['Last 7 days', activity.totals.week],
          ['Last 30 days', activity.totals.month],
          ['Recorded', activity.totals.total],
        ]
      ),

      '## The last day, hour by hour',
      table(
        ['Hour (UTC)', 'Requests'],
        activity.hours.map(hour => [`${String(hour.utcHour).padStart(2, '0')}:00`, hour.count])
      ),

      '## The last hour',
      `The newest hour bucket, which is the last row of the table above. Rows sum to ${activity.lastHour.total}.`
    );

    sections.push(
      activity.lastHour.rows.length > 0
        ? table(
            ['Client', 'Kind', 'Asked for', 'Requests'],
            activity.lastHour.rows.map(row => [row.family, row.kind, row.path, row.count])
          )
        : 'Nothing has been counted in the hour so far.'
    );

    sections.push(
      '## By surface',
      table(
        ['Surface', '7 days', '30 days', 'Recorded'],
        activity.surfaces.rows.map(row => [row.path ?? '', row.week, row.month, row.total])
      ),
      '## By client',
      table(
        ['Client', 'Kind', '7 days', '30 days', 'Recorded'],
        activity.clients.rows.map(row => [
          row.family ?? '',
          row.kind,
          row.week,
          row.month,
          row.total,
        ])
      ),
      '## Markdown negotiation'
    );

    sections.push(
      activity.pages.rows.length > 0
        ? table(
            ['Page', '7 days', '30 days', 'Recorded'],
            activity.pages.rows.map(row => [
              markdownSiblingFor(row.path ?? '') ?? row.path ?? '',
              row.week,
              row.month,
              row.total,
            ])
          )
        : 'No page has been served as Markdown yet.'
    );
  } else if (traffic.ok) {
    sections.push('Nothing has been counted yet.');
  } else {
    sections.push('Live counts were unavailable for this render.');
  }

  sections.push(
    '## How this is counted',
    "Two things are counted at the edge: a fetch of one of this site's agent surfaces, and a page served as Markdown to a client that asked for it. Ordinary page views are not. What is kept is a count per UTC hour — no cookies, no script in your browser, nothing that identifies you."
  );

  return new Response(`${sections.join('\n\n')}\n`, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Link: `<${CANONICAL}>; rel="canonical"`,
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400',
      Vary: 'Accept',
    },
  });
};
