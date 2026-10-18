/**
 * Web Bot Auth on the way in: what the site can prove about who sent a request.
 *
 * Three states, strongest first, stored as one bounded part of the hit counter's key
 * (VERIFICATION_STATES in src/lib/agent-hits.mjs):
 *
 * | State | What was proved |
 * |---|---|
 * | `signed` | an HTTP Message Signature (RFC 9421) verified against a key the `Signature-Agent` URL publishes |
 * | `ip-verified` | no valid signature, but the address is in a range the client's operator publishes |
 * | `claimed` | nothing: a named client by user agent alone |
 *
 * The protocol is draft-ietf-webbotauth-httpsig-protocol-00 (2026-09-01). Parsing, the signature
 * base and the Ed25519 check are Cloudflare's `web-bot-auth` package, written by the draft's
 * editor; this module owns what the package leaves to the verifier: fetching key material, the
 * cache in front of that fetch, and what a verified signature is allowed to mean here.
 *
 * Four properties are load-bearing, and the first three are the hit counter's own:
 *
 * 1. NOTHING PERSONAL LEAVES THIS MODULE. The caller hands in the address; it is tested against
 *    the committed ranges and dropped. The `Signature-Agent` URL is reduced to a family from a
 *    fixed list. What comes back is `{ family, verification }`, both from bounded lists.
 * 2. FAIL OPEN. identifyRequest() never rejects. A malformed header, a directory that will not
 *    answer, a key that does not verify: each is "not signed", never an error, and the caller runs
 *    this inside `waitUntil`, so nothing here reaches a response.
 * 3. BOUNDED FETCHES. A stranger chooses the `Signature-Agent` URL, so a stranger chooses what this
 *    module fetches. Each key set is fetched at most once per instance per hour, distinct fetches
 *    are capped per hour, and every fetch is HTTPS, redirect-free, time-boxed and size-capped
 *    (draft section 6.7). Past the cap a request is simply not verified.
 * 4. A SIGNATURE PROVES THE SIGNER, NOT THE USER AGENT. A request that says `Googlebot` and verifies
 *    against a key at attacker.example has proved it came from attacker.example. So a verified
 *    signature names a family only through KNOWN_SIGNERS, and lends its weight to the user agent's
 *    family only where that family names no operator (a tool, a browser, an unnamed bot).
 */

import { parseSignatureAgentHeader, verify } from 'web-bot-auth';
import { verifierFromJWK } from 'web-bot-auth/crypto';
import { NO_VERIFICATION, classifyClient, isPageClient } from './agent-hits.mjs';
import { clientKind } from './activity-summary.mjs';
import botRanges from '../data/bot-ranges.json' with { type: 'json' };

/** The well-known path a `directory` member resolves to (draft section 8.1). */
export const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';

/**
 * The `Accept-Signature` value the site sends on /llms.txt (RFC 9421 section 5.1, draft section
 * 5.3): the profile's minimum, one signature over `@authority` and its own `Signature-Agent`
 * member, with `created`, `expires` and `keyid` and the `web-bot-auth` tag. vercel.json carries a
 * copy, because a static file's headers are set there; tests/web-bot-auth.test.mjs diffs the two.
 */
export const ACCEPT_SIGNATURE =
  'sig1=("@authority" "signature-agent";key="sig1");created;expires;keyid;tag="web-bot-auth"';

/**
 * Signers this site recognises by URL, and the family each one vouches for.
 *
 * An identifier is the URL the verifier resolved (draft section 5.5): for a `directory` member the
 * well-known URI at the origin, for `jwks_uri` and `cimd` the member value without query or
 * fragment. A signature that verifies under one of these is attributed to its family whatever the
 * user agent says, which is how ChatGPT agent, which sends a plain Chrome user agent, is counted
 * as itself.
 */
export const KNOWN_SIGNERS = Object.freeze([
  // Google-Agent: "Signature-Agent: g="https://agent.bot.goog"" on a subset of its requests.
  { identifier: `https://agent.bot.goog${DIRECTORY_PATH}`, family: 'google-agent' },
  // ChatGPT agent: every request, "Signature-Agent: "https://chatgpt.com"".
  { identifier: `https://chatgpt.com${DIRECTORY_PATH}`, family: 'chatgpt-agent' },
]);

