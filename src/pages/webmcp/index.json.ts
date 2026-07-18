import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { compareChangelogEntries } from '../../lib/changelog-order';

/**
 * The single data source behind the WebMCP tools (see src/components/WebMCP.astro).
 * Prerenders to dist/webmcp/index.json at build — no on-demand rendering needed.
 *
 * The `site` block restates the Person/WebSite JSON-LD in src/layouts/Layout.astro and the
 * section list in src/pages/llms.txt.ts. That duplication is deliberate for the spike; if it
 * starts drifting, extract the constants to src/data/ and import them in all three places.
 */
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
  const changelog = (await getCollection('changelog', ({ data }) => !data.draft)).sort(
    compareChangelogEntries
  );

  const index = {
    generated: new Date().toISOString(),
    site: {
      name: 'Matt Pyle',
      url: `${base}/`,
      description:
        'Growth marketer and hobbyist builder. Director of Growth at Temporal Technologies.',
      person: {
        name: 'Matt Pyle',
        jobTitle: 'Director of Growth',
        worksFor: 'Temporal Technologies',
        url: `${base}/`,
        sameAs: ['https://github.com/mattpyle', 'https://linkedin.com/in/matt-pyle'],
      },
      sections: [
        { name: 'Home', url: `${base}/`, summary: 'Bio, tagline, recent activity feed.' },
        { name: 'Writing', url: `${base}/writing`, summary: 'All writing.' },
        { name: 'Builds', url: `${base}/builds`, summary: 'Side projects.' },
        {
          name: 'Changelog',
          url: `${base}/changelog`,
          summary: 'Reverse-chronological log of what has shipped on this site.',
        },
        {
          name: 'Scorecard',
          url: `${base}/scorecard`,
          summary:
            'Latest verified accessibility, performance, SEO, and agentic browsing scores.',
        },
        { name: 'About', url: `${base}/about`, summary: 'Full bio, interests, contact links.' },
      ],
    },
    writing: articles.map((article) => ({
      title: article.data.title,
      slug: article.id,
      url: `${base}/writing/${article.id}`,
      date: article.data.date.toISOString(),
      ...(article.data.updated ? { updated: article.data.updated.toISOString() } : {}),
      tags: article.data.tags,
      description: article.data.description,
    })),
    builds: builds.map((build) => ({
      title: build.data.title,
      slug: build.id,
      // Builds have no per-entry route — src/pages/builds/ is an index page only.
      url: `${base}/builds`,
      date: build.data.date.toISOString(),
      status: build.data.status,
      tags: build.data.tags,
      description: build.data.description,
      ...(build.data.github ? { github: build.data.github } : {}),
      ...(build.data.live ? { live: build.data.live } : {}),
    })),
    // `description` mirrors `summary` so search_content's shared matcher (which reads
    // .title/.description/.tags) covers changelog entries with no special-casing.
    changelog: changelog.map((entry) => ({
      title: entry.data.title,
      slug: entry.id,
      url: `${base}/changelog/${entry.id}`,
      date: entry.data.date.toISOString(),
      ...(entry.data.publishedAt ? { publishedAt: entry.data.publishedAt.toISOString() } : {}),
      ...(entry.data.updated ? { updated: entry.data.updated.toISOString() } : {}),
      type: entry.data.type,
      significance: entry.data.significance,
      tags: entry.data.tags,
      description: entry.data.summary,
    })),
  };

  return new Response(JSON.stringify(index, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
