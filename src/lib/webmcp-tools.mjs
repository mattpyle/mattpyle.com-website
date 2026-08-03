/**
 * The six WebMCP tools exposed by src/components/WebMCP.astro: four read, two write.
 *
 * Kept out of the component's <script> so `node --test` can import and exercise the
 * handlers without a browser or the origin trial (see tests/webmcp.test.mjs) — same
 * split as src/lib/article-actions.mjs.
 *
 * The read tools (describe_site, get_recent_writing, search_content, list_related_sites)
 * are read-only and deterministic: their only I/O is the caller-supplied getIndex(), which
 * resolves the same-origin /webmcp/index.json payload, or a frozen array compiled into the
 * bundle. The two write tools are client-local by construction and touch no server and no
 * other visitor's view: set_appearance flips the appearance (localStorage + the
 * <html data-appearance> attribute) via src/lib/appearance.mjs, and sign_guestbook appends
 * an entry to this browser's guest book via src/lib/guestbook.mjs.
 *
 * PROVENANCE IS SET HERE, NOT PASSED IN. sign_guestbook hardcodes source 'agent' and the
 * form hardcodes 'human'. Neither reads it off a field, which is the only reason the
 * [SIGNED BY AGENT] badge on the rendered entry means anything.
 *
 * CHROME DOES NOT VALIDATE inputSchema. Measured on Chrome 150 against the live origin trial
 * (2026-07-17): `search_content` was invoked with `{}` despite `query` being declared `required`,
 * and `get_recent_writing` with `limit: 999` despite a declared `maximum` of 20. Both were passed
 * straight through to the handler. The schema is advertising, not a contract — so the clamping in
 * get_recent_writing and the blank-query guard in search_content are load-bearing input validation,
 * not defensive decoration. Treat every `args` value as untrusted and validate it here.
 *
 * The execute contract, also measured rather than assumed: Chrome hands the handler a parsed object,
 * and serializes whatever the handler returns into a JSON string for the caller.
 */

import { APPEARANCES, getAppearance, setAppearance } from './appearance.mjs';
import { MESSAGE_MAX, NAME_MAX, addEntry, formatEntryNumber } from './guestbook.mjs';
import { WEB_RING, WEB_RING_DESCRIPTION, WEB_RING_NAME } from './web-ring.mjs';

/**
 * @typedef {object} WebmcpIndex
 * @property {any} site
 * @property {any[]} writing
 * @property {any[]} builds
 * @property {any[]} [changelog]
 */

/**
 * Resolve the modelContext namespace.
 *
 * Measured on Chrome 150 against the live origin trial (2026-07-17): `document.modelContext` and
 * `navigator.modelContext` are the *same object* — not two competing surfaces, and neither is
 * absent. The two-surface probe is kept regardless: it costs nothing, and Chrome 149 reportedly
 * exposed only the `navigator` one.
 *
 * @param {{ document?: any, navigator?: any }} [scope]
 * @returns {any|null}
 */
export function resolveModelContext(scope = globalThis) {
  const mc =
    (scope.document && scope.document.modelContext) ||
    (scope.navigator && scope.navigator.modelContext) ||
    null;
  return mc && typeof mc.registerTool === 'function' ? mc : null;
}

const MAX_LIMIT = 20;

/** @param {string} value */
function normalize(value) {
  return String(value ?? '').toLowerCase();
}

/**
 * Every tag carried by the given entries, deduplicated case-insensitively and sorted, in the
 * casing the content itself uses. Only ever read on the empty branch of get_recent_writing, so
 * the cost lands on the call that needs the help.
 *
 * @param {any[]} entries
 */
