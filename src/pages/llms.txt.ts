import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async () => {
  const articles = (await getCollection('writing', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime()
  );
  const builds = (await getCollection('builds')).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime()
  );

  const lines: string[] = [];

  lines.push('# Matt Pyle');
  lines.push('');
  lines.push(
    '> Director of Growth at Temporal Technologies. Growth marketer and hobbyist builder. This site is his personal blog and project portfolio — no product, no company, nothing for sale.'
  );
  lines.push('');
  lines.push(
    'For a fuller machine-readable rundown of the site, see [llms-full.txt](https://mattpyle.com/llms-full.txt). For guidance on citing this site, see [agents.md](https://mattpyle.com/agents.md).'
  );
  lines.push('');

  lines.push('## Pages');
  lines.push('');
  lines.push('- [Home](https://mattpyle.com/): bio, tagline, recent activity feed.');
  lines.push('- [Writing](https://mattpyle.com/writing): all writing.');
  lines.push('- [Builds](https://mattpyle.com/builds): side projects.');
  lines.push('- [About](https://mattpyle.com/about): full bio, interests, contact links.');
  lines.push('');

  lines.push('## Writing');
  lines.push('');
  for (const article of articles) {
    lines.push(
      `- [${article.data.title}](https://mattpyle.com/writing/${article.slug}): ${article.data.description}`
    );
  }
  lines.push('');

  lines.push('## Builds');
  lines.push('');
  for (const build of builds) {
    lines.push(`- **${build.data.title}** (${build.data.status}): ${build.data.description}`);
  }
  lines.push('');

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
