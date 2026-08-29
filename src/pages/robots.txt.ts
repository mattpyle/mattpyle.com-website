import type { APIRoute } from 'astro';

// The Content-Signal line (contentsignals.org) is the machine-readable half of what the per-bot
// Allow blocks below already say bot by bot: yes on every axis. search = search indexing,
// ai-input = grounding a live AI answer in this page, ai-train = training or fine-tuning a model.
// It attaches to the group it sits in, so it rides `User-agent: *` and covers everything without
// its own group.
const crawlerRules = `User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=yes
Allow: /

# AI / LLM crawlers — explicitly welcomed (agent/AEO-friendly site)
User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: GoogleOther
Allow: /

User-agent: CCBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

User-agent: Bytespider
Allow: /

User-agent: Meta-ExternalAgent
Allow: /

User-agent: Meta-ExternalFetcher
Allow: /

User-agent: Applebot
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: cohere-ai
Allow: /

User-agent: Amazonbot
Allow: /
`;

export const GET: APIRoute = ({ site }) => {
  // Do not re-add an `Agentmap:` line here. Agentic Resource Discovery's robots.txt mechanism
  // (spec v0.91 §5.1) names an entry source, the way Sitemap names a URL source, and it shipped
  // here on 2026-08-27 on the assumption that a parser ignores a directive it does not know.
  // Lighthouse does not ignore it. Its `robots-txt` audit validates every line against a fixed
  // DIRECTIVE_SAFELIST (read from v13.4.1, core/audits/seo/robots-txt.js) and throws
  // `Unknown directive` on anything off it; `content-signal` is on that list and `agentmap` is
  // not. The line scored the audit 0 and cost 8 SEO points on all 24 pages in the 2026-08-28
  // nightly scorecard, the first Fail on a public metric. Removing it costs the catalogue nothing
  // a consumer is required to read: ARD discovery still rides the well-known path itself and the
  // rel="ard" link Layout.astro emits on every page, the two mechanisms the spec makes mandatory.
  const body = `${crawlerRules}\nSitemap: ${new URL('/sitemap-index.xml', site)}\n`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
