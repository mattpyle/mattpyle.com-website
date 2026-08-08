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
 * to serve tidiness.
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
    { name: 'Home', url: `${base}/`, summary: 'Bio, tagline, recent activity feed.' },
    { name: 'Writing', url: `${base}/writing/`, summary: 'All writing.' },
    { name: 'Builds', url: `${base}/builds/`, summary: 'Side projects.' },
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
    { name: 'About', url: `${base}/about/`, summary: 'Full bio, interests, contact links.' },
  ];
}