const SIGNER_FAMILY = new Map(KNOWN_SIGNERS.map(({ identifier, family }) => [identifier, family]));

/** Families with a known signer can only be `signed` through that signer. */
const SIGNED_FAMILIES = new Set(KNOWN_SIGNERS.map(({ family }) => family));

// ── Classification: pure ─────────────────────────────────────────────────────────────────────

/**
 * Every published range, parsed once on first use and grouped by family.
 *
 * @type {Map<string, Array<{ v6: boolean, base: bigint, mask: bigint }>> | null}
 */
let rangesByFamily = null;

function ranges() {
  if (rangesByFamily) return rangesByFamily;
  rangesByFamily = new Map();
  for (const { family, prefixes } of botRanges.sources ?? []) {
    const list = rangesByFamily.get(family) ?? [];
    for (const prefix of prefixes ?? []) {
      const parsed = parseCidr(prefix);
      if (parsed) list.push(parsed);
    }
    rangesByFamily.set(family, list);
  }
  return rangesByFamily;
}

/** Families whose operator publishes ranges, so `ip-verified` is reachable for them at all. */
export function rangeFamilies() {
  return [...ranges().keys()];
}

/**
 * An address as a number and its width, or null. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is read as
 * the IPv4 address it carries, which is how a dual-stack proxy may report one.
 *
 * @param {string} address
 * @returns {{ v6: boolean, value: bigint } | null}
 */
export function parseAddress(address) {
  if (typeof address !== 'string') return null;
  const text = address.trim().toLowerCase();
  const mapped = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return parseAddress(mapped[1]);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    const octets = text.split('.').map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return { v6: false, value: octets.reduce((sum, octet) => (sum << 8n) | BigInt(octet), 0n) };
  }
  if (!/^[0-9a-f:]+$/.test(text) || !text.includes(':')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return { v6: true, value: groups.reduce((sum, group) => (sum << 16n) | BigInt(parseInt(group, 16)), 0n) };
}

/** @param {string} cidr @returns {{ v6: boolean, base: bigint, mask: bigint } | null} */
function parseCidr(cidr) {
  const [address, bitsText] = String(cidr).split('/');
  const parsed = parseAddress(address);
  const bits = Number(bitsText);
  if (!parsed || !Number.isInteger(bits)) return null;
  const width = parsed.v6 ? 128n : 32n;
  if (bits < 0 || BigInt(bits) > width) return null;
  const mask = ((1n << width) - 1n) ^ ((1n << (width - BigInt(bits))) - 1n);
  return { v6: parsed.v6, base: parsed.value & mask, mask };
}

/**
 * Is this address in a range the family's operator publishes? False for a family with no ranges,
 * and for anything that is not an address.
 *
 * @param {string} family @param {string | null | undefined} address
 */
export function inPublishedRange(family, address) {
  const list = ranges().get(family);
  if (!list || !address) return false;
  const parsed = parseAddress(address);
  if (!parsed) return false;
  return list.some((range) => range.v6 === parsed.v6 && (parsed.value & range.mask) === range.base);
}

/**
 * The whole decision, given what was observed. Pure, so the table below is a test rather than a
 * description.
 *
 * | Observed | Family | State |
 * |---|---|---|
 * | signature verified by a KNOWN_SIGNERS identifier | that signer's family | `signed` |
 * | signature verified by any other identifier, user agent names no operator | the user agent's | `signed` |
 * | otherwise, address in the user agent family's published ranges | the user agent's | `ip-verified` |
 * | otherwise, the user agent names a client the counter treats as a bot | the user agent's | `claimed` |
 * | otherwise | the user agent's | none |
 *
 * "Names no operator" is clientKind() other than `agent`: curl, a browser, an unnamed bot. A
 * family with a known signer, or any named crawler, is never `signed` by a stranger's key.
 *
 * @param {{ ua?: string | null, signer?: { identifier: string } | null, address?: string | null }} observed
 * @returns {{ family: string, verification: string }}
 */
