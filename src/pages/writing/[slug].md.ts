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

export const GET: APIRoute = async ({ params, site, request }) => {
  // vercel.json rewrites /writing/<slug> here when Accept contains "text/markdown" —
  // a plain substring match (Vercel's rewrite `has` regex runs on RE2, which has no
  // lookahead), not real q-value ranking. It can't honor `;q=0` or compare priority
  // against text/html the way a real Accept parser would; it only checks presence.
  // Logged here to gauge real-world adoption before investing in true negotiation.
  console.log(`[writing.md] slug=${params.slug} accept="${request.headers.get('accept') ?? ''}"`);

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
      Vary: 'Accept',
    },
  });
};
