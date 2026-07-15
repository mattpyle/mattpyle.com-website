import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const GET: APIRoute = async ({ site }) => {
  // Derive the host from astro.config.mjs `site` so this file can never emit a
  // different host than the canonicals and sitemap do.
  const base = site!.toString().replace(/\/$/, '');

  const articles = (await getCollection('writing', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime()
  );
  const builds = (await getCollection('builds')).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime()
  );

  const lines: string[] = [];

  lines.push('# Matt Pyle — Full Content Export');
  lines.push('');
  lines.push(
    'Director of Growth at Temporal Technologies. Growth marketer and hobbyist builder. This is a full plain-text export of every published article and build on mattpyle.com, generated at build time from the same content that backs the live site.'
  );
  lines.push('');
  lines.push(`See ${base}/agents.md for citation guidance.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Writing');
  lines.push('');
  for (const article of articles) {
    lines.push(`### ${article.data.title}`);
    lines.push('');
    lines.push(`URL: ${base}/writing/${article.slug}`);
    lines.push(`Date: ${formatDate(article.data.date)}`);
    lines.push(`Tags: ${article.data.tags.join(', ')}`);
    lines.push('');
    lines.push(article.data.description);
    lines.push('');
    lines.push(article.body ?? '');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('## Builds');
  lines.push('');
  for (const build of builds) {
    lines.push(`### ${build.data.title}`);
    lines.push('');
    lines.push(`Status: ${build.data.status}`);
    lines.push(`Date: ${formatDate(build.data.date)}`);
    lines.push(`Tags: ${build.data.tags.join(', ')}`);
    if (build.data.github) lines.push(`GitHub: ${build.data.github}`);
    if (build.data.live) lines.push(`Live: ${build.data.live}`);
    lines.push('');
    lines.push(build.data.description);
    lines.push('');
    lines.push(build.body ?? '');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
