/**
 * The web ring: one hand-maintained array feeding two surfaces.
 *
 * The retro ring box on the homepage renders it for humans; `list_related_sites` returns it to
 * agents. Neither has its own copy, so the ring an agent is told about is definitionally the ring
 * on the page.
 *
 * PURE DATA, NO IMPORTS. src/pages/webmcp/tools.json.ts pulls the tool definitions in under plain
 * Node at build time, and this file is on that path.
 *
 * MEMBERSHIP IS DELIBERATELY UNFINISHED. Matt picks the sites; the open slots below ship labelled
 * as open rather than filled with plausible-looking links, because a ring that quietly points at
 * sites nobody vouched for is worse than a ring that admits it is still being built.
 */

export const WEB_RING_NAME = 'The Agentic Web Ring';

export const WEB_RING_DESCRIPTION =
  'A hand-picked, one-directional ring of sites experimenting with the agentic web: WebMCP, llms.txt, agents.md, and agent experience generally.';

/**
 * @typedef {object} RingMember
 * @property {string} name
 * @property {string|null} url  — null on an open slot; there is nothing to link to yet.
 * @property {string} description
 * @property {'member'|'open'} status
 */

/** @type {readonly RingMember[]} */
export const WEB_RING = Object.freeze(
  [
    {
      name: 'mattpyle.com',
      url: 'https://www.mattpyle.com/',
      description:
        'This site. A testbed for WebMCP, llms.txt, agents.md, and agentic-browsing audits, run against a real deployed site.',
      status: 'member',
    },
    {
      name: 'Open slot',
      url: null,
      description:
        'Not filled yet. Matt is picking the sites by hand rather than padding the ring, so this slot stays empty until there is a real one to put in it.',
      status: 'open',
    },
    {
      name: 'Open slot',
      url: null,
      description:
        'Also not filled yet. If you run a site that experiments with agent-facing standards in public, this is the slot you would go in.',
      status: 'open',
    },
    {
      name: 'Open slot',
      url: null,
      description: 'The ring closes here and loops back to the first site.',
      status: 'open',
    },
  ].map((member) => Object.freeze(member))
);

/** The members an agent or a visitor can actually visit. */
export function ringMembers() {
  return WEB_RING.filter((member) => member.status === 'member');
}
