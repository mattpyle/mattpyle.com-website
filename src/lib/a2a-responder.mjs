/**
 * The A2A responder: a JSON-RPC 2.0 handler that answers one method, in the voice of the site's
 * retro webmaster, from a digest compiled at build time.
 *
 * Kept out of src/pages/a2a.ts so `node --test` can exercise the whole protocol surface without a
 * server, an adapter, or a deploy (see tests/a2a-responder.test.mjs) — the same split as
 * src/lib/webmcp-tools.mjs and src/lib/article-actions.mjs. The route is a wrapper: read the body,
 * call respond(), log, serialize.
 *
 * PURE. No I/O, no clock, no randomness of its own: the digest and the id factory are both passed
 * in. Every reply is a function of its arguments, which is what makes the tests assertions about
 * bytes rather than about shapes.
 *
 * THE METHOD NAME IS `SendMessage`, NOT `message/send`. A2A 1.0 (specification section 9.1)
 * renamed the JSON-RPC methods to PascalCase matching the gRPC service: "Method Naming: PascalCase
 * method names matching gRPC conventions (e.g., `SendMessage`, `GetTask`)". `message/send` is the
 * 0.x spelling and appears nowhere in the 1.0 specification. It is accepted here anyway, as an
 * alias, because appendix A.2 explicitly permits it ("Server Implementations MAY: Accept both
 * legacy and current request message forms during the overlap period") and because a client built
 * against a 0.x SDK is exactly the kind of caller this experiment wants to hear from. Responses
 * only ever use the current form, per the same appendix.
 *
 * ERROR SHAPES ARE THE 1.0 ONES. `error.data` is an *array* of objects each carrying an `@type`
 * (specification section 9.5), not the bare object the 0.x-era examples used. The house rule from
 * the WebMCP tools carries over: an error names what was wrong, what was expected, and the one
 * call that would have worked, because an agent that cannot self-correct from the error will
 * either retry identically or conclude the site is broken.
 *
 * WHAT IT DOES NOT DO: streaming, Tasks, push notifications, authentication, or any state at all.
 * The skill is read-only over public content, so every call is trivially replay-safe and there is
 * nothing for a Task to track.
 */

const DOMAIN = 'www.mattpyle.com';

/** The one method this endpoint implements, in its A2A 1.0 spelling. */
export const A2A_METHOD = 'SendMessage';

/** Pre-1.0 spellings accepted from older clients. Never emitted. */
export const LEGACY_METHODS = Object.freeze(['message/send']);

export const ERROR_CODES = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
});

/* ------------------------------------------------------------------ formatting helpers */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-07-18T00:00:00.000Z` -> `18 Jul 2026`.
 *
 * Deliberately not toLocaleDateString: the reply has to read identically on the build machine, in
 * the test, and in whatever region the function cold-starts in.
 */
export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** @param {number} count @param {string} singular @param {string} [plural] */
function count(count_, singular, plural = `${singular}s`) {
  return `${count_} ${count_ === 1 ? singular : plural}`;
}

/* ------------------------------------------------------------------ the answers */

const PROVENANCE =
  '(Compiled from this site\'s own published content when it was last built. Nothing above was fetched just now, and nothing above is not on the site.)';

function describe(digest, { unrecognised = false } = {}) {
  const { site, counts } = digest;
  const lines = [];

  lines.push(
    unrecognised
      ? 'Webmaster speaking. I did not recognise the question, so here is the front desk answer.'
      : 'mattpyle.com. Webmaster speaking.'
  );
  lines.push('');
  lines.push(
    `This is ${site.person.name}'s personal site. He is ${site.person.jobTitle} at ${site.person.worksFor}; ` +
      'the site is a personal blog and project portfolio with no product, no company, and nothing for sale. ' +
      'It doubles as a testbed for emerging web and agent standards, which is why there is a JSON-RPC endpoint ' +
      'on a personal homepage at all.'
  );
  lines.push('');
  lines.push('**Sections**');
  lines.push('');
  for (const section of site.sections) {
    lines.push(`- [${section.name}](${section.url}): ${section.summary}`);
  }
  lines.push('');
  lines.push(
    `Ask me about the writing, the builds, what shipped recently, the scorecard, or the agent-readable ` +
      `surfaces. As of the last deploy: ${count(counts.writing, 'published article')}, ` +
      `${count(counts.builds, 'build')}, ${count(counts.changelog, 'changelog entry', 'changelog entries')}.`
  );
  lines.push('');
  lines.push(PROVENANCE);
  return lines.join('\n');
}

