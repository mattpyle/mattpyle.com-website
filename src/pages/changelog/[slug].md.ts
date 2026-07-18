import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { showDrafts } from '../../lib/show-drafts';

// On-demand, per-request — mirrors src/pages/writing/[slug].md.ts. middleware.ts
// proxies negotiated markdown requests for /changelog/<slug> here; the direct
// /changelog/<slug>.md URL is also fetchable by agents.
export const prerender = false;

const AUTHOR = 'Matt Pyle';

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export const GET: APIRoute = async ({ params, site, request }) => {
  console.log(`[changelog.md] slug=${params.slug} accept="${request.headers.get('accept') ?? ''}"`);

  const entries = await getCollection('changelog', ({ data }) => showDrafts || !data.draft);
  const entry = entries.find((item) => item.id === params.slug);

  if (!entry) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const base = site!.toString().replace(/\/$/, '');
  const canonicalUrl = `${base}/changelog/${entry.id}/`;
  const { title, date, publishedAt, summary, type, significance } = entry.data;

  const frontmatter = [
    '---',
    `title: ${yamlString(title)}`,
    `author: ${yamlString(AUTHOR)}`,
    `datePublished: ${(publishedAt ?? date).toISOString()}`,
    `dateShipped: ${date.toISOString()}`,
    `description: ${yamlString(summary)}`,
    `type: ${yamlString(type)}`,
    `significance: ${yamlString(significance)}`,
    `canonical: ${canonicalUrl}`,
    `source: ${canonicalUrl}`,
    '---',
  ].join('\n');

  const body = `${frontmatter}\n\n# ${title}\n\n${entry.body ?? ''}`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Link: `<${canonicalUrl}>; rel="canonical"`,
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      Vary: 'Accept',
    },
  });
};
