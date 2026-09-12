import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import { compareChangelogEntries } from '../../lib/changelog-order';

// The changelog's own feed, alongside /rss.xml rather than merged into it: the two
// have different subjects, and a reader who subscribed to posts never asked to hear
// about every infrastructure change. /changelog advertised only the writing feed
// until this route existed, which read as "subscribe to the changelog" and was not.
//
// The draft filter here is unconditional — deliberately stricter than the changelog
// index, which relaxes it under SHOW_DRAFTS. An RSS entry gets cached and
// redistributed by other people's readers and cannot be recalled, so a draft must
// never reach this feed in any environment (see CLAUDE.md). scripts/assert-no-drafts.mjs
// fails the build if one does anyway.
//
// Ordered by `compareChangelogEntries`, the same comparator /changelog itself uses,
// so the feed and the page agree entry for entry. A local `publishedAt ?? date`
// sort would differ from the page the moment two entries shared a day and only one
// carried a time. `pubDate` still reads `publishedAt ?? date`: that is the instant
// the entry was published, which is the field RSS is asking for.
export async function GET(context: APIContext) {
  const entries = (await getCollection('changelog', ({ data }) => !data.draft)).sort(
    compareChangelogEntries
  );

  return rss({
    title: 'Matt Pyle — Changelog',
    description:
      'What shipped on mattpyle.com. Features, experiments, content and infrastructure changes on a personal site used as a testbed for agent-ready web standards.',
    site: context.site!,
    items: entries.map((entry) => ({
      title: entry.data.title,
      description: entry.data.summary,
      pubDate: entry.data.publishedAt ?? entry.data.date,
      link: `/changelog/${entry.id}/`,
    })),
    xmlns: { atom: 'http://www.w3.org/2005/Atom' },
    customData: `<language>en-us</language><atom:link href="${new URL('/changelog/rss.xml', context.site)}" rel="self" type="application/rss+xml"/>`,
  });
}
