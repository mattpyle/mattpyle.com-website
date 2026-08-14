/**
 * The fast-tier checks Steward runs, for the /steward page to list.
 *
 * A hand-kept copy of check specs that live in TypeScript inside the Steward workspace
 * (`agents/steward/src/lib/agent-audit/checks.ts`), and it has to be a copy: only `src/pages/mcp.ts`
 * may import from that workspace, and only through the one entry the exports map publishes, which
 * publishes the audit function rather than the specs behind it. A prerendered page importing
 * Steward would put the whole workspace in the static build's graph, which is the packaging rule
 * the /mcp docblock states.
 *
 * So the drift is guarded from the other side instead. `agents/steward/tests/lib/site-check-list
 * .test.ts` imports both this file and the real specs and asserts they are the same list in the
 * same order — a test can reach across the boundary that a build must not.
 *
 * `id`, `title`, `category` and `severity` are Steward's own words for each check, copied verbatim
 * so a reader of the page and a reader of a report see the same names. `plain` is this file's own:
 * one sentence naming what the check asks of a site, for someone who is reading about the auditor
 * rather than reading a report from it.
 *
 * NO TOP-LEVEL SIDE EFFECTS — this is imported at build time.
 */

/** The 13 fast checks, in the order `runFastAudit` reports them. */
export const STEWARD_FAST_CHECKS = [
  {
    id: 'robots-txt',
    title: 'robots.txt exists and parses',
    category: 'crawlability',
    severity: 'medium',
    plain: 'There is a robots.txt, it is served as text, and its groups and rules parse.',
  },
  {
    id: 'robots-ai-agents',
    title: 'robots.txt lets user-triggered AI agents read the site',
    category: 'crawlability',
    severity: 'high',
    plain:
      'The rules do not block the agents a person points at the site on purpose, which is a different question from whether they block training crawlers.',
  },
  {
    id: 'content-signals',
    title: 'Content Signals preferences are declared',
    category: 'crawlability',
    severity: 'low',
    plain:
      'The site states what its content may be used for, in robots.txt or in a response header, rather than leaving it to be assumed.',
  },
  {
    id: 'sitemap',
    title: 'A sitemap is declared in robots.txt and fetchable',
    category: 'crawlability',
    severity: 'high',
    plain: 'robots.txt names a sitemap, and the sitemap at that URL is fetchable and parses.',
  },
  {
    id: 'llms-txt',
    title: 'llms.txt exists and follows the spec',
    category: 'discovery',
    severity: 'medium',
    plain: 'There is an llms.txt and it is the format the convention describes, not an HTML page under that name.',
  },
  {
    id: 'llms-txt-links',
    title: 'The links in llms.txt resolve',
    category: 'discovery',
    severity: 'medium',
    plain: 'A sample of the URLs llms.txt points at are fetched, and they answer.',
  },
  {
    id: 'llms-txt-list-items',
    title: 'Every llms.txt list item leads with a markdown link',
    category: 'discovery',
    severity: 'low',
    plain: 'Each list item starts with a link, so a parser can read the file as a list of URLs rather than as prose.',
  },
  {
    id: 'agents-md',
    title: 'agents.md exists and is markdown',
    category: 'discovery',
    severity: 'medium',
    plain: 'There is an agents.md brief, and it comes back as markdown rather than as a rendered page.',
  },
  {
    id: 'well-known-mcp-server',
    title: 'An MCP server is discoverable at /.well-known/mcp-server',
    category: 'discovery',
    severity: 'low',
    plain:
      'If the site has an MCP server, a JSON document names its endpoint, so an agent can find it without being told the URL. Nothing to fix if there is no server.',
  },
  {
    id: 'a2a-agent-card',
    title: 'An A2A agent card is published',
    category: 'discovery',
    severity: 'low',
    plain: 'An A2A agent card is served at one of the two well-known paths, and it is JSON.',
  },
  {
    id: 'markdown-negotiation-home',
    title: 'The homepage serves markdown when asked for it',
    category: 'content-access',
    severity: 'high',
    plain:
      'A request for the homepage with `Accept: text/markdown` returns markdown, not HTML with a markdown content type.',
  },
  {
    id: 'markdown-negotiation-content',
    title: 'A content page serves markdown when asked for it',
    category: 'content-access',
    severity: 'high',
    plain:
      'The same question against a real content page, taken from the site’s own sitemap rather than guessed.',
  },
  {
    id: 'link-headers',
    title: 'The homepage advertises its alternates in a Link header',
    category: 'content-access',
    severity: 'low',
    plain: 'The homepage points at its own machine-readable alternates in a `Link` header, where a client sees them before parsing anything.',
  },
];

/** The three fast-tier categories, in report order, with what each one is asking. */
export const STEWARD_CHECK_CATEGORIES = [
  { id: 'crawlability', label: 'Crawlability', summary: 'What the site says an agent may do.' },
  { id: 'discovery', label: 'Discovery', summary: 'What an agent can find without being told where to look.' },
  { id: 'content-access', label: 'Content access', summary: 'Whether the content comes back in a form a model can read.' },
];