export function classifyVerification({ ua, signer = null, address = null }) {
  const uaFamily = classifyClient(ua);
  if (signer) {
    const known = SIGNER_FAMILY.get(signer.identifier);
    if (known) return { family: known, verification: 'signed' };
    if (!SIGNED_FAMILIES.has(uaFamily) && clientKind(uaFamily) !== 'agent') {
      return { family: uaFamily, verification: 'signed' };
    }
  }
  if (inPublishedRange(uaFamily, address)) return { family: uaFamily, verification: 'ip-verified' };
  if (isPageClient(uaFamily)) return { family: uaFamily, verification: 'claimed' };
  return { family: uaFamily, verification: NO_VERIFICATION };
}

// ── Key discovery: bounded fetches ───────────────────────────────────────────────────────────

/** How long a fetched key set is trusted before it is fetched again (draft appendix C.4). */
export const DIRECTORY_TTL_MS = 60 * 60 * 1000;

/** How long a failed fetch is remembered, so a dead directory is not retried per request (C.5). */
export const NEGATIVE_TTL_MS = 5 * 60 * 1000;

/**
 * The cap on distinct key-set fetches per instance per hour.
 *
 * A stranger can name any URL in `Signature-Agent`, so without a cap one client could make this
 * function fetch a new URL on every request. Twenty is several times the number of real signers
 * a site this size will meet in an hour (Google, OpenAI, Steward, a test key or two), and a
 * cached key set costs nothing against it, so the cap only ever bites on someone cycling URLs.
 * Past it a request is not verified, which is undercounting `signed`, never a failed response.
 */
export const MAX_DIRECTORY_FETCHES_PER_HOUR = 20;

/** The most identifiers one instance remembers, positive and negative together. */
const MAX_CACHED_IDENTIFIERS = 64;

/** Per-fetch limits (draft section 6.7). */
const FETCH_TIMEOUT_MS = 2000;
const MAX_KEY_SET_BYTES = 64 * 1024;
const MAX_KEYS = 16;

/** The most signatures tried on one request when it carries several. */
const MAX_SIGNATURES = 4;

/**
 * The RFC 9421 appendix B.1.4 test key. The draft's own test vectors are signed with it, and
 * section 6.8 says a verifier should refuse it in a published directory: anyone holding the RFC
 * holds its private half.
 */
const TEST_KEY_X = new Set(['JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs']);

/**
 * One instance's memory of key sets: identifier to verifiers, with the fetch budget beside it.
 * Exported as a factory so each test starts empty; the middleware uses the module's default.
 */
export function createKeyCache({ now = () => Date.now() } = {}) {
  return {
    now,
    /** @type {Map<string, { verifiers: any[] | null, expires: number, pending?: Promise<any[] | null> }>} */
    entries: new Map(),
    /** @type {number[]} start times of the fetches spent in the last hour */
    fetches: [],
  };
}

const defaultCache = createKeyCache();

/**
 * Is this a URL the verifier may fetch? HTTPS on the default port, a dotted host name rather than
 * an address literal, no credentials. A host that only resolves inside a network is the SSRF the
 * draft warns about; refusing literals and the reserved local names is the part of that check a
 * function without a resolver can make, and the platform's egress does the rest.
 *
 * @param {string} value
 * @returns {URL | null}
 */
export function fetchableUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) return null;
  return url;
}

/**
 * What a `Signature-Agent` member resolves to: the URL to fetch and the identifier the result is
 * known by (draft section 5.5). Null for a member the draft says to ignore.
 *
 * @param {{ uri: string, type: string }} member
 * @returns {{ type: string, fetchUrl: string, identifier: string } | null}
 */
export function resolveMember({ uri, type }) {
  const url = fetchableUrl(uri);
  if (!url) return null;
  if (type === 'directory') {
    // The value MUST be an origin; an empty path or `/` is tolerated, anything else ignored.
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
    const identifier = `${url.origin}${DIRECTORY_PATH}`;
    return { type, fetchUrl: identifier, identifier };
  }
  if (type === 'jwks_uri' || type === 'cimd') {
    return { type, fetchUrl: url.href, identifier: `${url.origin}${url.pathname}` };
  }
  return null;
}