function writing(digest) {
  const { writing: articles, counts, site } = digest;
  const lines = [];

  if (articles.length === 0) {
    return [
      'The writing desk is empty at the moment: nothing is published.',
      '',
      `The index is at ${site.url}writing, and it will say the same thing.`,
      '',
      PROVENANCE,
    ].join('\n');
  }

  lines.push(`The writing desk. ${count(counts.writing, 'published article')}, newest first.`);
  lines.push('');
  for (const article of articles) {
    const dates = article.updated && article.updated !== article.date
      ? `${formatDate(article.date)}, updated ${formatDate(article.updated)}`
      : formatDate(article.date);
    lines.push(`- [${article.title}](${article.url}) (${dates}): ${article.description}`);
  }
  lines.push('');
  lines.push(
    'Every article has a raw-markdown sibling at the same URL with `.md` on the end, and the canonical ' +
      'URL itself serves markdown to an `Accept: text/markdown` request that genuinely prefers it. ' +
      'Cheaper than scraping the HTML, and it is the same source.'
  );
  lines.push('');
  lines.push(PROVENANCE);
  return lines.join('\n');
}

function builds(digest) {
  const { builds: projects, counts, site } = digest;
  const lines = [];

  if (projects.length === 0) {
    return ['Nothing on the projects shelf right now.', '', PROVENANCE].join('\n');
  }

  lines.push(`The projects shelf. ${count(counts.builds, 'build')}.`);
  lines.push('');
  for (const project of projects) {
    const links = [
      project.live ? `Live: ${project.live}` : null,
      project.github ? `Source: ${project.github}` : null,
    ].filter(Boolean);
    lines.push(
      `- **${project.title}** (${project.status}, ${formatDate(project.date)}): ${project.description}` +
        (links.length ? ` ${links.join('. ')}.` : '')
    );
  }
  lines.push('');
  lines.push(`They share one page: ${site.url}builds.`);
  lines.push('');
  lines.push(PROVENANCE);
  return lines.join('\n');
}

function changelog(digest) {
  const { changelog: entries, counts, site } = digest;
  const lines = [];

  if (entries.length === 0) {
    return ['The log book is empty.', '', PROVENANCE].join('\n');
  }

  const listed =
    counts.changelogListed < counts.changelog
      ? `${count(counts.changelog, 'entry', 'entries')}; the ${counts.changelogListed} most recent below`
      : `${count(counts.changelog, 'entry', 'entries')}`;
  lines.push(`The log book. ${listed}.`);
  lines.push('');
  for (const entry of entries) {
    lines.push(
      `- ${formatDate(entry.date)}, [${entry.title}](${entry.url}) (${entry.type}, ${entry.significance}): ${entry.summary}`
    );
  }
  lines.push('');
  lines.push(
    `The full log, including anything not listed above, is at ${site.url}changelog. Each entry has a ` +
      'raw-markdown sibling on the same terms as the writing.'
  );
  lines.push('');
  lines.push(PROVENANCE);
  return lines.join('\n');
}

function surfaces(digest) {
  const lines = [];
  lines.push(
    'What this site hands to agents. This is the part of the job the webmaster actually enjoys.'
  );
  lines.push('');
  for (const surface of digest.surfaces) {
    lines.push(`- **${surface.name}** (${surface.url}): ${surface.description}`);
  }
  lines.push('');
  lines.push(
    'All of it is public, unauthenticated, and readable without calling me. If you can fetch a URL, ' +
      'you do not need this endpoint; it exists because the site is a testbed for the protocol, not ' +
      'because the content is otherwise locked up.'
  );
  lines.push('');
  lines.push(PROVENANCE);
  return lines.join('\n');
}

function scorecard(digest) {
  const scorecardSection = digest.site.sections.find((section) => section.name === 'Scorecard');
  return [
    'The scorecard.',
    '',
    `Latest verified accessibility, performance, SEO, and agentic browsing results, with the run ` +
      `history and the method used to produce them: ${scorecardSection?.url ?? `${digest.site.url}scorecard`}.`,
    '',
    'I will not quote you a number. The scores are not in the digest I answer from, and a stale score ' +
      'read out with confidence is worse than a link. The page has them, dated, per run.',
    '',
    PROVENANCE,
  ].join('\n');
}

