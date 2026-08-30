import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { compareChangelogEntries } from '../lib/changelog-order';
import { formatSkillsIndexLines } from '../lib/agent-skills.mjs';
import skillsIndex from '../data/agent-skills-index.json';

export const GET: APIRoute = async ({ site }) => {
  // Derive the host from astro.config.mjs `site` so llms.txt can never emit a
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

  lines.push('# Matt Pyle');
  lines.push('');
  lines.push(
    '> Director of Growth at Temporal Technologies. Growth marketer and hobbyist builder. This site is his personal blog and project portfolio — no product, no company, nothing for sale.'
  );
  lines.push('');
  lines.push(
    `For a fuller machine-readable rundown of the site, see [llms-full.txt](${base}/llms-full.txt). For guidance on citing this site, see [agents.md](${base}/agents.md).`
  );
  lines.push('');

  lines.push('## Pages');
  lines.push('');
  lines.push(`- [Home](${base}/): bio, tagline, recent activity feed.`);
  lines.push(`- [Writing](${base}/writing/): all writing.`);
  lines.push(`- [Projects](${base}/projects/): side projects.`);
  lines.push(`- [Changelog](${base}/changelog/): reverse-chronological log of what has shipped on this site.`);
  lines.push(`- [Scorecard](${base}/scorecard/): latest verified accessibility, performance, SEO, and agentic browsing scores.`);
  lines.push(`- [Activity](${base}/activity/): agent traffic to this site — fetches of its agent surfaces and pages served as Markdown, counted per UTC hour.`);
  lines.push(`- [About](${base}/about/): full bio, interests, contact links.`);
  lines.push(`- [WebMCP](${base}/webmcp/): the six WebMCP tools this site registers for in-browser AI agents (four read, two write), what they return, and how to test them.`);
  lines.push(`- [Steward](${base}/steward/): the agent-readiness auditor this site runs, the identity it arrives under in your logs, how to refuse it, and how to run an audit yourself.`);
  lines.push('');

  lines.push('## Machine-readable resources');
  lines.push('');
  lines.push(`- [WebMCP tool manifest](${base}/webmcp/tools.json): names, descriptions, and input schemas for the tools above, generated from the live tool objects.`);
  lines.push(`- [WebMCP content index](${base}/webmcp/index.json): the JSON index those tools read — author entity, section map, and every published article, project, and changelog entry.`);
  // Enumerated from the committed index rather than named in prose, so publishing a skill stays
  // "add a file in src/data/skills/" with no edit here.
  lines.push(...formatSkillsIndexLines(base, skillsIndex.skills));
  lines.push(`- [A2A Agent Card](${base}/.well-known/agent-card.json): this site as an A2A agent. Two skills, answered by a JSON-RPC 2.0 endpoint at ${base}/a2a (A2A 1.0, no auth): ask-about-site returns a direct Message about this site, and audit-a-site audits a site you name, its deep tier as a Task you poll with GetTask. Full calling notes are in agents.md.`);
  lines.push(`- [MCP server discovery](${base}/.well-known/mcp-server): the discovery document for this site's MCP endpoint, per draft-serra-mcp-discovery-uri. It names the streamable-HTTP endpoint at ${base}/mcp, which needs no auth; audit_site(url) runs the fast audit and answers in the same call, and tools/list enumerates the rest. Full notes are on the Steward page.`);
  lines.push(`- [MCP Server Card](${base}/mcp/server-card): the same endpoint described the MCP project's own way, per SEP-2127. Identity, transport, and the protocol versions ${base}/mcp negotiates; it lists no tools, because the spec leaves those to tools/list. Also served at ${base}/.well-known/mcp/server-card.json, the path scanners probe. Media type application/mcp-server-card+json.`);
  lines.push(`- [ARD catalogue](${base}/.well-known/ard.json): this site's Agentic Resource Discovery publisher catalogue, per the ARD specification v0.91. Four entries — the A2A Agent Card, the MCP Server Card, and the two Agent Skills — each pointing at the artifact's own URL rather than restating it. The fuller description is in agents.md.`);
  lines.push(`- [scorecard.json](${base}/scorecard.json): every scorecard run as JSON — the same numbers /scorecard displays.`);
  lines.push(`- [activity.json](${base}/activity.json): the agent-traffic counts as JSON — the same numbers /activity displays, at UTC-hour resolution.`);
  lines.push(`- [llms-full.txt](${base}/llms-full.txt): the full plain-text content export.`);
  lines.push(`- [agents.md](${base}/agents.md): how to read and cite this site.`);
  lines.push('');

  lines.push('## Writing');
  lines.push('');
  for (const article of articles) {
    lines.push(
      `- [${article.data.title}](${base}/writing/${article.id}/): ${article.data.description} ([Markdown](${base}/writing/${article.id}.md))`
    );
  }
  lines.push('');

  // The /writing page's tag filter mirrors its selection into a `?tag=` URL param
  // (see FilterPills.astro), so a filtered view is a real, linkable URL — list it
  // here rather than only describing the filter as an on-page interaction.
  const writingTags = [...new Set(articles.flatMap(a => a.data.tags))].sort();
  if (writingTags.length > 0) {
    lines.push('### Writing by tag');
    lines.push('');
    for (const tag of writingTags) {
      const count = articles.filter(a => a.data.tags.includes(tag)).length;
      lines.push(`- [${tag}](${base}/writing/?tag=${encodeURIComponent(tag)}): ${count} post${count === 1 ? '' : 's'}`);
    }
    lines.push('');
  }

  lines.push('## Projects');
  lines.push('');
  // Projects have no detail pages, so each bullet leads with the anchor of its card on /projects/
  // (ProjectsBoard.astro puts the id on the card anchor). The llms.txt format says a list item leads
  // with a link to somewhere with more detail, and a bullet that is only bold text is a dead end for
  // a parser collecting links — Steward's own `llms-txt-list-items` check reports these, and this
  // section was the site's one failure against it.
  for (const project of projects) {
    lines.push(
      `- [${project.data.title}](${base}/projects/#project-${project.id}) (${project.data.status}): ${project.data.description}`
    );
  }
  lines.push('');

  lines.push('## Changelog');
  lines.push('');
  for (const entry of changelog) {
    lines.push(
      `- [${entry.data.title}](${base}/changelog/${entry.id}/) (${entry.data.type}, ${entry.data.significance}): ${entry.data.summary}`
    );
  }
  lines.push('');

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
