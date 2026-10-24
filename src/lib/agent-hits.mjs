/**
 * Durable counters for agent traffic: what the middleware increments, and the shape of the keys.
 *
 * Layer two of the agent-hit-counter card. Layer one (src/lib/agent-surfaces.mjs) writes one
 * console line per request, which the dashboard keeps for about an hour; this writes a count that
 * outlives it. The two are deliberately separate failure domains: the log line is the debugging
 * view, the counter is the record, and neither is allowed to break the other or the response.
 *
 * Everything above the transport is pure, so tests/agent-hits.test.mjs can assert the day
 * boundary, the classifier and the key schema without a store and without a deploy. Same split as
 * src/lib/a2a-responder.mjs and src/lib/agent-surfaces.mjs.
 *
 * Three properties are load-bearing and every change here has to preserve them:
 *
 * 1. Nothing personal is stored. Aggregate counts only, keyed by day, event class, client family
 *    and path. The raw user agent is classified and thrown away inside this module; no IP, no
 *    header, no per-request record ever reaches the store. The promise is structural, not a policy.
 *    One more thing is stored since 2026-10-22, and it is the only free-text value in the store:
 *    the hostname of the key directory that verified a Web Bot Auth signature, for a signer
 *    src/lib/web-bot-auth.mjs does not already name. That hostname is an operator's domain, which
 *    the operator publishes so that any site can fetch its keys; it names a company or a service,
 *    never a person, and it is stored alone, with no path, no user agent and no address beside it.
 *    Two more are stored since 2026-10-23, both read off the body of a POST to /mcp and both in
 *    the MCP census (mcpKeyFor() below): the name an MCP client gives itself in `initialize`
 *    (`clientInfo.name`), and the protocol revision it asks for. A client name is the name of a
 *    piece of software, such as an editor, a coding assistant or an inspector tool, chosen by the
 *    people who wrote it and not by the person running it. It is lowercased, cut to 64 characters,
 *    held to a short list of characters and stored alone as a count. The method of each request
 *    is stored too, from a fixed list. No `clientInfo.version`, no argument, no target URL and no
 *    other part of the body is read at all; mcpFactsFrom() is the only function that sees it.
 * 2. Bounded cardinality. Every component of every key comes from a fixed list or is bucketed into
 *    one. Nothing a stranger can send mints a new key. The signer hostname is bucketed by a cap:
 *    MAX_SIGNER_HOSTS_PER_DAY distinct hosts a day, the rest counted as OTHER_SIGNER_HOST. The MCP
 *    client name and protocol revision are bucketed the same way (MAX_MCP_CLIENTS_PER_DAY and
 *    MAX_MCP_VERSIONS_PER_DAY), and the method is one of five.
 * 3. Fail open. A missing env var, a slow store, a 500 from Upstash: all of them are undercounting,
 *    never a failed response. The caller fires this through `waitUntil` and this module never
 *    rejects.
 */

import { AGENT_SURFACE_PATHS, WELL_KNOWN_SURFACE_PATHS } from './agent-surfaces.mjs';
import { PAGE_PATHS } from '../data/page-paths.mjs';

/**
 * Version prefix on every key. A later reshape of the schema writes `v2` beside `v1` and the
 * render layer decides what to do with both; without this, a reshape is a guess about which of two
 * incompatible shapes a given key predates.
 *
 * `v2`, from 2026-10-17, is that reshape: every field gains a fifth part, the request's
 * verification state (VERIFICATION_STATES below). New hits write `v2` keys only. The `v1` keys are
 * never written again and never deleted; the read side reads both and gives every `v1` row the
 * empty state, which is true of it: nothing was checked when it was counted.
 */
export const KEY_VERSION = 'v2';

/** The version every hit before 2026-10-17 was written under. Read, rolled up, never written. */
export const LEGACY_KEY_VERSION = 'v1';

/** Every version a reader has to read, oldest first. */
export const KEY_VERSIONS = Object.freeze([LEGACY_KEY_VERSION, KEY_VERSION]);

/**
 * What the site could prove about who sent a request, strongest first. src/lib/web-bot-auth.mjs
 * decides; this module only stores the answer.
 *
 * | State | Meaning |
 * |---|---|
 * | `signed` | a Web Bot Auth signature verified against the key its operator publishes |
 * | `ip-verified` | no valid signature, but the address is in a range the operator publishes |
 * | `claimed` | a named client by user agent, and nothing else |
 *
 * The empty string is the fourth value: an ordinary visitor, or a client nobody can name. Four
 * values in all, so the new key part keeps property 2.
 */
export const VERIFICATION_STATES = Object.freeze(['signed', 'ip-verified', 'claimed']);

/** The state for a request that is none of the three. */
export const NO_VERIFICATION = '';

const STATES = new Set([...VERIFICATION_STATES, NO_VERIFICATION]);

/** Is this a state the schema stores? Guards the write path against a caller's typo. */
export function isVerificationState(state) {
  return STATES.has(state);
}

/**
 * The three event classes, each a different finding.
 *
 * | Class | What it counts |
 * |---|---|
 * | `surface` | a fetch of one of the site's discovery documents |
 * | `markdown` | a page served as markdown to a client that negotiated for it |
 * | `page` | a NAMED BOT fetching an ordinary HTML page |
 *
 * `page` was added 2026-08-26 and is the only one with a client condition on it. The other two
 * count whatever asked, because asking for llms.txt or for `text/markdown` is itself the agentic
 * act being measured; an ordinary page fetch is not, and counting every one of them would make
 * this a page-view analytics store, which is exactly what property 1 above says it is not. The
 * classifier decides, and only a family in CLIENT_FAMILIES other than `browser` passes: a browser
 * is a person, `other` means the classifier could not tell, and `none` means the client did not
 * say. None of the three is a bot this site can name, so none of them is counted at all.
 */
export const EVENTS = ['surface', 'markdown', 'page'];