function collectTags(entries) {
  const seen = new Map();
  for (const entry of entries) {
    for (const tag of entry.tags ?? []) {
      if (!seen.has(normalize(tag))) seen.set(normalize(tag), tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Build the tool definitions.
 *
 * @param {() => Promise<WebmcpIndex>} getIndex
 * @returns {Array<{ name: string, description: string, inputSchema: object, execute: (args?: any) => Promise<any> }>}
 */
export function createTools(getIndex) {
  return [
    {
      name: 'describe_site',
      description:
        "Describe mattpyle.com: who the author is, what the site is, and which sections it has. Call this first for context about the site you're on.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        const { site } = await getIndex();
        return { person: site.person, site: { name: site.name, url: site.url, description: site.description }, sections: site.sections };
      },
    },

    {
      name: 'get_recent_writing',
      description:
        'List the most recent published articles on mattpyle.com, newest first, optionally filtered to a single tag.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LIMIT,
            default: 5,
            description: 'How many articles to return (1-20).',
          },
          tag: {
            type: 'string',
            description: 'Only return articles carrying this tag (case-insensitive).',
          },
        },
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        const { writing } = await getIndex();
        const rawLimit = Number.isInteger(args.limit) ? args.limit : 5;
        const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
        const tag = args.tag ? normalize(args.tag) : null;

        const posts = writing
          .filter((post) => !tag || post.tags.some((t) => normalize(t) === tag))
          .slice(0, limit)
          .map((post) => ({
            title: post.title,
            url: post.url,
            date: post.date,
            ...(post.updated ? { updated: post.updated } : {}),
            tags: post.tags,
            description: post.description,
          }));

        // An empty result has to diagnose itself. Measured in build-log Session 16: the Model
        // Context Tool Inspector autofilled the optional `tag` with "example_string", so every
        // call honestly returned zero posts and an agent reading only `posts` would conclude the
        // site has no writing. Clients that generate placeholder arguments from a schema turn an
        // optional filter into a filter that matches nothing, so the empty case carries the
        // unmatched value, the unfiltered count, and the tags that would work. The non-empty
        // shape is untouched: only this branch gains fields.
        if (tag && posts.length === 0) {
          return {
            posts: [],
            unmatchedTag: String(args.tag),
            publishedCount: writing.length,
            availableTags: collectTags(writing),
            note:
              `No published article on mattpyle.com is tagged "${args.tag}". ` +
              `${writing.length} published article${writing.length === 1 ? '' : 's'} exist without the tag filter — ` +
              'call this tool again with no `tag` to list them, or use one of `availableTags`.',
          };
        }

        return { posts };
      },
    },

    {
      name: 'search_content',
      description:
        'Search the titles, descriptions, and tags of every published article, build, and changelog entry on mattpyle.com.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Text to search for (case-insensitive).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        const { writing, builds, changelog = [] } = await getIndex();
        const query = normalize(args.query).trim();
        if (!query) {
          // Chrome does not enforce `required`, so a blank or missing query reaches the handler.
          // Returning a bare empty array reads identically to "nothing on this site matches",
          // which is the one thing it does not mean.
          return {
            results: [],
            note: 'search_content needs a non-empty `query`; nothing was searched. Pass the text to search for.',
          };
        }

        /** @param {any} entry @param {'writing'|'build'|'changelog'} type */
        const match = (entry, type) => {
          const haystack = [entry.title, entry.description, ...(entry.tags ?? [])].map(normalize);
          if (!haystack.some((field) => field.includes(query))) return null;
          return {
            type,
            title: entry.title,
            url: entry.url,
            snippet: entry.description,
            ...(entry.status ? { status: entry.status } : {}),
            ...(entry.significance ? { significance: entry.significance } : {}),
          };
        };

        const results = [
          ...writing.map((entry) => match(entry, 'writing')),
          ...builds.map((entry) => match(entry, 'build')),
          ...changelog.map((entry) => match(entry, 'changelog')),
        ].filter(Boolean);

        // A miss names the query it searched for and the corpus it searched, so an agent can tell
        // "this site has nothing about X" apart from "this tool searched nothing". The corpus is
        // titles, descriptions, and tags only, which is why a page like /webmcp — not a content
        // collection entry — is unfindable here; saying so is cheaper than a wrong conclusion.
        if (results.length === 0) {
          return {
            results: [],
            query: String(args.query),
            corpus: { writing: writing.length, builds: builds.length, changelog: changelog.length },
            note:
              `Nothing on mattpyle.com matches "${args.query}". ` +
              `Searched the titles, descriptions, and tags of ${writing.length + builds.length + changelog.length} entries ` +
              `(${writing.length} writing, ${builds.length} builds, ${changelog.length} changelog). ` +
              'Full article text is not indexed; try a broader term or call get_recent_writing to browse.',
          };
        }

        return { results };
      },
    },

    {
      name: 'set_appearance',
      description:
        "Switch mattpyle.com between its modern appearance and a retro, GeoCities-era skin. This changes only the calling browser's own view (stored in that browser's localStorage) — it never affects the site for other visitors. Pass mode: 'retro' or 'modern'.",
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [...APPEARANCES],
            description: "The appearance to switch to: 'modern' or 'retro'.",
          },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        // The runtime does not validate inputSchema (see the module doc comment
        // above) — setAppearance() itself falls back to 'modern' for anything
        // outside APPEARANCES, so an invalid mode is a no-op, not an error.
        const resolved = setAppearance(args.mode);
        return {
          mode: resolved,
          message:
            resolved === 'retro'
              ? 'Retro mode is now on for this browser.'
              : 'Modern mode is now on for this browser.',
        };
      },
    },

    {
      name: 'sign_guestbook',
      description:
        "Sign the guest book on mattpyle.com with a name and a message. The entry is saved in the calling browser's own localStorage and nowhere else — no server receives it and no other visitor can see it. Entries signed through this tool are recorded and displayed as agent-written, which the form cannot claim and this tool cannot disclaim. Safe to retry: calling it again with the same name and message as the most recent entry returns that entry instead of writing a duplicate.",
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: NAME_MAX,
            description: `The signature on the entry (1-${NAME_MAX} characters; longer names are trimmed).`,
          },
          message: {
            type: 'string',
            minLength: 1,
            maxLength: MESSAGE_MAX,
            description: `What the entry says (1-${MESSAGE_MAX} characters; longer messages are trimmed).`,
          },
        },
        required: ['name', 'message'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        // Clamping is load-bearing, not decoration: the runtime does not enforce maxLength (see
        // the module doc comment), and the visible form's maxlength has to mean the same thing
        // whichever path wrote the entry. addEntry() clamps, then rejects only what is empty
        // after clamping.
        const result = addEntry({ name: args.name, message: args.message }, 'agent');

        if (!result.ok) {
          return {
            ok: false,
            error:
              result.error === 'name'
                ? 'The entry needs a name. Pass a non-empty `name`.'
                : 'The entry needs a message. Pass a non-empty `message`.',
          };
        }

        const number = formatEntryNumber(result.entry.number);
        // The tool registers on every route, so it can be called from a page that does not render
        // the book. Say where the entry landed rather than splitting the registration path.
        const where =
          getAppearance() === 'retro'
            ? 'It is at the top of the guest book on the homepage.'
            : 'It is at the top of the guest book on the homepage, which displays in retro mode ' +
              '(call set_appearance with mode "retro" to show it).';

        const entry = {
          number: result.entry.number,
          label: number,
          name: result.entry.name,
          message: result.entry.message,
          date: result.entry.date,
          source: result.entry.source,
        };

        // addEntry() suppressed a replay (see its doc comment). Say so rather than reporting a
        // write that did not happen: an agent told "signed as #006" twice has been lied to about
        // the state of the book, which is the failure this whole guard exists to avoid.
        if (result.duplicate) {
          return {
            ok: true,
            duplicate: true,
            entry,
            message:
              `That entry is already in the book as ${number}, signed on ${result.entry.date}, so nothing was ` +
              'written. An identical name and message repeated against the most recent entry is treated as a ' +
              `replay of the same call rather than a second signature. ${where}`,
          };
        }

        return {
          ok: true,
          entry,
          message:
            `Signed as entry ${number}, marked [SIGNED BY AGENT]. ${where} ` +
            'It was written to this browser\'s localStorage only: no server received it, and no ' +
            'other visitor to mattpyle.com will ever see it.',
        };
      },
    },

    {
      name: 'list_related_sites',
      description:
        'List the sites in the web ring on mattpyle.com: a hand-picked, one-directional ring of sites experimenting with the agentic web. Read-only. The ring is still being filled, so some entries are open slots with no URL.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({
        ring: { name: WEB_RING_NAME, description: WEB_RING_DESCRIPTION },
        // The same array the ring box on the homepage renders. One source, two surfaces.
        sites: WEB_RING.map((member) => ({
          name: member.name,
          url: member.url,
          description: member.description,
          status: member.status,
        })),
      }),
    },
  ];
}

/**
 * Register every tool against a resolved modelContext namespace.
 *
 * @param {any} mc
 * @param {() => Promise<WebmcpIndex>} getIndex
 */
export async function registerTools(mc, getIndex) {
  for (const tool of createTools(getIndex)) {
    await mc.registerTool(tool);
  }
}