function person(digest) {
  const { person: who, sections } = digest.site;
  const about = sections.find((section) => section.name === 'About');
  return [
    `${who.name}. He owns the place; I answer the door.`,
    '',
    `${who.jobTitle} at ${who.worksFor}. A growth marketer and a hobbyist builder: he writes real, ` +
      'working code, mostly with Claude Code as a collaborator, and does not claim to be a professional ' +
      'software engineer. Writing here is personal opinion and first-hand experience, not his employer\'s position.',
    '',
    `Elsewhere: ${who.sameAs.join(', ')}.`,
    '',
    `Full bio and contact links: ${about?.url ?? `${digest.site.url}about`}.`,
    '',
    PROVENANCE,
  ].join('\n');
}

/**
 * Intent matching, in priority order for ties.
 *
 * A keyword list rather than a model, on purpose: the v1 has to be deterministic enough that its
 * replies can be asserted byte for byte, and cheap enough that an unauthenticated public endpoint
 * cannot be turned into someone else's inference bill. The model-backed version is a separate
 * piece of work.
 */
const INTENTS = [
  {
    id: 'surfaces',
    answer: surfaces,
    keywords: [
      'agents.md', 'llms.txt', 'llms-full', 'llms', 'webmcp', 'mcp', 'a2a', 'agent card',
      'agent-readable', 'agent readable', 'machine-readable', 'machine readable', 'protocol',
      'endpoint', 'api', 'tool', 'tools', 'sitemap', 'robots', 'structured data', 'json-ld',
      'schema', 'crawl', 'scrape', 'markdown', 'surface', 'surfaces', 'expose', 'exposes',
    ],
  },
  {
    id: 'scorecard',
    answer: scorecard,
    keywords: [
      'scorecard', 'score', 'accessibility', 'a11y', 'lighthouse', 'performance', 'audit', 'seo',
      'wcag', 'core web vitals',
    ],
  },
  // Writing outranks changelog on a tie so "what has Matt written recently?" lands on the posts
  // rather than on the log; "what shipped lately?" scores two changelog keywords and wins anyway.
  {
    id: 'writing',
    answer: writing,
    keywords: [
      'writing', 'write', 'writes', 'wrote', 'written', 'post', 'posts', 'article', 'articles',
      'blog', 'essay', 'essays', 'reading', 'published',
    ],
  },
  {
    id: 'changelog',
    answer: changelog,
    keywords: [
      'changelog', 'change log', 'shipped', 'ship', 'recently', 'recent', 'latest', 'newest',
      'new', 'update', 'updates', 'news', 'what happened', 'lately', 'log',
    ],
  },
  {
    id: 'builds',
    answer: builds,
    keywords: [
      'build', 'builds', 'built', 'project', 'projects', 'portfolio', 'side project', 'made',
      'making', 'demo',
    ],
  },
  {
    id: 'person',
    answer: person,
    keywords: [
      'who is', 'who runs', 'who made', 'who built', 'who owns', 'matt pyle', 'about matt',
      'author', 'bio', 'biography', 'temporal', 'job', 'career', 'background', 'contact',
      'linkedin', 'github profile',
    ],
  },
];

/**
 * Orientation is a fallback, not a competing intent.
 *
 * It was one, briefly, and the ranking punished exactly the questions the Agent Card advertises:
 * "what agent-readable surfaces does this site expose?" scored one `surfaces` keyword against two
 * generic ones and got the front-desk answer. Anything broad enough to catch "what is this site
 * about?" is broad enough to outscore a specific question that happens to mention the site, so
 * these never compete for the win. They only decide whether the orientation answer opens by
 * apologising.
 */
const ORIENTATION_KEYWORDS = [
  'site', 'website', 'what is this', 'what is it', 'overview', 'tell me about', 'sections',
  'homepage', 'home page', 'help', 'what can you do', 'what do you do', 'hello', 'hi', 'about',
];

