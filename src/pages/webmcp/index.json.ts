import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { compareChangelogEntries } from '../../lib/changelog-order';
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  sitePerson,
  siteSections,
} from '../../data/site-sections.mjs';

/**
 * The single data source behind the WebMCP tools (see src/components/WebMCP.astro).
 * Prerenders to dist/webmcp/index.json at build — no on-demand rendering needed.
 *
 * The `site` block restates the Person/WebSite JSON-LD in src/layouts/Layout.astro. It used to
 * restate the section list too; that now comes from src/data/site-sections.mjs, which the A2A
 * digest also reads, so the two agent-facing surfaces cannot describe the site differently.
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
    // Reciprocal pointers. This file is the *content* index the tools read, not a WebMCP
    // manifest — and it is the more guessable of the two URLs under /webmcp/. Point at the
    // manifest and the human page so an agent that lands here first doesn't mistake it for
    // the tool surface. (The name stays: live tools fetch this URL and it is published.)
    docs: `${base}/webmcp/`,
    tools: `${base}/webmcp/tools.json`,
    site: {
      name: SITE_NAME,
      url: `${base}/`,
      description: SITE_DESCRIPTION,
      person: sitePerson(base),
      sections: siteSections(base),
    },
    writing: articles.map((article) => ({
      title: article.data.title,
      slug: article.id,
      url: `${base}/writing/${article.id}/`,
      date: article.data.date.toISOString(),
      ...(article.data.updated ? { updated: article.data.updated.toISOString() } : {}),
      tags: article.data.tags,
      description: article.data.description,
    })),
    builds: builds.map((build) => ({
      title: build.data.title,
      slug: build.id,
      // Builds have no per-entry route — src/pages/builds/ is an index page only.
      url: `${base}/builds/`,
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
      url: `${base}/changelog/${entry.id}/`,
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