/** Spend one unit of the hourly fetch budget, or report that it is spent. */
function spendFetch(cache) {
  const now = cache.now();
  cache.fetches = cache.fetches.filter((at) => now - at < 60 * 60 * 1000);
  if (cache.fetches.length >= MAX_DIRECTORY_FETCHES_PER_HOUR) return false;
  cache.fetches.push(now);
  return true;
}

/** A body read to at most `limit` bytes, or null past it. */
async function readCapped(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** One budgeted, bounded GET of a JSON document. Null on any failure. */
async function fetchJson(url, cache, fetchImpl, accept) {
  if (!fetchableUrl(url) || !spendFetch(cache)) return null;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: accept },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 200 and nothing else; a redirect is a discovery failure, never followed (draft 5.5).
    if (response.status !== 200) return null;
    const text = await readCapped(response, MAX_KEY_SET_BYTES);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A JWK Set's keys as verifiers, dropping anything the draft says to reject: a set with too many
 * keys, a key the package cannot use, and the RFC's published test key.
 *
 * @param {unknown} keySet
 */
export async function verifiersFromKeySet(keySet) {
  if (!keySet || typeof keySet !== 'object' || !Array.isArray(keySet.keys)) return null;
  if (keySet.keys.length === 0 || keySet.keys.length > MAX_KEYS) return null;
  const verifiers = [];
  for (const jwk of keySet.keys) {
    if (!jwk || typeof jwk !== 'object' || TEST_KEY_X.has(jwk.x)) continue;
    try {
      verifiers.push(await verifierFromJWK(jwk));
    } catch {
      // A key this verifier cannot use is a key it ignores, not a reason to drop the set.
    }
  }
  return verifiers.length > 0 ? verifiers : null;
}

/** Fetch what one member resolves to, as verifiers. Two fetches for a card that names a jwks_uri. */
async function fetchVerifiers(resolved, cache, fetchImpl) {
  if (resolved.type === 'cimd') {
    const card = await fetchJson(resolved.fetchUrl, cache, fetchImpl, 'application/json');
    // A card resolved through its client_id must carry it, identical to the URL fetched (CIMD
    // section 4, Signature Agent Card draft section 3.1.1).
    if (!card || typeof card !== 'object' || card.client_id !== resolved.fetchUrl) return null;
    if (card.jwks && card.jwks_uri) return null;
    if (card.jwks) return verifiersFromKeySet(card.jwks);
    if (typeof card.jwks_uri !== 'string') return null;
    const keySet = await fetchJson(card.jwks_uri, cache, fetchImpl, 'application/jwk-set+json, application/json');
    return verifiersFromKeySet(keySet);
  }
  const accept =
    resolved.type === 'directory'
      ? 'application/http-message-signatures-directory+json'
      : 'application/jwk-set+json, application/json';
  return verifiersFromKeySet(await fetchJson(resolved.fetchUrl, cache, fetchImpl, accept));
}

/**
 * The verifiers an identifier publishes, from cache when fresh.
 *
 * A failed refetch keeps a previously good set rather than evicting it: the draft (section 6.10)
 * is explicit that an operator's outage must not revoke its keys at every verifier at once. A
 * concurrent request for an identifier already being fetched waits on that fetch (appendix C.3).
 *
 * @returns {Promise<any[] | null>}
 */
async function cachedVerifiers(resolved, cache, fetchImpl) {
  const now = cache.now();
  const entry = cache.entries.get(resolved.identifier);
  if (entry?.pending) return entry.pending;
  if (entry && entry.expires > now) return entry.verifiers;

  if (!entry && cache.entries.size >= MAX_CACHED_IDENTIFIERS) {
    cache.entries.delete(cache.entries.keys().next().value);
  }

  const pending = fetchVerifiers(resolved, cache, fetchImpl).catch(() => null);
  cache.entries.set(resolved.identifier, { verifiers: entry?.verifiers ?? null, expires: 0, pending });
  const verifiers = await pending;
  const kept = verifiers ?? entry?.verifiers ?? null;
  cache.entries.set(resolved.identifier, {
    verifiers: kept,
    expires: now + (verifiers ? DIRECTORY_TTL_MS : NEGATIVE_TTL_MS),
  });
  return kept;
}

// ── Verification ─────────────────────────────────────────────────────────────────────────────

/**
 * The top-level member names of a Structured Fields dictionary, read without parsing the members:
 * a name is whatever precedes `=` at depth zero, outside a string.
 *
 * @param {string | null} header
 * @returns {string[]}
 */
export function signatureLabels(header) {
  const labels = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  const text = header ?? '';
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if ((char === ',' && depth === 0) || char === undefined) {
      const member = text.slice(start, index).trim();
      const name = member.match(/^([a-z*][a-z0-9_\-.*]*)/)?.[1];
      if (name) labels.push(name);
      start = index + 1;
    }
  }
  return labels;
}

