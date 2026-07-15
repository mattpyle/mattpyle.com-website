import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';

// The draft filter here is unconditional — deliberately stricter than the writing
// index, which relaxes it under SHOW_DRAFTS. An RSS entry gets cached and
// redistributed by other people's readers and cannot be recalled, so a draft must
// never reach this feed in any environment (see CLAUDE.md). scripts/assert-no-drafts.mjs
// fails the build if one does anyway.
export async function GET(context: APIContext) {
  const articles = (await getCollection('writing', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime()
  );

  return rss({
    title: 'Matt Pyle — Writing',
    description:
      'Growth marketer and hobbyist builder. Director of Growth at Temporal Technologies. Writing on agent-ready websites, accessibility, and agent-led growth.',
    site: context.site!,
    items: articles.map((article) => ({
      title: article.data.title,
      description: article.data.description,
      pubDate: article.data.date,
      link: `/writing/${article.slug}/`,
    })),
    customData: '<language>en-us</language>',
  });
}
