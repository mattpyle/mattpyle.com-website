/**
 * The site's description of itself: the author entity, the one-line site description, and the
 * section map.
 *
 * Two agent-facing surfaces answer from this: src/pages/webmcp/index.json.ts (the index the
 * WebMCP tools read) and scripts/generate-a2a-digest.mjs (the digest the /a2a responder reads).
 * They describe the same site to the same audience over two protocols, so a second hand-kept copy
 * was going to drift; the note in webmcp/index.json.ts said to extract these the moment a third
 * consumer appeared, and A2A is it.
 *
 * src/pages/llms.txt.ts deliberately keeps its own wording. It is a human-readable markdown index
 * rather than a data feed, its summaries are sentence-cased prose tuned for that, and it lists
 * pages (/webmcp) that are not content sections. Folding it in here would change published output
 * to serve tidiness. The three pages the header nav leaves out are named in sitePages() below, so
 * the tools do not omit them.
 *
 * NO TOP-LEVEL SIDE EFFECTS — plain Node scripts import this at build time.
 */

export const SITE_NAME = 'Matt Pyle';

export const SITE_DESCRIPTION =
  'Growth marketer and hobbyist builder. Director of Growth at Temporal Technologies.';

/**
 * The Person entity, restating the JSON-LD in src/layouts/Layout.astro.
 *
 * @param {string} base Origin with no trailing slash.
 */
export function sitePerson(base) {
  return {
    name: 'Matt Pyle',
    jobTitle: 'Director of Growth',
    worksFor: 'Temporal Technologies',
    url: `${base}/`,
    sameAs: ['https://github.com/mattpyle', 'https://linkedin.com/in/matt-pyle'],
  };
}

/**
 * The section map, in nav order.
 *
 * @param {string} base Origin with no trailing slash.
 */
export function siteSections(base) {
  return [
    { name: 'Home', url: `${base}/`, summary: 'Name, tagline, and the latest writing, projects, scorecard and changelog.' },
    { name: 'Writing', url: `${base}/writing/`, summary: 'All writing.' },
    { name: 'Projects', url: `${base}/projects/`, summary: 'Side projects.' },
    {
      name: 'Changelog',
      url: `${base}/changelog/`,
      summary: 'Reverse-chronological log of what has shipped on this site.',
    },
    {
      name: 'Scorecard',
      url: `${base}/scorecard/`,
      summary: 'Latest verified accessibility, performance, SEO, and agentic browsing scores.',
    },
    {
      name: 'Activity',
      url: `${base}/activity/`,
      summary: 'Agent traffic to this site: agent-surface fetches and pages served as Markdown, counted per UTC hour.',
    },
    { name: 'About', url: `${base}/about/`, summary: 'Full bio, interests, contact links.' },
  ];
}

/**
 * The pages about the site's agent work. They are not in the header nav, so they are not in
 * siteSections(); the tools return them as a separate list beside it, matching llms.txt "## Pages".
 *
 * @param {string} base Origin with no trailing slash.
 */
export function sitePages(base) {
  return [
    {
      name: 'WebMCP',
      url: `${base}/webmcp/`,
      summary: 'The WebMCP tools this site registers for in-browser AI agents, what they return, and how to test them.',
    },
    {
      name: 'Steward',
      url: `${base}/steward/`,
      summary: 'The agent-readiness auditor this site runs, the identity it arrives under in your logs, how to refuse it, and how to run an audit yourself.',
    },
    {
      name: 'Audit',
      url: `${base}/audit/`,
      summary: "A form that runs Steward's fast agent-readiness audit on a site you name and shows the report in the page.",
    },
    {
      name: 'Fix log',
      url: `${base}/fix-log/`,
      summary: 'Problems on this site that its agents found, and the fixes they made, each with a before and an after.',
    },
  ];
}
