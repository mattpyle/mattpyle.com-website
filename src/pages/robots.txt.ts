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
  const body = `${crawlerRules}\nSitemap: ${new URL('/sitemap-index.xml', site)}\n`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