/**
 * Verify one request's Web Bot Auth signature, or say why not. Resolves to the identifier of the
 * key set that verified it, or null. Never rejects.
 *
 * The key is looked up on the (identifier, keyid) pair, never on the keyid alone (draft section
 * 5.4): the verifier for a request is chosen from what the URL the request covers publishes, so a
 * key learned from one signer can never vouch for another.
 *
 * @param {Request} request
 * @param {{ cache?: ReturnType<typeof createKeyCache>, fetchImpl?: typeof fetch, now?: Date,
 *           verifiersFor?: (resolved: { identifier: string }) => Promise<any[] | null> }} [options]
 *        `verifiersFor` replaces the fetch, for tests that hold the key already.
 * @returns {Promise<{ identifier: string } | null>}
 */
export async function verifyRequestSignature(request, options = {}) {
  const { cache = defaultCache, fetchImpl = fetch, now, verifiersFor } = options;
  try {
    const headers = request.headers;
    if (!headers.get('signature') || !headers.get('signature-input') || !headers.get('signature-agent')) {
      return null;
    }
    // Parsed first so a header the package cannot read ends here, before any key is looked up.
    parseSignatureAgentHeader(headers.get('signature-agent'));

    let identifier = null;
    const attempt = async (label) => {
      await verify(request, {
        label,
        now,
        // A minute either way, for a signer whose clock runs a little ahead of this one.
        clockSkew: 60,
        resolver: async (candidate) => {
          const resolved = candidate.signatureAgent && resolveMember(candidate.signatureAgent);
          if (!resolved) throw new Error('no resolvable Signature-Agent member');
          const verifiers = verifiersFor
            ? await verifiersFor(resolved)
            : await cachedVerifiers(resolved, cache, fetchImpl);
          const verifier = verifiers?.find((candidateVerifier) => candidateVerifier.keyid === candidate.keyid);
          if (!verifier) throw new Error('keyid not published at the Signature-Agent URL');
          identifier = resolved.identifier;
          return verifier;
        },
      });
      return identifier;
    };

    try {
      return { identifier: await attempt(undefined) };
    } catch (error) {
      if (error?.code !== 'LabelRequired') return null;
    }
    // More than one signature on the request, as in the draft's remote-browser example (appendix
    // D.2): the package needs a label, so each one is tried on its own and the first that verifies
    // wins. Capped, so a header with a thousand labels costs a handful of attempts.
    for (const label of signatureLabels(headers.get('signature-input')).slice(0, MAX_SIGNATURES)) {
      try {
        return { identifier: await attempt(label) };
      } catch {
        // The next label.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Everything the counter needs to know about one request's identity, and nothing more. Never
 * rejects, so the middleware can hand the promise to recordHit() unawaited.
 *
 * @param {Request} request
 * @param {{ address?: string | null, cache?: ReturnType<typeof createKeyCache>,
 *           fetchImpl?: typeof fetch, now?: Date }} [options]
 * @returns {Promise<{ family: string, verification: string }>}
 */
export async function identifyRequest(request, { address = null, ...options } = {}) {
  const ua = request.headers.get('user-agent');
  try {
    const signer = await verifyRequestSignature(request, options);
    return classifyVerification({ ua, signer, address });
  } catch {
    return classifyVerification({ ua, address: null });
  }
}