/**
 * The question, lowercased and padded, with punctuation flattened to spaces.
 *
 * `.`, `+`, `/` and `-` survive so "agents.md", "llms.txt", "message/send" and "agent-readable"
 * stay matchable as single tokens.
 */
function normalize(question) {
  return ` ${String(question ?? '').toLowerCase().replace(/[^a-z0-9.+/-]+/g, ' ')} `;
}

/** How many of a keyword list appear in the question as whole tokens. */
function score(text, keywords) {
  // Padded on both sides so "log" does not match inside "blog" and "new" does not match inside
  // "newest". The lists overlap enough that substring matching would make the ranking noise.
  return keywords.reduce((total, keyword) => total + (text.includes(` ${keyword} `) ? 1 : 0), 0);
}

/**
 * The intent with the most keyword hits, or null when nothing specific matched.
 *
 * @param {string} question
 */
export function classify(question) {
  const text = normalize(question);
  let best = null;
  for (const intent of INTENTS) {
    const hits = score(text, intent.keywords);
    if (hits > (best?.hits ?? 0)) best = { intent, hits };
  }
  return best?.intent ?? null;
}

/**
 * The webmaster's answer to one question.
 *
 * @param {string} question
 * @param {object} digest
 */
export function answer(question, digest) {
  const intent = classify(question);
  if (intent) return { intent: intent.id, text: intent.answer(digest) };

  const text = normalize(question);
  // Nothing specific matched. Either the question was a general one about the site, which the
  // orientation answer is the right answer to, or it was not understood, which the same answer
  // should admit before giving it.
  const oriented = score(text, ORIENTATION_KEYWORDS) > 0;
  const asked = /[a-z0-9]/i.test(String(question ?? ''));
  return { intent: 'site', text: describe(digest, { unrecognised: asked && !oriented }) };
}

/* ------------------------------------------------------------------ the JSON-RPC envelope */

function errorResponse(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function errorInfo(reason, metadata) {
  return {
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: DOMAIN,
    ...(metadata ? { metadata } : {}),
  };
}

function badRequest(violations) {
  return { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: violations };
}

/** The first non-empty `text` in a Message's parts, or null. */
function readText(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.parts)) return null;
  for (const part of message.parts) {
    // A 1.0 TextPart is `{ "text": "..." }`; the 0.x one was `{ "kind": "text", "text": "..." }`.
    // Reading the member directly accepts both without a discriminator branch.
    if (part && typeof part === 'object' && typeof part.text === 'string' && part.text.trim() !== '') {
      return part.text;
    }
  }
  return null;
}

/**
 * Handle one already-parsed JSON-RPC request object.
 *
 * @param {unknown} request
 * @param {{ digest: object, newId: () => string }} context
 */
