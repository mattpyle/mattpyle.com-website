/**
 * The three read-only WebMCP tools exposed by src/components/WebMCP.astro.
 *
 * Kept out of the component's <script> so `node --test` can import and exercise the
 * handlers without a browser or the origin trial (see tests/webmcp.test.mjs) — same
 * split as src/lib/article-actions.mjs.
 *
 * The read tools (describe_site, get_recent_writing, search_content) are read-only
 * and deterministic: their only I/O is the caller-supplied getIndex(), which resolves
 * the same-origin /webmcp/index.json payload. set_appearance is the exception — a write
 * tool that flips the client-local appearance (localStorage + the <html data-appearance>
 * attribute) via src/lib/appearance.mjs, touching no server and no other visitor's view.
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

import { APPEARANCES, setAppearance } from './appearance.mjs';

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
        if (!query) return { results: [] };

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