/**
 * Buckets are UTC, and the field carries the UTC hour.
 *
 * This is the one place on the site that is not on Matt's local date, and it is deliberate. The
 * vault, the changelog and every rendered timestamp stay America/Vancouver (see CLAUDE.md); that
 * convention is about dates people read, and this is storage.
 *
 * Storing a local day would be a lossy, irreversible choice made at write time: a Vancouver day
 * cannot be re-projected into any other timezone afterwards, and the site's own timezone is not
 * obviously the right frame for a page about who is fetching this site from where. Hour resolution
 * in UTC is strictly more information than either: the render layer reconstructs a Vancouver day,
 * or any other, by summing the right 24 hours, and an hourly trend becomes a rendering rather than
 * a schema change. It also matches every system this data will ever be cross-referenced against,
 * starting with Vercel's own logs.
 *
 * The cost is 24x the fields per day hash in the worst case, which is a few hundred fields on a
 * site this size and still one HGETALL.
 */
export const COUNTER_TIME_ZONE = 'UTC';

/** @param {Date} date @returns {string} YYYY-MM-DD, UTC */
export function counterDay(date) {
  return date.toISOString().slice(0, 10);
}

/** @param {Date} date @returns {string} HH, 00 to 23, UTC */
export function counterHour(date) {
  return date.toISOString().slice(11, 13);
}

/**
 * The client families, as data rather than a switch, so welcoming a new crawler in robots.txt and
 * counting it separately is one line in one list.
 *
 * First match wins, so order is meaningful and there are two ordering rules:
 *
 * - A longer name goes above the shorter one it contains (`applebot-extended` before `applebot`).
 * - The generic-bot catch sits above `browser`, because most crawlers announce themselves inside a
 *   `Mozilla/5.0 (compatible; ...)` string and would otherwise be counted as people.
 *
 * The named entries are the crawlers src/pages/robots.txt.ts explicitly welcomes, kept one family
 * per token rather than grouped by vendor. ClaudeBot and Claude-User are the same company and a
 * completely different finding: one is a training crawl, the other is an agent fetching this page
 * because a person asked it something. Grouping is a render-time decision the store should not
 * make for slice three.
 */
