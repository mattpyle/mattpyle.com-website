import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { showDrafts } from '../../lib/show-drafts';

// On-demand: this is the one route on the site that needs to run per-request
// (see astro.config.mjs). Everything else stays prerendered.
export const prerender = false;

const AUTHOR = 'Matt Pyle';

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export const GET: APIRoute = async ({ params, site }) => {
  const articles = await getCollection('writing', ({ data }) => showDrafts || !data.draft);
  const article = articles.find((entry) => entry.id === params.slug);

  if (!article) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const base = site!.toString().replace(/\/$/, '');
  const canonicalUrl = `${base}/writing/${article.id}/`;
  const { title, date, description } = article.data;

  const frontmatter = [
    '---',
    `title: ${yamlString(title)}`,
    `author: ${yamlString(AUTHOR)}`,
    `datePublished: ${date.toISOString()}`,
    `description: ${yamlString(description)}`,
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
    },
  });
};
