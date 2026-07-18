import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SCORECARD } from '../data/scorecard';
import { compareChangelogEntries } from '../lib/changelog-order';

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
  const changelog = (await getCollection('changelog', ({ data }) => !data.draft)).sort(
    compareChangelogEntries
  );

  const lines: string[] = [];

  lines.push('# Matt Pyle — Full Content Export');
  lines.push('');
  lines.push(
    'Director of Growth at Temporal Technologies. Growth marketer and hobbyist builder. This exports every published article and build plus the current public scorecard snapshot from mattpyle.com, generated at build time from the same content that backs the live site.'
  );
  lines.push('');
  lines.push(`See ${base}/agents.md for citation guidance.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## WebMCP tools (experimental)');
  lines.push('');
  lines.push(
    'The live pages register three read-only WebMCP tools — describe_site, get_recent_writing, and search_content — on document.modelContext (falling back to the deprecated navigator.modelContext). They are callable only by in-browser agents that implement WebMCP; a doc-reading agent cannot invoke them from this file.'
  );
  lines.push('');
  lines.push(
    `They read one static JSON index, which you can fetch directly instead: ${base}/webmcp/index.json. It carries the same author entity, section map, writing list, and builds list exported below. See ${base}/agents.md for the per-tool detail.`
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Scorecard');
  lines.push('');
  lines.push(`URL: ${base}/scorecard`);
  lines.push(`Verified: ${SCORECARD.verified.iso}`);
  lines.push(`Scope: ${SCORECARD.scope}`);
  lines.push(`Tools: ${SCORECARD.tools.join(', ')}`);
  lines.push('');
  for (const metric of SCORECARD.metrics) {
    lines.push(
      `- ${metric.name}: ${metric.value} / ${metric.maximum} (${metric.status}) — ${metric.description}`
    );
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Writing');
  lines.push('');
  for (const article of articles) {
    lines.push(`### ${article.data.title}`);
    lines.push('');
    lines.push(`URL: ${base}/writing/${article.id}`);
    lines.push(`Markdown: ${base}/writing/${article.id}.md`);
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

  lines.push('## Changelog');
  lines.push('');
  for (const entry of changelog) {
    lines.push(`### ${entry.data.title}`);
    lines.push('');
    lines.push(`URL: ${base}/changelog/${entry.id}`);
    lines.push(`Date: ${formatDate(entry.data.date)}`);
    if (entry.data.publishedAt) lines.push(`Published: ${entry.data.publishedAt.toISOString()}`);
    lines.push(`Type: ${entry.data.type}`);
    lines.push(`Significance: ${entry.data.significance}`);
    lines.push(`Tags: ${entry.data.tags.join(', ')}`);
    lines.push('');
    lines.push(entry.data.summary);
    lines.push('');
    lines.push(entry.body ?? '');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
