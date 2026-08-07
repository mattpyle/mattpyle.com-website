import type { APIRoute } from 'astro';
import { SCORECARD, SCORECARD_HISTORY } from '../data/scorecard';
import { flattenTraffic, readAgentTraffic, summarizeTraffic } from '../lib/agent-traffic.mjs';

/**
 * The Markdown representation of /scorecard.
 *
 * Every other non-entry page's `.md` sibling is converted from its rendered HTML after the build
 * (scripts/emit-markdown-siblings.mjs). /scorecard cannot be: it renders on demand now, so there
 * is no built HTML file to convert. This route replaces that conversion, and joins
 * writing/[slug].md.ts and changelog/[slug].md.ts as a curated sibling —
 * src/lib/markdown-negotiation.mjs lists it, and scripts/validate-markdown-siblings.mjs fails the
 * build if this file disappears.
 *
 * Curated turns out to be the better artifact anyway. The converter flattened the scores into a
 * run of headings and orphan numbers ("### SEO / Pass / 100 /100"); this emits real Markdown
 * tables, which is what a model reading the page actually wants.
 *
 * The traffic numbers are included rather than summarised. This site's whole premise is that an
 * agent should get the same content a person does, and a page whose subject is agent traffic
 * withholding it from agents would be a joke at its own expense. Same store read, same rolling
 * windows, same cache window as the HTML.
 */
export const prerender = false;

const CANONICAL = 'https://www.mattpyle.com/scorecard/';

/** Pipes inside a cell would end it early. Nothing here should contain one; belt and braces. */
function cell(value: string | number): string {
  return String(value).replace(/\|/g, '\\|');
}

function table(headers: string[], rows: (string | number)[][]): string {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Hour resolution is all the store keeps, and UTC is how it keeps it. */
function utcStamp(at: Date): string {
  return at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export const GET: APIRoute = async ({ request }) => {
  console.log(`[scorecard.md] accept="${request.headers.get('accept') ?? ''}"`);

  const renderedAt = new Date();
  const traffic = await readAgentTraffic({ now: renderedAt });
  const summary = traffic.ok ? summarizeTraffic(flattenTraffic(traffic), renderedAt) : null;
  const passes = SCORECARD.metrics.filter((metric) => metric.status === 'Pass').length;

  const sections: string[] = [
    [
      '---',
      // Matches the HTML page's <title> (src/pages/scorecard.astro) so the two
      // representations of this route describe themselves the same way.
      'title: "Scorecard: accessibility, performance, and SEO — Matt Pyle"',
      `description: ${JSON.stringify(SCORECARD.description)}`,
      `canonical: ${CANONICAL}`,
      `source: ${CANONICAL}`,
      `rendered: ${renderedAt.toISOString()}`,
      '---',
    ].join('\n'),

    '# Scorecard',
    'The latest verified scores, followed by the site\'s live agent traffic and every live-network run we have recorded.',

    '## Latest run',
    `Verified ${SCORECARD.verified.label}. **${passes} of ${SCORECARD.metrics.length}** gates passing.`,
    table(
      ['Metric', 'Score', 'Status', 'What it measures'],
      SCORECARD.metrics.map((metric) => [
        metric.name,
        `${metric.value}/${metric.maximum}`,
        metric.status,
        metric.description,
      ])
    ),
    table(
      ['Scope', 'Tools', 'Entry'],
      [[SCORECARD.scope, SCORECARD.tools.join(' · '), SCORECARD.entry]]
    ),
  ];

  if (SCORECARD.commentary?.trim()) sections.push(SCORECARD.commentary.trim());

  sections.push(
    '## Agent traffic',
    'Requests to this site\'s discovery documents, and pages served as Markdown to clients that ' +
      'asked for it. Aggregate counts only. Every window is a rolling one ending at the render ' +
      `time below, so none of them is a calendar period in anyone's timezone.`,
    `Read from the store at ${utcStamp(renderedAt)}.`
  );

  if (summary && summary.counted) {
    sections.push(
      table(
        ['Window', 'Requests'],
        [
          ['Total', summary.totals.total],
          ['Last 7 days', summary.totals.week],
          ['Last 24 hours', summary.totals.day],
        ]
      ),
      '### By surface',
      table(
        ['Surface', '7 days', '30 days', 'Total'],
        summary.surfaces.rows.map((row) => [row.path ?? '', row.week, row.month, row.total])
      ),
      '### By client type',
      table(
        ['Client', '7 days', '30 days', 'Total'],
        summary.clients.rows.map((row) => [row.family ?? '', row.week, row.month, row.total])
      )
    );

    sections.push('### Markdown negotiation');
    sections.push(
      summary.pages.rows.length > 0
        ? table(
            ['Page', '7 days', '30 days', 'Total'],
            summary.pages.rows.map((row) => [row.path ?? '', row.week, row.month, row.total])
          )
        : 'No page has been served as Markdown yet.'
    );
  } else if (traffic.ok) {
    sections.push('Nothing has been counted yet.');
  } else {
    sections.push('Live counts were unavailable for this render. The scores above are unaffected.');
  }

  sections.push(
    '## Run history',
    'Newest first.',
    table(
      ['Run', ...SCORECARD.metrics.map((metric) => metric.name), 'Result', 'Notes'],
      SCORECARD_HISTORY.map((run) => [
        run.verified.label,
        ...run.metrics.map((metric) => `${metric.value}/${metric.maximum}`),
        `${run.metrics.filter((metric) => metric.status === 'Pass').length}/${run.metrics.length}`,
        run.commentary,
      ])
    )
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