export const CLIENT_FAMILIES = [
  { family: 'gptbot', match: /gptbot/i },
  { family: 'chatgpt-user', match: /chatgpt-user/i },
  { family: 'oai-searchbot', match: /oai-searchbot/i },
  { family: 'claudebot', match: /claudebot/i },
  { family: 'claude-user', match: /claude-user/i },
  { family: 'claude-searchbot', match: /claude-searchbot/i },
  { family: 'anthropic-ai', match: /anthropic-ai/i },
  { family: 'perplexitybot', match: /perplexitybot/i },
  { family: 'perplexity-user', match: /perplexity-user/i },
  // Google's user-triggered agent fetcher. Its user agent is a full Chrome string with the token in
  // a trailing comment, so without this line it classifies as a browser. Some of its requests are
  // signed with Web Bot Auth under https://agent.bot.goog (src/lib/web-bot-auth.mjs).
  { family: 'google-agent', match: /google-agent/i },
  { family: 'google-extended', match: /google-extended/i },
  { family: 'googleother', match: /googleother/i },
  { family: 'googlebot', match: /googlebot/i },
  { family: 'bingbot', match: /bingbot/i },
  { family: 'ccbot', match: /ccbot/i },
  { family: 'bytespider', match: /bytespider/i },
  { family: 'meta-external', match: /meta-external/i },
  { family: 'applebot-extended', match: /applebot-extended/i },
  { family: 'applebot', match: /applebot/i },
  { family: 'cohere-ai', match: /cohere-ai/i },
  { family: 'amazonbot', match: /amazonbot/i },

  // ChatGPT agent sends an ordinary Chrome user agent and signs every request under
  // https://chatgpt.com. It has no `match`: no user agent can claim this family, only a signature
  // that verifies against OpenAI's directory (KNOWN_SIGNERS in src/lib/web-bot-auth.mjs).
  { family: 'chatgpt-agent', match: null },

  // This site's own auditor, which reads 25 pages here every night and audits other people's
  // sites under the same token. Named like any other crawler, and above `other-bot` so the
  // generic robot pattern can never claim it. /steward is the page the string links to.
  { family: 'steward-audit', match: /^steward-audit\//i },

  // The script tells. Somebody at a terminal or a small program is the second most interesting row
  // on this page after the named agents, and it is the one a live agent task usually shows up as.
  { family: 'curl', match: /^curl\//i },
  { family: 'wget', match: /^wget\//i },
  { family: 'python', match: /python-requests|python-httpx|aiohttp|httpx|^python\//i },
  { family: 'node', match: /^node(\.js)?[/ ]|undici|^got\/|axios/i },
  { family: 'go', match: /^go-http-client\//i },

  // Anything that says it is a robot but is not one we named. Above `browser` on purpose.
  { family: 'other-bot', match: /bot\b|crawler|spider|slurp|scrap|fetcher|feed|monitor|http-client/i },

  // A real engine token, not just `Mozilla/5.0`, which every crawler in the list above also sends.
  { family: 'browser', match: /mozilla\/5\.0.*\b(chrome|safari|firefox|edg|opr|trident)\//i },
];

/** Families that are not pattern matches: the two ends of the list. */
export const FALLBACK_FAMILY = 'other';
export const ABSENT_FAMILY = 'none';

/**
 * A user agent in, one bounded family out. This is where the raw string dies: nothing downstream
 * of here has it, which is what makes the privacy promise structural.
 *
 * An absent user agent gets its own family rather than falling into `other`. "Sent no UA at all"
 * is a distinct and common shape for scripted fetchers, and collapsing it into the unknown bucket
 * would throw away the difference between "we could not tell" and "it did not say".
 *
 * @param {string | null | undefined} ua
 * @returns {string}
 */
export function classifyClient(ua) {
  if (!ua || !ua.trim()) return ABSENT_FAMILY;
  const found = CLIENT_FAMILIES.find(({ match }) => match?.test(ua));
  return found ? found.family : FALLBACK_FAMILY;
}

/** Every family that can ever appear in a key. The render layer can build its rows from this. */
export function knownFamilies() {
  return [...CLIENT_FAMILIES.map(({ family }) => family), FALLBACK_FAMILY, ABSENT_FAMILY];
}

const KNOWN_FAMILIES = new Set(knownFamilies());

/**
 * Is this a family the schema stores? A family handed in by a caller, rather than classified here,
 * passes through this first, so a signature-derived family cannot widen the key space either.
 */
export function isKnownFamily(family) {
  return KNOWN_FAMILIES.has(family);
}

/** The one named family that is a person rather than a machine. */
const HUMAN_FAMILY = 'browser';

/**
 * Which families the `page` class will count: every family the list above names except `browser`,
 * and neither of the two fallbacks.
 *
 * Derived from CLIENT_FAMILIES rather than re-listed, so welcoming a new crawler stays the one
 * line the list's own docblock promises. The script tells (`curl`, `python`, `node`, `go`,
 * `wget`) are in, and that is deliberate: none of them is a person reading the page in a browser,
 * and a scripted fetcher reading posts is the shape a live agent task most often arrives in. The
 * render layer already separates a named agent from a tool (clientKind() in
 * src/lib/activity-summary.mjs), so calling them all bots here loses nothing downstream.
 */
export const PAGE_CLIENT_FAMILIES = CLIENT_FAMILIES.map(({ family }) => family).filter(
  (family) => family !== HUMAN_FAMILY
);

const PAGE_CLIENTS = new Set(PAGE_CLIENT_FAMILIES);

/**
 * Is this a client the `page` class counts?
 *
 * The gate is on the CLASSIFIED family, never on the raw user agent, so it inherits the privacy
 * promise rather than reopening it: by the time anything decides, the string is already gone.
 *
 * @param {string} family
 */
export function isPageClient(family) {
  return PAGE_CLIENTS.has(family);
}

/**
 * The MCP endpoint, counted as a surface since 2026-10-23.
 *
 * Not in AGENT_SURFACE_PATHS, which lists the static files the middleware logs: /mcp is a function
 * that counts itself (src/pages/mcp.ts), and listing it there would put it in the middleware's
 * matcher, where a slash rule would 308 a JSON-RPC call. The counter names it here instead.
 */
export const MCP_ENDPOINT_PATH = '/mcp';

/** The surfaces that get a key of their own; anything else under /.well-known/ buckets. */
const NAMED_SURFACES = new Set([...AGENT_SURFACE_PATHS, ...WELL_KNOWN_SURFACE_PATHS, MCP_ENDPOINT_PATH]);
const WELL_KNOWN_PREFIX = '/.well-known/';

/** The bucket for a well-known path the site does not publish. */
export const UNNAMED_WELL_KNOWN = '/.well-known/*';

/** The bucket for any path that fails the shape check below, and for any page the site does not publish. */
export const UNNAMED_PAGE = '/*';

/**
 * Every page path the site publishes, generated at build by scripts/generate-page-paths.mjs.
 *
 * This is the whole bound on the `page` class's key space, and it has to be, because that class is
 * the only one the middleware counts without first learning that the path resolves to anything:
 * `next()` hands the request on and never sees a status, so a stranger asking for a page that does
 * not exist reaches the counter exactly like a crawler reading a real post. A `markdown` serve is
 * bounded instead by its own upstream 200, and a `surface` fetch by a fixed list.
 *
 * A path missing from this set is counted as UNNAMED_PAGE rather than dropped, so a build that ran
 * before a post was published undercounts that post's resolution and nothing else.
 */
const PUBLISHED_PAGES = new Set(PAGE_PATHS);

// A `markdown` path is only ever counted after the middleware has served its markdown sibling, so
// it is already bounded by the pages that exist. These caps are the second lock: if that call site
// ever moves ahead of the upstream check, an attacker still cannot mint keys, only inflate one
// bucket. The `page` class does not rely on them at all — PUBLISHED_PAGES is its bound — and they
// stay in front of it anyway, so the two classes cannot disagree about a path's shape.
const MAX_PATH_LENGTH = 96;
const MAX_PATH_SEGMENTS = 4;
const PAGE_PATH_SHAPE = /^\/[a-z0-9\-/]*$/;

/** Trailing slash tolerated so /llms.txt/ counts as the same surface. Mirrors agent-surfaces.mjs. */
function normalize(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/**
 * The path component of a key, bucketed so the key space stays finite.
 *
 * Three branches for three classes: a `surface` path is one of a fixed list or a well-known
 * bucket; a `markdown` path passes the shape caps; a `page` path passes those AND has to be a page
 * the site publishes, because that class alone reaches here without an upstream 200 behind it.
 *
 * @param {string} event one of EVENTS
 * @param {string} pathname
 * @returns {string}
 */
export function counterPath(event, pathname) {
  const path = normalize(pathname);
  if (event === 'surface') {
    if (NAMED_SURFACES.has(path)) return path;
    if (path.startsWith(WELL_KNOWN_PREFIX)) return UNNAMED_WELL_KNOWN;
    return UNNAMED_PAGE;
  }
  const page = path === '' ? '/' : path;
  if (page.length > MAX_PATH_LENGTH) return UNNAMED_PAGE;
  if (page.split('/').length - 1 > MAX_PATH_SEGMENTS) return UNNAMED_PAGE;
  if (!PAGE_PATH_SHAPE.test(page)) return UNNAMED_PAGE;
  if (event === 'page' && !PUBLISHED_PAGES.has(page)) return UNNAMED_PAGE;
  return page;
}

/** The set holding every UTC day that has a hash, so a reader never has to SCAN. @param {string} [version] */
export function daysKeyFor(version = KEY_VERSION) {
  return `hits:${version}:days`;
}

/** The all-time counter. @param {string} [version] */
export function totalKeyFor(version = KEY_VERSION) {
  return `hits:${version}:total`;
}

/** The hash holding one UTC day. @param {string} day YYYY-MM-DD, UTC @param {string} [version] @returns {string} */
export function dayKeyFor(day, version = KEY_VERSION) {
  return `hits:${version}:day:${day}`;
}

/** The current version's day set and counter, the two keys a hit writes beside its day hash. */
export const DAYS_KEY = daysKeyFor();
export const TOTAL_KEY = totalKeyFor();

/**
 * The rollup keys. Nothing in the write path below ever touches these: they are written by the
 * read path (src/lib/agent-traffic.mjs) when it notices a day old enough that no rendered number
 * can still reach its hours. They live here because the schema lives here, both directions.
 *
 * Month keys sit BESIDE the day keys of the same version rather than reshaping them. A day hash
 * still means exactly what it meant; a month hash is the same counts with the hour dropped, because
 * past the longest rolling window the hour is provably unused (see agent-traffic.mjs for that
 * argument). A `v1` day folds into a `v1` month and a `v2` day into a `v2` month, so neither
 * version's fields are ever rewritten into the other's shape.
 */

/** The set holding every UTC month that has a rollup hash, so a reader never has to SCAN. @param {string} [version] */
export function monthsKeyFor(version = KEY_VERSION) {
  return `hits:${version}:months`;
}

/** The current version's month set. */
export const MONTHS_KEY = monthsKeyFor();

/** The hash holding one rolled-up UTC month. @param {string} month YYYY-MM, UTC @param {string} [version] @returns {string} */
export function monthKeyFor(month, version = KEY_VERSION) {
  return `hits:${version}:month:${month}`;
}

/**
 * The lock a render takes before it moves any day into a month.
 *
 * Still the `v1` name, on purpose, and shared by both versions: during a deploy an old render and a
 * new one can run side by side, both reading `v1` days. One lock between them is what stops the
 * two from folding the same day twice.
 */
export const ROLLUP_LOCK_KEY = `hits:${LEGACY_KEY_VERSION}:rollup`;

/** The UTC month a stored day belongs to. @param {string} day YYYY-MM-DD @returns {string} */
export function monthOf(day) {
  return day.slice(0, 7);
}

/** Is this what the schema calls a month? Guards a key built from whatever SMEMBERS returned. */
export function isCounterMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

/** The field delimiter inside a hash. Cannot appear in an hour, event, family, path, state or host. */
const FIELD_DELIMITER = '|';

// ── Signers ──────────────────────────────────────────────────────────────────────────────────

/**
 * The hash holding one UTC day's verified signatures from signers the site does not name, by the
 * hostname of the key directory that verified them: field `<utc-hour>|<host>`, value a count.
 *
 * A key of its own rather than a sixth part of the day field, because the host is an additional
 * count and not a new dimension of the hit: the hit's own row (family, path, state) is unchanged,
 * and a reader of the day hash never meets a host. The hour leads the field for the same reason it
 * leads a day field: the Signers table's two columns are rolling windows over hour buckets, like
 * every other number the page shows.
 *
 * Only ever written beside a `v2` day hash, so the day set already says which days have one. The
 * rollup deletes it with the day hash rather than folding it: the table has no all-time column, so
 * past the longest window a host count is provably unread, and a host seen for a month is a
 * candidate for KNOWN_SIGNERS, which is the one place an operator is named for good.
 *
 * @param {string} day YYYY-MM-DD, UTC @param {string} [version]
 */
export function signersKeyFor(day, version = KEY_VERSION) {
  return `hits:${version}:signers:${day}`;
}

/**
 * The most distinct signer hosts one UTC day records by name. The 17th and every later one counts
 * as OTHER_SIGNER_HOST.
 *
 * Sixteen is several times the number of real signers a site this size meets in a day, and well
 * under MAX_TABLE_ROWS, so the cap only bites on someone cycling directories. It is enforced from a
 * read of the day's hash just before the write, so a burst of brand-new hosts landing in the same
 * instant can overrun it by a few; the fetch budget in src/lib/web-bot-auth.mjs
 * (MAX_DIRECTORY_FETCHES_PER_HOUR per instance) bounds that burst upstream, because every new host
 * costs the verifier a fetch before it can verify anything.
 */
export const MAX_SIGNER_HOSTS_PER_DAY = 16;

/** The bucket for a signer host past the day's cap. No hostname can be this: it has no dot. */
export const OTHER_SIGNER_HOST = 'other-host';

/** The longest hostname the DNS allows, so a host past it buckets rather than minting a long field. */
const MAX_SIGNER_HOST_LENGTH = 253;

/** What a stored host may look like: a lowercased DNS name. Rules out the delimiter by shape. */
const SIGNER_HOST_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Is this a host the schema stores by name? The bucket passes too, since it is a field the reader
 * has to parse back.
 *
 * @param {unknown} host
 */
export function isSignerHost(host) {
  if (typeof host !== 'string') return false;
  if (host === OTHER_SIGNER_HOST) return true;
  return host.length <= MAX_SIGNER_HOST_LENGTH && SIGNER_HOST_SHAPE.test(host);
}

/**
 * The host a hit's signer is counted under, given the hosts the day has already named.
 *
 * A host already in the day's hash keeps its name whatever the count, so a signer that is seen all
 * day is one row and not sixteen. A new host takes a name while the day has room and the bucket
 * once it does not. A host the schema would not store, or none, is nothing to count.
 *
 * @param {string | null | undefined} host
 * @param {Iterable<string>} seenHosts the hosts already named in the day's signers hash
 * @returns {string | null}
 */
export function signerHostField(host, seenHosts) {
  if (!host || !isSignerHost(host) || host === OTHER_SIGNER_HOST) return null;
  const seen = new Set(seenHosts);
  seen.delete(OTHER_SIGNER_HOST);
  if (seen.has(host) || seen.size < MAX_SIGNER_HOSTS_PER_DAY) return host;
  return OTHER_SIGNER_HOST;
}

/**
 * A signers-hash field, back into its parts. Same contract as parseHitField(): a field that is not
 * exactly what the schema promises is null, and the caller drops it rather than guessing.
 *
 * @param {string} field
 * @returns {{ hour: string, host: string } | null}
 */
export function parseSignerField(field) {
  const parts = field.split(FIELD_DELIMITER);
  if (parts.length !== 2) return null;
  const [hour, host] = parts;
  if (!/^\d{2}$/.test(hour) || !isSignerHost(host)) return null;
  return { hour, host };
}

/** The hosts a signers hash names, from its fields, with the bucket left out. @param {string[]} fields */
export function signerHostsFrom(fields) {
  const hosts = new Set();
  for (const field of fields ?? []) {
    const parsed = parseSignerField(String(field));
    if (parsed && parsed.host !== OTHER_SIGNER_HOST) hosts.add(parsed.host);
  }
  return hosts;
}

// ── MCP census ───────────────────────────────────────────────────────────────────────────────

/**
 * The hash holding one UTC day of POSTs to /mcp, counted by what the body says rather than by who
 * sent it. Two kinds of field, told apart by their second part:
 *
 * | Field | Counts |
 * |---|---|
 * | `<utc-hour>\|method\|<method>` | every POST, under its JSON-RPC method |
 * | `<utc-hour>\|client\|<name>\|<protocol-version>` | every `initialize`, under the client name and the revision it gave |
 *
 * A key of its own for the reason the signers hash is one: these are second counts of a request
 * that is already in the day hash as a `surface` hit on `/mcp`, so folding them into that hash
 * would count the request twice in every total. The hour leads the field so the census tables'
 * columns are rolling windows over hour buckets, like every other number the page shows.
 *
 * The name and the revision share a field because the Clients table reads them as a pair: one
 * client asking for two revisions is two rows. The cost is that the two caps multiply, 17 by 17 at
 * most a day, which is still a bound.
 *
 * Written beside a `v2` day set entry, and the rollup deletes it with the day hash rather than
 * folding it: the tables have no all-time column, so past the longest window a census count is
 * provably unread.
 *
 * @param {string} day YYYY-MM-DD, UTC @param {string} [version]
 */
export function mcpKeyFor(day, version = KEY_VERSION) {
  return `hits:${version}:mcp:${day}`;
}

/**
 * The JSON-RPC methods the census names. Every other method, a notification, and a body that is
 * not a JSON-RPC request at all count as OTHER_MCP_METHOD, so the method part of a field is one of
 * five values whatever a caller sends.
 *
 * `server/discover` is the discovery request of the 2026-07-28 protocol revision. This server does
 * not answer it yet; counting it is how the revision card learns how many clients already ask.
 */
export const MCP_METHODS = Object.freeze(['initialize', 'tools/list', 'tools/call', 'server/discover']);

/** The bucket for any other method. */
export const OTHER_MCP_METHOD = 'other-method';

const COUNTED_MCP_METHODS = new Set([...MCP_METHODS, OTHER_MCP_METHOD]);

/** The most distinct client names one UTC day records by name. The 17th and later count as OTHER_MCP_CLIENT. */
export const MAX_MCP_CLIENTS_PER_DAY = 16;

/** The most distinct protocol revisions one UTC day records by name, capped the same way. */
export const MAX_MCP_VERSIONS_PER_DAY = 16;

/** The bucket for a client name past the day's cap. */
export const OTHER_MCP_CLIENT = 'other-client';

/** The bucket for a protocol revision past the day's cap. */
export const OTHER_MCP_VERSION = 'other-version';

/** An `initialize` that gave no usable client name. A finding on its own: the client did not identify itself. */
export const UNNAMED_MCP_CLIENT = 'unnamed';

/** An `initialize` that gave no usable protocol revision. */
export const UNSTATED_MCP_VERSION = 'unstated';

/** The longest client name stored. A longer one is cut, not refused. */
const MAX_MCP_CLIENT_NAME_LENGTH = 64;

/**
 * What a stored client name may look like: lowercase ASCII letters and digits, and a few marks that
 * software names use. Rules out the field delimiter by shape.
 */
const MCP_CLIENT_NAME_SHAPE = /^[a-z0-9 ._\-/+@:()]{1,64}$/;

/** What a stored protocol revision may look like. A date such as 2025-06-18 fits; so does a draft tag. */
const MCP_VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * A client name as the census stores it: lowercased, cut to 64 characters, any character outside
 * the short list above replaced by an underscore, and the empty string and a non-string both
 * UNNAMED_MCP_CLIENT.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanMcpClientName(raw) {
  if (typeof raw !== 'string') return UNNAMED_MCP_CLIENT;
  const cleaned = raw
    .toLowerCase()
    .slice(0, MAX_MCP_CLIENT_NAME_LENGTH)
    .replace(/[^a-z0-9 ._\-/+@:()]/g, '_')
    .trim();
  return cleaned || UNNAMED_MCP_CLIENT;
}

/**
 * A protocol revision as the census stores it: as given when it has the shape of one, and
 * UNSTATED_MCP_VERSION when it is missing or does not.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanMcpProtocolVersion(raw) {
  return typeof raw === 'string' && MCP_VERSION_SHAPE.test(raw) ? raw : UNSTATED_MCP_VERSION;
}

/**
 * The three facts the census keeps from one POST body, and the only code that reads the body.
 * Everything else in it, arguments, target URLs, `clientInfo.version`, capabilities, dies here, the
 * way a user agent dies in classifyClient().
 *
 * `clientName` and `protocolVersion` are present for an `initialize` and null for every other
 * method. A body that is not an object, is an array, or has no string `method` is OTHER_MCP_METHOD:
 * the request is still a data point, and the census does not guess what it was.
 *
 * @param {unknown} body the parsed JSON, or undefined when the body did not parse
 * @returns {{ method: string, clientName: string | null, protocolVersion: string | null }}
 */
export function mcpFactsFrom(body) {
  const message = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : null;
  const method = typeof message?.method === 'string' && MCP_METHODS.includes(message.method) ? message.method : OTHER_MCP_METHOD;
  if (method !== 'initialize') return { method, clientName: null, protocolVersion: null };
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const info = params.clientInfo && typeof params.clientInfo === 'object' ? params.clientInfo : {};
  return {
    method,
    clientName: cleanMcpClientName(info.name),
    protocolVersion: cleanMcpProtocolVersion(params.protocolVersion),
  };
}

/**
 * An MCP-hash field, back into its parts. Same contract as parseHitField(): a field that is not
 * exactly what the schema promises is null, and the caller drops it rather than guessing.
 *
 * @param {string} field
 * @returns {{ hour: string, kind: 'method', method: string }
 *   | { hour: string, kind: 'client', name: string, protocolVersion: string } | null}
 */
export function parseMcpField(field) {
  const parts = field.split(FIELD_DELIMITER);
  const [hour, kind] = parts;
  if (!/^\d{2}$/.test(hour ?? '')) return null;
  if (kind === 'method' && parts.length === 3) {
    return COUNTED_MCP_METHODS.has(parts[2]) ? { hour, kind, method: parts[2] } : null;
  }
  if (kind === 'client' && parts.length === 4) {
    const [, , name, protocolVersion] = parts;
    if (!MCP_CLIENT_NAME_SHAPE.test(name) || name !== name.trim() || !MCP_VERSION_SHAPE.test(protocolVersion)) return null;
    return { hour, kind, name, protocolVersion };
  }
  return null;
}

/**
 * The client names and revisions an MCP hash already names, from its fields, with the buckets left
 * out. The caps count these.
 *
 * @param {string[]} fields
 * @returns {{ names: Set<string>, versions: Set<string> }}
 */
export function mcpNamedFrom(fields) {
  const names = new Set();
  const versions = new Set();
  for (const field of fields ?? []) {
    const parsed = parseMcpField(String(field));
    if (parsed?.kind !== 'client') continue;
    if (parsed.name !== OTHER_MCP_CLIENT && parsed.name !== UNNAMED_MCP_CLIENT) names.add(parsed.name);
    if (parsed.protocolVersion !== OTHER_MCP_VERSION && parsed.protocolVersion !== UNSTATED_MCP_VERSION) {
      versions.add(parsed.protocolVersion);
    }
  }
  return { names, versions };
}

/**
 * The name a client is counted under, given the names the day has already recorded. A name already
 * recorded keeps it whatever the count; a new one takes it while the day has room and is the bucket
 * once it does not. The two fixed buckets are never counted towards the cap. The revision follows
 * the same rule against its own cap.
 *
 * @param {{ clientName: string, protocolVersion: string }} facts
 * @param {{ names: Iterable<string>, versions: Iterable<string> }} seen
 * @returns {{ name: string, protocolVersion: string }}
 */
export function mcpClientField({ clientName, protocolVersion }, { names, versions }) {
  const seenNames = new Set(names);
  const seenVersions = new Set(versions);
  for (const bucket of [OTHER_MCP_CLIENT, UNNAMED_MCP_CLIENT]) seenNames.delete(bucket);
  for (const bucket of [OTHER_MCP_VERSION, UNSTATED_MCP_VERSION]) seenVersions.delete(bucket);
  const nameFixed = clientName === UNNAMED_MCP_CLIENT || clientName === OTHER_MCP_CLIENT;
  const versionFixed = protocolVersion === UNSTATED_MCP_VERSION || protocolVersion === OTHER_MCP_VERSION;
  return {
    name: nameFixed || seenNames.has(clientName) || seenNames.size < MAX_MCP_CLIENTS_PER_DAY ? clientName : OTHER_MCP_CLIENT,
    protocolVersion:
      versionFixed || seenVersions.has(protocolVersion) || seenVersions.size < MAX_MCP_VERSIONS_PER_DAY
        ? protocolVersion
        : OTHER_MCP_VERSION,
  };
}

/**
 * The commands that count one POST to /mcp: its method, its client when it is an `initialize`, and
 * the day's entry in the day set so a reader that starts from the set finds the hash even when the
 * request's own `surface` hit (recordHit) was the write that failed.
 *
 * @param {{ method: string, clientName: string | null, protocolVersion: string | null }} facts
 * @param {{ names: Iterable<string>, versions: Iterable<string> }} seen
 * @param {Date} now
 * @returns {{ day: string, methodField: string, clientField: string | null, commands: string[][] }}
 */
export function mcpCensusKeys(facts, seen, now = new Date()) {
  const day = counterDay(now);
  const hour = counterHour(now);
  const key = mcpKeyFor(day);
  const methodField = [hour, 'method', facts.method].join(FIELD_DELIMITER);
  const counted =
    facts.clientName !== null && facts.protocolVersion !== null
      ? mcpClientField({ clientName: facts.clientName, protocolVersion: facts.protocolVersion }, seen)
      : null;
  const clientField = counted ? [hour, 'client', counted.name, counted.protocolVersion].join(FIELD_DELIMITER) : null;

  const commands = [['HINCRBY', key, methodField, '1']];
  if (clientField) commands.push(['HINCRBY', key, clientField, '1']);
  commands.push(['SADD', DAYS_KEY, day]);
  return { day, methodField, clientField, commands };
}

/** How many parts a field has, per version and hash kind. */
const DAY_FIELD_PARTS = Object.freeze({ v1: 4, v2: 5 });
const MONTH_FIELD_PARTS = Object.freeze({ v1: 3, v2: 4 });

/**
 * A day-hash field, back into its parts. The inverse of the `field` built in hitKeys(), and the
 * reason src/lib/agent-traffic.mjs never rebuilds the schema: both directions live here, so a
 * reshape of the key is one file rather than a hunt.
 *
 * A field that does not split into exactly the parts its version promises is returned as null
 * rather than guessed at. The only way one can exist is a schema change that forgot to bump
 * KEY_VERSION, and a reader dropping the row it cannot parse beats a reader inventing a path from
 * it. A `v1` field parses with the empty verification state, which is what it is.
 *
 * @param {string} field
 * @param {string} [version]
 * @returns {{ hour: string, event: string, family: string, path: string, verification: string } | null}
 */
export function parseHitField(field, version = KEY_VERSION) {
  const parts = field.split(FIELD_DELIMITER);
  if (parts.length !== DAY_FIELD_PARTS[version]) return null;
  const [hour, event, family, path, verification = NO_VERIFICATION] = parts;
  if (!/^\d{2}$/.test(hour) || !EVENTS.includes(event) || !family || !path) return null;
  if (!isVerificationState(verification)) return null;
  return { hour, event, family, path, verification };
}

/**
 * A day-hash row, as the month-hash field it rolls up into: the same components with the hour
 * dropped. One part fewer than the day field of the same version, which is what makes the two
 * shapes impossible to confuse within a version.
 *
 * @param {{ event: string, family: string, path: string, verification?: string }} row
 * @param {string} [version]
 * @returns {string}
 */
export function monthFieldFor({ event, family, path, verification = NO_VERIFICATION }, version = KEY_VERSION) {
  const parts = version === LEGACY_KEY_VERSION ? [event, family, path] : [event, family, path, verification];
  return parts.join(FIELD_DELIMITER);
}

/**
 * A month-hash field, back into its parts. Same contract as parseHitField(): a field that is not
 * exactly what the schema promises is returned as null and dropped by the caller, never guessed at.
 *
 * @param {string} field
 * @param {string} [version]
 * @returns {{ event: string, family: string, path: string, verification: string } | null}
 */
export function parseMonthField(field, version = KEY_VERSION) {
  const parts = field.split(FIELD_DELIMITER);
  if (parts.length !== MONTH_FIELD_PARTS[version]) return null;
  const [event, family, path, verification = NO_VERIFICATION] = parts;
  if (!EVENTS.includes(event) || !family || !path) return null;
  if (!isVerificationState(verification)) return null;
  return { event, family, path, verification };
}

/**
 * The whole key schema, in one function, so the render layer reads it from here rather than
 * rebuilding string literals that can drift.
 *
 * Three keys per hit, because every later rendering should be a read rather than a regret:
 *
 * | Key | Type | Answers |
 * |---|---|---|
 * | `hits:v2:day:<utc-day>` | hash, field `<utc-hour>\|<event>\|<family>\|<path>\|<verification>` | everything about one UTC day, at hour resolution, in one HGETALL |
 * | `hits:v2:days` | set of UTC days | which days exist, so a trend view never has to SCAN |
 * | `hits:v2:total` | counter | the one number the retro homepage widget wants |
 *
 * And three more that no hit ever writes, added 2026-08-06 so a render's cost stops growing with
 * the site's age. The read path writes them; see src/lib/agent-traffic.mjs.
 *
 * | Key | Type | Answers |
 * |---|---|---|
 * | `hits:v2:month:<utc-month>` | hash, field `<event>\|<family>\|<path>\|<verification>` | one whole UTC month, hour dropped, in one HGETALL |
 * | `hits:v2:months` | set of UTC months | which months exist, the month set's twin |
 * | `hits:v1:rollup` | string with a TTL | the lock one render holds while it folds days into a month, for both versions |
 *
 * And one more, since 2026-10-22, written by a hit only when its signature verified under a signer
 * the site does not name (signersKeyFor() above says why it is a key of its own):
 *
 * | Key | Type | Answers |
 * |---|---|---|
 * | `hits:v2:signers:<utc-day>` | hash, field `<utc-hour>\|<host>` | which key directories verified the day's unnamed signers, and how often |
 *
 * And one more, since 2026-10-23, written by recordMcpRequest() for every POST to /mcp rather than
 * by a hit (mcpKeyFor() above says what its two kinds of field count):
 *
 * | Key | Type | Answers |
 * |---|---|---|
 * | `hits:v2:mcp:<utc-day>` | hash, field `<utc-hour>\|method\|<method>` or `<utc-hour>\|client\|<name>\|<revision>` | which JSON-RPC methods clients send /mcp, and which clients and protocol revisions open a session |
 *
 * The `v1` keys have the same shape with the verification part absent: four parts in a day field,
 * three in a month field. They hold every hit from 2026-07-21 to 2026-10-17.
 *
 * The hour leads the field so a prefix match answers "this hour" without parsing, and so the
 * fields of a day sort into chronological order.
 *
 * A day's hash holds at most (24 hours x 3 events x ~30 families x ~60 paths x 4 states) fields
 * and realistically a few dozen, so one round trip answers totals, per-client, per-path and
 * per-hour for any window, in any timezone. Nothing expires and nothing is thrown away: a day past
 * every rolling window is folded into its month rather than deleted, so the all-time numbers are
 * unchanged and only the hour, which nothing renders at that age, is gone.
 *
 * The field delimiter is `|`, which cannot appear in an hour, an event, a family, a bucketed path
 * or a state.
 *
 * `family`, `verification` and `signerHost` are optional and come from src/lib/web-bot-auth.mjs,
 * which can name a family from a verified signature where the user agent names none. A family or
 * state that is not in the schema's own lists is replaced by what the user agent alone would give,
 * so a caller cannot mint a key part either. A signer host is counted under signerHostField(),
 * given the hosts the day has already named (`seenSignerHosts`, read by recordHit()); with a host
 * the commands gain a fourth, the HINCRBY on the day's signers hash.
 *
 * @param {{ event: string, path: string, ua?: string | null, family?: string,
 *           verification?: string, signerHost?: string | null, seenSignerHosts?: Iterable<string>,
 *           now?: Date }} hit
 * @returns {{ day: string, hour: string, event: string, family: string, path: string,
 *             verification: string, field: string, signerHost: string | null,
 *             signerField: string | null, dayKey: string, daysKey: string, totalKey: string,
 *             signersKey: string, commands: string[][] }}
 */
export function hitKeys({ event, path, ua, family, verification, signerHost = null, seenSignerHosts = [], now = new Date() }) {
  if (!EVENTS.includes(event)) throw new Error(`unknown event class: ${event}`);
  const day = counterDay(now);
  const hour = counterHour(now);
  const countedFamily = family && isKnownFamily(family) ? family : classifyClient(ua);
  const state = verification && isVerificationState(verification) ? verification : NO_VERIFICATION;
  const countedPath = counterPath(event, path);
  const field = [hour, event, countedFamily, countedPath, state].join(FIELD_DELIMITER);
  const countedHost = signerHostField(signerHost, seenSignerHosts);
  const signerField = countedHost ? [hour, countedHost].join(FIELD_DELIMITER) : null;

  const dayKey = dayKeyFor(day);
  const daysKey = DAYS_KEY;
  const totalKey = TOTAL_KEY;
  const signersKey = signersKeyFor(day);

  const commands = [
    ['HINCRBY', dayKey, field, '1'],
    ['SADD', daysKey, day],
    ['INCR', totalKey],
  ];
  if (signerField) commands.push(['HINCRBY', signersKey, signerField, '1']);

  return {
    day,
    hour,
    event,
    family: countedFamily,
    path: countedPath,
    verification: state,
    field,
    signerHost: countedHost,
    signerField,
    dayKey,
    daysKey,
    totalKey,
    signersKey,
    commands,
  };
}

/**
 * Where the store lives. Both name pairs are read because the Vercel marketplace has shipped
 * Upstash under both over the years, and which one a project got depends on when it was
 * provisioned. Absent means counting is off, which is a supported state: local dev never needs a
 * store, and this PR is mergeable before the integration exists.
 *
 * @param {Record<string, string | undefined>} env
 */
export function readStoreConfig(env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

/** One request's worth of budget. Past this the count is lost, which is the correct trade. */
const STORE_TIMEOUT_MS = 1500;

/**
 * Count one hit. Never throws, never rejects, and returns what it did so a test can assert the
 * env-absent path made no network call at all.
 *
 * The caller fires this through `waitUntil` so the response is already on its way out; the
 * try/catch here is belt to that braces, because a throw inside a `waitUntil` argument happens
 * before `waitUntil` ever sees a promise.
 *
 * `identity` is the verification result for this request, or a promise of it: the middleware
 * hands in identifyRequest() from src/lib/web-bot-auth.mjs unawaited, so a directory fetch runs
 * inside the same `waitUntil` as the count and never in front of the response. A rejected or
 * malformed identity falls back to the user agent alone.
 *
 * An identity with a `signerHost` costs one more round trip before the write: the hosts the day
 * has already named, so the cap in signerHostField() can be applied. That read fails open on its
 * own: if it does not answer, the hit is still counted and only the host is not.
 *
 * @param {{ event: string, path: string, ua?: string | null, now?: Date,
 *           identity?: { family?: string, verification?: string, signerHost?: string | null }
 *             | Promise<{ family?: string, verification?: string, signerHost?: string | null }>,
 *           env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} hit
 * @returns {Promise<{ ok: boolean, reason?: string, field?: string, day?: string,
 *                     signerField?: string | null }>}
 */
export async function recordHit({ event, path, ua, now, identity, env = process.env, fetchImpl = fetch }) {
  let keys;
  try {
    const { family, verification, signerHost = null } = await settleIdentity(identity);
    const countedFamily = family && isKnownFamily(family) ? family : classifyClient(ua);

    // Before the store is even looked up, so the bots-only rule holds in every environment and a
    // test can assert that a browser's page view attempted no network call at all. A page view by
    // a person is not undercounted here, it is not counted: see the EVENTS table above. The family
    // is the verified one when there is one, so an agent with a browser's user agent that proves
    // who it is by signature is counted as the agent it proved to be.
    if (event === 'page' && !isPageClient(countedFamily)) {
      return { ok: false, reason: 'not-a-bot' };
    }

    const store = readStoreConfig(env);
    if (!store) return { ok: false, reason: 'no-store' };

    const at = now ?? new Date();
    const seenSignerHosts = isSignerHost(signerHost) ? await readSignerHosts(store, counterDay(at), fetchImpl) : null;
    keys = hitKeys({
      event,
      path,
      ua,
      family: countedFamily,
      verification,
      // A read that did not answer records no host: the hit itself is still counted below.
      signerHost: seenSignerHosts ? signerHost : null,
      seenSignerHosts: seenSignerHosts ?? [],
      now: at,
    });

    const response = await pipeline(store, keys.commands, fetchImpl);

    if (!response.ok) {
      return { ok: false, reason: `status-${response.status}`, field: keys.field, day: keys.day, signerField: keys.signerField };
    }
    return { ok: true, field: keys.field, day: keys.day, signerField: keys.signerField };
  } catch (error) {
    // Deliberately swallowed, per the posture this inherits from the middleware's surface branch:
    // observation is never worth a failed response. Undercounting is the acceptable failure.
    return { ok: false, reason: error instanceof Error ? error.name : 'error', field: keys?.field };
  }
}

/** One POST to the store's pipeline endpoint, within this module's budget. */
function pipeline(store, commands, fetchImpl) {
  return fetchImpl(`${store.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${store.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
  });
}

/**
 * The hosts a day's signers hash already names, or null when the store did not say.
 *
 * Its own try/catch, so the one extra read a signed hit costs can never be why the hit itself went
 * uncounted. Null and an empty set are different answers: an empty hash means the host is the
 * day's first and takes a name; null means the cap cannot be applied, so no host is written.
 *
 * @param {{ url: string, token: string }} store @param {string} day @param {typeof fetch} fetchImpl
 * @returns {Promise<Set<string> | null>}
 */
async function readSignerHosts(store, day, fetchImpl) {
  try {
    const response = await pipeline(store, [['HKEYS', signersKeyFor(day)]], fetchImpl);
    if (!response.ok) return null;
    const payload = await response.json();
    const fields = Array.isArray(payload) ? payload[0]?.result : null;
    if (!Array.isArray(fields)) return null;
    return signerHostsFrom(fields);
  } catch {
    return null;
  }
}

/**
 * Count one POST to /mcp in the census. Never throws, never rejects, and returns what it did so a
 * test can assert the env-absent path made no network call at all.
 *
 * The route fires this through `waitUntil` beside its recordHit() call (src/pages/mcp.ts), so the
 * write never delays the response, and every request is counted: a refused batch, a body that did
 * not parse and a rate-limited call included, because the refusal is the data point.
 *
 * An `initialize` costs one more round trip before the write, the client names and revisions the
 * day has already recorded, so the caps in mcpClientField() can be applied. That read fails open on
 * its own: if it does not answer, the method is still counted and only the client is not. The cap is
 * enforced from a read just before the write, so a burst of brand-new names landing in the same
 * instant can overrun it by the number of requests in flight; the tables cut at MAX_TABLE_ROWS and
 * say how many rows they left out, so the page stays a table.
 *
 * @param {{ body: unknown, now?: Date, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} request
 * @returns {Promise<{ ok: boolean, reason?: string, methodField?: string, clientField?: string | null }>}
 */
export async function recordMcpRequest({ body, now, env = process.env, fetchImpl = fetch }) {
  try {
    const store = readStoreConfig(env);
    if (!store) return { ok: false, reason: 'no-store' };

    const facts = mcpFactsFrom(body);
    const at = now ?? new Date();
    const seen = facts.clientName === null ? null : await readMcpNamed(store, counterDay(at), fetchImpl);
    // A read that did not answer records no client: the method is still counted below.
    const keys = mcpCensusKeys(seen ? facts : { ...facts, clientName: null, protocolVersion: null }, seen ?? { names: [], versions: [] }, at);

    const response = await pipeline(store, keys.commands, fetchImpl);
    if (!response.ok) return { ok: false, reason: `status-${response.status}`, methodField: keys.methodField, clientField: keys.clientField };
    return { ok: true, methodField: keys.methodField, clientField: keys.clientField };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'error' };
  }
}

/**
 * The names and revisions a day's MCP hash already records, or null when the store did not say.
 * Its own try/catch, for the reason readSignerHosts() has one.
 *
 * @param {{ url: string, token: string }} store @param {string} day @param {typeof fetch} fetchImpl
 * @returns {Promise<{ names: Set<string>, versions: Set<string> } | null>}
 */
async function readMcpNamed(store, day, fetchImpl) {
  try {
    const response = await pipeline(store, [['HKEYS', mcpKeyFor(day)]], fetchImpl);
    if (!response.ok) return null;
    const payload = await response.json();
    const fields = Array.isArray(payload) ? payload[0]?.result : null;
    if (!Array.isArray(fields)) return null;
    return mcpNamedFrom(fields);
  } catch {
    return null;
  }
}

/** An identity, awaited, with a rejection turned into "nothing was proved". */
async function settleIdentity(identity) {
  try {
    const settled = await identity;
    return settled && typeof settled === 'object' ? settled : {};
  } catch {
    return {};
  }
}
