import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { formatLogLine } from '../../lib/agent-surfaces.mjs';
import { showDrafts } from '../../lib/show-drafts';

// On-demand: this is the one route on the site that needs to run per-request
// (see astro.config.mjs). Everything else stays prerendered.
export const prerender = false;

const AUTHOR = 'Matt Pyle';

function yamlString(value: string): string {
  return JSON.stringify(value);
}

// Flow sequence, matching the quoting yamlString already uses. Omitted when empty: the
// schema defaults tags to [], and an empty list tells a reader nothing the absent key
// doesn't. Same rule in changelog/[slug].md.ts.
function yamlList(values: string[]): string {
  return `[${values.map(yamlString).join(', ')}]`;
}

export const GET: APIRoute = async ({ params, site, request }) => {
  // middleware.ts proxies negotiated Markdown requests to this explicit endpoint.
  // The direct /writing/<slug>.md URL also powers view markdown and copy markdown in PostRail.
  //
  // Through formatLogLine, not a template literal: this runs before the collection lookup, so an
  // unmatched slug is logged too, and the slug is a live request path value that Astro has already
  // run through `decodeURI` — `%0A` reaches here as a real newline.
  console.log(formatLogLine('writing.md', { slug: params.slug, accept: request.headers.get('accept') }));

  const articles = await getCollection('writing', ({ data }) => showDrafts || !data.draft);
  const article = articles.find((entry) => entry.id === params.slug);

  if (!article) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const base = site!.toString().replace(/\/$/, '');
  const canonicalUrl = `${base}/writing/${article.id}/`;
  const { title, date, description, tags } = article.data;

  const frontmatter = [
    '---',
    `title: ${yamlString(title)}`,
    `author: ${yamlString(AUTHOR)}`,
    `datePublished: ${date.toISOString()}`,
    `description: ${yamlString(description)}`,
    ...(tags.length > 0 ? [`tags: ${yamlList(tags)}`] : []),
    `canonical: ${canonicalUrl}`,
    `source: ${canonicalUrl}`,
    '---',
  ].join('\n');

  const body = `${frontmatter}\n\n# ${title}\n\n${article.body ?? ''}`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Link: `<${canonicalUrl}>; rel="canonical"`,
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      Vary: 'Accept',
    },
  });
};