function handleRequest(request, { digest, newId }) {
  if (Array.isArray(request)) {
    return {
      outcome: 'invalid-request/batch',
      payload: errorResponse(null, ERROR_CODES.invalidRequest, 'Request payload validation error. This endpoint does not support JSON-RPC batch requests; send one request object.', [
        errorInfo('BATCH_NOT_SUPPORTED'),
      ]),
    };
  }

  if (!request || typeof request !== 'object') {
    return {
      outcome: 'invalid-request/not-an-object',
      payload: errorResponse(null, ERROR_CODES.invalidRequest, 'Request payload validation error. A JSON-RPC request must be a JSON object.', [
        errorInfo('NOT_AN_OBJECT'),
      ]),
    };
  }

  const id = request.id ?? null;
  // A request with no `id` is a JSON-RPC notification: it gets no response body at all. Honoured
  // rather than answered-anyway, because a client that sent one is not reading.
  const isNotification = !('id' in request) || request.id === undefined;

  const violations = [];
  if (request.jsonrpc !== '2.0') {
    violations.push({ field: 'jsonrpc', description: 'Must be exactly "2.0".' });
  }
  if (typeof request.method !== 'string' || request.method === '') {
    violations.push({ field: 'method', description: 'Must be a non-empty string.' });
  }
  if (violations.length > 0) {
    return {
      outcome: 'invalid-request/envelope',
      notification: isNotification,
      payload: errorResponse(id, ERROR_CODES.invalidRequest, `Request payload validation error. A valid call to this endpoint looks like {"jsonrpc":"2.0","id":1,"method":"${A2A_METHOD}","params":{"message":{"role":"ROLE_USER","messageId":"1","parts":[{"text":"What is this site about?"}]}}}.`, [
        badRequest(violations),
      ]),
    };
  }

  const method = request.method;
  const known = method === A2A_METHOD || LEGACY_METHODS.includes(method);
  if (!known) {
    return {
      outcome: `method-not-found/${method}`,
      notification: isNotification,
      payload: errorResponse(id, ERROR_CODES.methodNotFound, `Method not found: "${method}". This endpoint implements exactly one method, "${A2A_METHOD}", which returns a direct Message rather than a Task. Streaming, Tasks, push notifications and the extended Agent Card are not implemented; the Agent Card at https://${DOMAIN}/.well-known/agent-card.json declares the same thing.`, [
        errorInfo('METHOD_NOT_FOUND', {
          requested: method,
          supported: A2A_METHOD,
          acceptedAliases: LEGACY_METHODS.join(','),
          agentCard: `https://${DOMAIN}/.well-known/agent-card.json`,
        }),
      ]),
    };
  }

  const params = request.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return {
      outcome: 'invalid-params/no-params',
      notification: isNotification,
      payload: errorResponse(id, ERROR_CODES.invalidParams, `Invalid parameters. ${A2A_METHOD} takes a SendMessageRequest object as params, with a "message" holding at least one part carrying text.`, [
        badRequest([{ field: 'params', description: 'Must be a SendMessageRequest object.' }]),
      ]),
    };
  }

  const text = readText(params.message);
  if (text === null) {
    const description =
      !params.message || typeof params.message !== 'object'
        ? 'Must be a Message object.'
        : !Array.isArray(params.message.parts)
          ? 'Must be an array of Parts.'
          : 'Must contain at least one part with a non-empty "text" string. In A2A 1.0 a text part is {"text":"..."}; the 0.x {"kind":"text","text":"..."} form is also accepted.';
    const field =
      !params.message || typeof params.message !== 'object' ? 'message' : 'message.parts';

    return {
      outcome: 'invalid-params/no-text',
      notification: isNotification,
      payload: errorResponse(id, ERROR_CODES.invalidParams, 'Invalid parameters. This skill answers questions in text, so the message needs a text part; nothing was found to answer.', [
        badRequest([{ field, description }]),
      ]),
    };
  }

  const { intent, text: reply } = answer(text, digest);

  return {
    outcome: `ok/${intent}`,
    notification: isNotification,
    payload: {
      jsonrpc: '2.0',
      id,
      // A SendMessageResponse carrying a Message rather than a Task. The skill is a single
      // read-only turn with nothing to track, so creating a Task would be ceremony that a client
      // then has to poll to completion for no reason. The spec allows either.
      result: {
        message: {
          role: 'ROLE_AGENT',
          messageId: newId(),
          // Servers must set contextId. An inbound one is echoed so a client threading a
          // conversation keeps its own thread id.
          contextId:
            typeof params.message.contextId === 'string' && params.message.contextId !== ''
              ? params.message.contextId
              : newId(),
          parts: [{ text: reply, mediaType: 'text/markdown' }],
        },
      },
    },
  };
}

/**
 * Handle one raw request body.
 *
 * @param {string} rawBody
 * @param {{ digest: object, newId: () => string }} context
 * @returns {{ status: number, outcome: string, payload: object | null }} payload null means send
 *   no body (a JSON-RPC notification).
 */
export function respond(rawBody, { digest, newId }) {
  let request;
  try {
    request = JSON.parse(rawBody);
  } catch (error) {
    // Always answered, never treated as a notification: an unparseable body is precisely the case
    // where the id, and therefore whether a response was wanted, cannot be known.
    return {
      status: 200,
      outcome: 'parse-error',
      payload: errorResponse(null, ERROR_CODES.parse, 'Invalid JSON payload. The request body did not parse as JSON.', [
        errorInfo('INVALID_JSON', { detail: String(error?.message ?? error) }),
      ]),
    };
  }

  const { outcome, payload, notification } = handleRequest(request, { digest, newId });
  // JSON-RPC errors ride a 200: the HTTP call succeeded, the RPC did not, and a client that reads
  // the status instead of the envelope would otherwise never see the error it needs to correct.
  return { status: notification ? 204 : 200, outcome, payload: notification ? null : payload };
}
