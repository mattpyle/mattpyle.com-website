import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SCORECARD } from '../data/scorecard';
import { compareChangelogEntries } from '../lib/changelog-order';
import { rewriteVideoTags } from '../lib/video-embed.mjs';

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
  const projects = (await getCollection('projects')).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime()
  );
  const changelog = (await getCollection('changelog', ({ data }) => !data.draft)).sort(
    compareChangelogEntries
  );

  const lines: string[] = [];

  lines.push('# Matt Pyle — Full Content Export');
  lines.push('');
  lines.push(
    'Director of Growth at Temporal Technologies. Growth marketer and hobbyist builder. This exports every published article and project plus the current public scorecard snapshot from mattpyle.com, generated at build time from the same content that backs the live site.'
  );
  lines.push('');
  lines.push(`See ${base}/agents.md for citation guidance.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## WebMCP tools (experimental)');
  lines.push('');
  lines.push(
    'The live pages register six WebMCP tools on document.modelContext. Four are read-only: describe_site, get_recent_writing, search_content, and list_related_sites (the site\'s curated web ring). Two are write tools: set_appearance, which switches this site between its modern and retro appearances, and sign_guestbook, which appends a name and a message to the guest book on the homepage. Both writes are client-local, going to keys in the calling browser\'s own localStorage; they change no server state and affect no other visitor, and nobody else will ever see a guest-book entry written this way. Entries written through sign_guestbook are recorded as agent-written and render with a visible "signed by agent" badge; the provenance is set by the code path that wrote the entry, not by a field the caller passes. (navigator.modelContext is the same object as document.modelContext, not a deprecated fallback — measured on Chrome 150, 2026-07-17.)'
  );
  lines.push('');
  lines.push(
    'They are callable only by in-browser agents that implement WebMCP; a doc-reading agent cannot invoke them from this file.'
  );
  lines.push('');
  lines.push(
    `Machine-readable: ${base}/webmcp/tools.json is the tool manifest (names, descriptions, input schemas, example calls), generated from the live tool objects. ${base}/webmcp/index.json is the static content index the tools read — the same author entity, section map, writing list, and projects list exported below — and you can fetch it directly. ${base}/webmcp/ is the human-facing page, with the per-tool detail and the current state of the standard.`
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Scorecard');
  lines.push('');
  lines.push(`URL: ${base}/scorecard/`);
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
    lines.push(`URL: ${base}/writing/${article.id}/`);
    lines.push(`Markdown: ${base}/writing/${article.id}.md`);
    lines.push(`Date: ${formatDate(article.data.date)}`);
    lines.push(`Tags: ${article.data.tags.join(', ')}`);
    lines.push('');
    lines.push(article.data.description);
    lines.push('');
    // Same rewrite the site's markdown pipeline runs, so the `<Video />` tag
    // Keystatic stores reaches this export as a real element. See
    // src/lib/video-embed.mjs.
    lines.push(rewriteVideoTags(article.body ?? ''));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('## Projects');
  lines.push('');
  for (const project of projects) {
    lines.push(`### ${project.data.title}`);
    lines.push('');
    lines.push(`Status: ${project.data.status}`);
    lines.push(`Date: ${formatDate(project.data.date)}`);
    lines.push(`Tags: ${project.data.tags.join(', ')}`);
    if (project.data.github) lines.push(`GitHub: ${project.data.github}`);
    if (project.data.live) lines.push(`Live: ${project.data.live}`);
    lines.push('');
    lines.push(project.data.description);
    lines.push('');
    lines.push(project.body ?? '');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('## Changelog');
  lines.push('');
  for (const entry of changelog) {
    lines.push(`### ${entry.data.title}`);
    lines.push('');
    lines.push(`URL: ${base}/changelog/${entry.id}/`);
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
