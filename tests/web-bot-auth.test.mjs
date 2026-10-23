import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sign } from 'web-bot-auth';
import { signerFromJWK, verifierFromJWK } from 'web-bot-auth/crypto';
import {
  ACCEPT_SIGNATURE,
  DIRECTORY_PATH,
  KNOWN_SIGNERS,
  MAX_DIRECTORY_FETCHES_PER_HOUR,
  NEGATIVE_TTL_MS,
  DIRECTORY_TTL_MS,
  classifyVerification,
  createKeyCache,
  fetchableUrl,
  identifyRequest,
  inPublishedRange,
  parseAddress,
  rangeFamilies,
  resolveMember,
  signatureLabels,
  signerHostFor,
  verifiersFromKeySet,
  verifyRequestSignature,
} from '../src/lib/web-bot-auth.mjs';
import { isKnownFamily } from '../src/lib/agent-hits.mjs';
import { SOURCES, normaliseRangeList, renderRangesModule } from '../scripts/refresh-bot-ranges.mjs';
import { BOT_RANGES } from '../src/data/bot-ranges.mjs';

// Web Bot Auth on the way in. No test here touches the network: every key set is served by a
// fetch stand-in, and every key is either the RFC 9421 test key (public half only, for the draft's
// own vectors) or a throwaway pair generated when the test runs.

const botRanges = BOT_RANGES;
const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const GOOGLE_AGENT =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)';

/** A fresh Ed25519 pair, made now and gone when the test ends. */
async function throwawayKey() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  // Node exports `alg: "Ed25519"` (the newer JOSE name); the package accepts `EdDSA` or none.
  const { kty, crv, x, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { privateJwk: { kty, crv, x, d }, publicJwk: { kty, crv, x } };
}

/**
 * A request signed the way a Web Bot Auth client signs one: @authority, @path and the
 * Signature-Agent member, created now and expiring in five minutes.
 */
async function signedRequest({ url, privateJwk, agent, label = 'sig1', ua = 'curl/8.7.1', now = new Date() }) {
  const unsigned = new Request(url, { headers: { 'Signature-Agent': agent, 'User-Agent': ua } });
  const fields = await sign(unsigned, {
    signer: await signerFromJWK(privateJwk),
    label,
    created: now,
    expires: new Date(now.getTime() + 300_000),
    additionalComponents: ['@path'],
  });
  return new Request(url, {
    headers: {
      'User-Agent': ua,
      'Signature-Agent': agent,
      'Signature-Input': fields.signatureInput,
      Signature: fields.signature,
    },
  });
}

/** A fetch stand-in that serves fixed documents by URL and records what was asked for. */
function documents(byUrl) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const doc = byUrl[String(url)];
    if (!doc) return new Response('not found', { status: 404 });
    if (doc instanceof Response) return doc;
    return new Response(JSON.stringify(doc.body ?? doc), {
      status: doc.status ?? 200,
      headers: { 'Content-Type': doc.type ?? 'application/http-message-signatures-directory+json' },
    });
  };
  impl.calls = calls;
  return impl;
}

// ── The draft's own test vectors ─────────────────────────────────────────────────────────────

// RFC 9421 appendix B.1.4, public half. The draft's EdDSA vectors (appendix E.2) are signed with it.
const RFC_TEST_KEY = { kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' };
const VECTOR_CREATED = new Date(1735689600 * 1000);

// The vectors' keyid, the test key's public thumbprint, joined at run time: as one literal beside
// the word `keyid` it reads to the gitleaks generic-api-key rule as a secret, which it is not.
const VECTOR_KEY_THUMBPRINT = ['poqkLGiymh_W0uP6PZFw', 'dvez3QJT5SolqXBCW38r0U'].join('-');

const VECTOR_E21 = {
  'Signature-Agent': 'agent2="https://signature-agent.test"',
  'Signature-Input': `sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="${VECTOR_KEY_THUMBPRINT}";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"`,
  Signature: 'sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:',
};

const VECTOR_E22 = {
  'Signature-Agent': '"https://signature-agent.test"',
  'Signature-Input': `sig2=("@authority" "signature-agent");created=1735689600;keyid="${VECTOR_KEY_THUMBPRINT}";alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==";tag="web-bot-auth"`,
  Signature: 'sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:',
};

/** The vectors hold the key already, so the lookup is the key itself, not a fetch. */
const holdsTestKey = async () => [await verifierFromJWK(RFC_TEST_KEY)];

test('draft vector E.2.1, the dictionary Signature-Agent, verifies', async () => {
  const request = new Request('https://example.com/', { headers: VECTOR_E21 });
  const result = await verifyRequestSignature(request, { now: VECTOR_CREATED, verifiersFor: holdsTestKey });
  assert.deepEqual(result, { identifier: `https://signature-agent.test${DIRECTORY_PATH}` });
});

test('draft vector E.2.2, the legacy string Signature-Agent, verifies', async () => {
  const request = new Request('https://example.com/', { headers: VECTOR_E22 });
  const result = await verifyRequestSignature(request, { now: VECTOR_CREATED, verifiersFor: holdsTestKey });
  assert.deepEqual(result, { identifier: `https://signature-agent.test${DIRECTORY_PATH}` });
});

test('a vector with one byte of its signature altered does not verify', async () => {
  const altered = { ...VECTOR_E21, Signature: VECTOR_E21.Signature.replace('RdNF', 'RdNG') };
  const request = new Request('https://example.com/', { headers: altered });
  assert.equal(await verifyRequestSignature(request, { now: VECTOR_CREATED, verifiersFor: holdsTestKey }), null);
});

test('a vector replayed against another authority does not verify', async () => {
  const request = new Request('https://www.mattpyle.com/', { headers: VECTOR_E21 });
  assert.equal(await verifyRequestSignature(request, { now: VECTOR_CREATED, verifiersFor: holdsTestKey }), null);
});

test('the RFC test key is refused when a directory publishes it', async () => {
  // Draft section 6.8: anyone holding RFC 9421 holds its private half.
  assert.equal(await verifiersFromKeySet({ keys: [RFC_TEST_KEY] }), null);
});

// ── A throwaway key, end to end through the fetch ────────────────────────────────────────────

test('a request signed with a throwaway key verifies against the directory its URL names', async () => {
  const { privateJwk, publicJwk } = await throwawayKey();
  const request = await signedRequest({
    url: 'https://www.mattpyle.com/llms.txt',
    privateJwk,
    agent: 'sig1="https://signer.example"',
  });
  const fetchImpl = documents({ [`https://signer.example${DIRECTORY_PATH}`]: { keys: [publicJwk] } });

  const identity = await identifyRequest(request, { cache: createKeyCache(), fetchImpl });
  assert.deepEqual(identity, { family: 'curl', verification: 'signed', signerHost: 'signer.example' });

  // One fetch, of the well-known URI, asking for the directory media type, refusing redirects.
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `https://signer.example${DIRECTORY_PATH}`);
  assert.equal(fetchImpl.calls[0].init.headers.Accept, 'application/http-message-signatures-directory+json');
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual');
});

test('the same request with its signature altered is counted on its user agent alone', async () => {
  const { privateJwk, publicJwk } = await throwawayKey();
  const signed = await signedRequest({
    url: 'https://www.mattpyle.com/llms.txt',
    privateJwk,
    agent: 'sig1="https://signer.example"',
  });
  const headers = new Headers(signed.headers);
  headers.set('Signature', headers.get('Signature').replace(/:(.)/, (_, c) => `:${c === 'A' ? 'B' : 'A'}`));
  const altered = new Request(signed.url, { headers });

  const fetchImpl = documents({ [`https://signer.example${DIRECTORY_PATH}`]: { keys: [publicJwk] } });
  assert.deepEqual(await identifyRequest(altered, { cache: createKeyCache(), fetchImpl }), {
    family: 'curl',
    verification: 'claimed',
    // A signature that did not verify names no host, whatever URL it carried.
    signerHost: null,
  });
});

test('a key the directory does not publish does not verify, even with a valid signature', async () => {
  const signer = await throwawayKey();
  const other = await throwawayKey();
  const request = await signedRequest({
    url: 'https://www.mattpyle.com/llms.txt',
    privateJwk: signer.privateJwk,
    agent: 'sig1="https://signer.example"',
  });
  const fetchImpl = documents({ [`https://signer.example${DIRECTORY_PATH}`]: { keys: [other.publicJwk] } });
  assert.equal(await verifyRequestSignature(request, { cache: createKeyCache(), fetchImpl }), null);
});

// ── Google-Agent, a spoof of it, and a browser ───────────────────────────────────────────────

test('a Google-Agent-shaped request signed under agent.bot.goog is google-agent, signed', async () => {
  // Google's note: a subset of Google-Agent's requests carry Signature-Agent g="https://agent.bot.goog".
  const { privateJwk, publicJwk } = await throwawayKey();
  const request = await signedRequest({
    url: 'https://www.mattpyle.com/writing/accessibility-and-ai/',
    privateJwk,
    label: 'g',
    agent: 'g="https://agent.bot.goog"',
    ua: GOOGLE_AGENT,
  });
  const fetchImpl = documents({ [`https://agent.bot.goog${DIRECTORY_PATH}`]: { keys: [publicJwk] } });
  assert.deepEqual(await identifyRequest(request, { cache: createKeyCache(), fetchImpl }), {
    family: 'google-agent',
    verification: 'signed',
    // A known signer is named through its family; no host is recorded for it.
    signerHost: null,
  });
});

test('a spoofed Google-Agent signed by its own key is not signed google-agent', async () => {
  // A valid signature, but from attacker.example: it proves who signed, not what the UA claims.
  const { privateJwk, publicJwk } = await throwawayKey();
  const request = await signedRequest({
    url: 'https://www.mattpyle.com/writing/accessibility-and-ai/',
    privateJwk,
    agent: 'sig1="https://attacker.example"',
    ua: GOOGLE_AGENT,
  });
  const fetchImpl = documents({ [`https://attacker.example${DIRECTORY_PATH}`]: { keys: [publicJwk] } });
  const cache = createKeyCache();

  assert.deepEqual(await identifyRequest(request, { cache, fetchImpl, address: '203.0.113.9' }), {
    family: 'google-agent',
    verification: 'claimed',
    // The signature proved attacker.example signed, and that is what the Signers table records.
    signerHost: 'attacker.example',
  });
});

test('Google-Agent with no signature from a Google address is ip-verified', async () => {
  const request = new Request('https://www.mattpyle.com/about/', { headers: { 'User-Agent': GOOGLE_AGENT } });
  const [googleAddress] = botRanges.sources.find(({ family }) => family === 'google-agent').prefixes;
  const address = googleAddress.split('/')[0];
  const fetchImpl = documents({});
  assert.deepEqual(await identifyRequest(request, { address, fetchImpl, cache: createKeyCache() }), {
    family: 'google-agent',
    verification: 'ip-verified',
    signerHost: null,
  });
  assert.equal(fetchImpl.calls.length, 0, 'no signature, no fetch');
});

test('a plain browser gets no state and costs no fetch', async () => {
  const request = new Request('https://www.mattpyle.com/', { headers: { 'User-Agent': CHROME } });
  const fetchImpl = documents({});
  assert.deepEqual(await identifyRequest(request, { address: '198.51.100.7', fetchImpl, cache: createKeyCache() }), {
    family: 'browser',
    verification: '',
    signerHost: null,
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('ChatGPT agent, signed under chatgpt.com with a Chrome user agent, is chatgpt-agent', async () => {
  const { privateJwk, publicJwk } = await throwawayKey();
  const request = await signedRequest({
    url: 'https://www.mattpyle.com/about/',
    privateJwk,
    agent: 'sig1="https://chatgpt.com"',
    ua: CHROME,
  });
  const fetchImpl = documents({ [`https://chatgpt.com${DIRECTORY_PATH}`]: { keys: [publicJwk] } });
  assert.deepEqual(await identifyRequest(request, { cache: createKeyCache(), fetchImpl }), {
    family: 'chatgpt-agent',
    verification: 'signed',
    signerHost: null,
  });
});

// ── The decision table ───────────────────────────────────────────────────────────────────────

test('the decision table, row by row', () => {
  const stranger = { identifier: 'https://signer.example/.well-known/http-message-signatures-directory' };
  const google = { identifier: KNOWN_SIGNERS.find(({ family }) => family === 'google-agent').identifier };
  const cases = [
    // A known signer names its family whatever the user agent says.
    [{ ua: CHROME, signer: google }, { family: 'google-agent', verification: 'signed' }],
    // A stranger's signature lends weight only where the user agent names no operator.
    [{ ua: 'curl/8', signer: stranger }, { family: 'curl', verification: 'signed' }],
    [{ ua: CHROME, signer: stranger }, { family: 'browser', verification: 'signed' }],
    [{ ua: 'Googlebot/2.1', signer: stranger }, { family: 'googlebot', verification: 'claimed' }],
    [{ ua: GOOGLE_AGENT, signer: stranger }, { family: 'google-agent', verification: 'claimed' }],
    // No signature: ranges, then the user agent.
    [{ ua: 'Googlebot/2.1', address: '66.249.66.1' }, { family: 'googlebot', verification: 'ip-verified' }],
    [{ ua: 'Googlebot/2.1', address: '203.0.113.9' }, { family: 'googlebot', verification: 'claimed' }],
    [{ ua: 'GPTBot/1.2' }, { family: 'gptbot', verification: 'claimed' }],
    [{ ua: 'curl/8' }, { family: 'curl', verification: 'claimed' }],
    // Neither a bot nor proved: no state at all.
    [{ ua: CHROME }, { family: 'browser', verification: '' }],
    [{ ua: null }, { family: 'none', verification: '' }],
    [{ ua: 'hello' }, { family: 'other', verification: '' }],
  ];
  for (const [observed, expected] of cases) {
    assert.deepEqual(classifyVerification(observed), expected, JSON.stringify(observed));
  }
});

test('the signer host is a stranger’s directory hostname, and nothing for a known signer', () => {
  // Pure, like the decision table: what the Signers table on /activity records a verified
  // signature under, independent of the family and state the table above decided.
  for (const { identifier } of KNOWN_SIGNERS) assert.equal(signerHostFor({ identifier }), null, identifier);
  assert.equal(signerHostFor({ identifier: `https://signer.example${DIRECTORY_PATH}` }), 'signer.example');
  // A card or JWKS identifier keeps its path in the identifier and loses it here; case is folded.
  assert.equal(signerHostFor({ identifier: 'https://Agent.Example.NET/.well-known/signature-agent-card' }), 'agent.example.net');
  assert.equal(signerHostFor(null), null);
  assert.equal(signerHostFor({ identifier: 'not a url' }), null);
});

test('every known signer names a family the counter stores', () => {
  for (const { identifier, family } of KNOWN_SIGNERS) {
    assert.ok(isKnownFamily(family), family);
    assert.ok(identifier.startsWith('https://'), identifier);
  }
});

// ── Bounded fetches ──────────────────────────────────────────────────────────────────────────

test('a key set is fetched once and then served from cache for the hour', async () => {
  const { privateJwk, publicJwk } = await throwawayKey();
  let clock = Date.parse('2026-10-17T12:00:00Z');
  const cache = createKeyCache({ now: () => clock });
  const fetchImpl = documents({ [`https://signer.example${DIRECTORY_PATH}`]: { keys: [publicJwk] } });
  const make = () =>
    signedRequest({ url: 'https://www.mattpyle.com/llms.txt', privateJwk, agent: 'sig1="https://signer.example"' });

  for (let i = 0; i < 5; i += 1) assert.ok(await verifyRequestSignature(await make(), { cache, fetchImpl }));
  assert.equal(fetchImpl.calls.length, 1);

  clock += DIRECTORY_TTL_MS + 1;
  assert.ok(await verifyRequestSignature(await make(), { cache, fetchImpl }));
  assert.equal(fetchImpl.calls.length, 2, 'refetched once the hour is up');
});

test('a failed refetch keeps the key set it already had', async () => {
  // Draft section 6.10: an operator's outage must not revoke its keys at every verifier at once.
  const { privateJwk, publicJwk } = await throwawayKey();
  let clock = Date.parse('2026-10-17T12:00:00Z');
  const cache = createKeyCache({ now: () => clock });
  let up = true;
  const fetchImpl = async () =>
    up
      ? new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })
      : new Response('down', { status: 503 });
  const make = () =>
    signedRequest({ url: 'https://www.mattpyle.com/llms.txt', privateJwk, agent: 'sig1="https://signer.example"' });

  assert.ok(await verifyRequestSignature(await make(), { cache, fetchImpl }));
  up = false;
  clock += DIRECTORY_TTL_MS + 1;
  assert.ok(await verifyRequestSignature(await make(), { cache, fetchImpl }), 'still verifies through the outage');
});

test('a directory that will not answer is not asked again for five minutes', async () => {
  const { privateJwk } = await throwawayKey();
  let clock = Date.parse('2026-10-17T12:00:00Z');
  const cache = createKeyCache({ now: () => clock });
  const fetchImpl = documents({});
  const make = () =>
    signedRequest({ url: 'https://www.mattpyle.com/llms.txt', privateJwk, agent: 'sig1="https://dead.example"' });

  assert.equal(await verifyRequestSignature(await make(), { cache, fetchImpl }), null);
  assert.equal(await verifyRequestSignature(await make(), { cache, fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 1);
  clock += NEGATIVE_TTL_MS + 1;
  await verifyRequestSignature(await make(), { cache, fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
});

test('distinct directories are capped per hour, so a stranger cannot make it fetch at will', async () => {
  const { privateJwk } = await throwawayKey();
  const cache = createKeyCache();
  const fetchImpl = documents({});
  for (let i = 0; i < MAX_DIRECTORY_FETCHES_PER_HOUR + 10; i += 1) {
    const request = await signedRequest({
      url: 'https://www.mattpyle.com/llms.txt',
      privateJwk,
      agent: `sig1="https://signer-${i}.example"`,
    });
    await verifyRequestSignature(request, { cache, fetchImpl });
  }
  assert.equal(fetchImpl.calls.length, MAX_DIRECTORY_FETCHES_PER_HOUR);
});

test('a redirect, an oversized body and a non-200 are all discovery failures', async () => {
  const { privateJwk, publicJwk } = await throwawayKey();
  const url = `https://signer.example${DIRECTORY_PATH}`;
  const make = () =>
    signedRequest({ url: 'https://www.mattpyle.com/llms.txt', privateJwk, agent: 'sig1="https://signer.example"' });
  const answers = [
    new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/keys' } }),
    new Response(JSON.stringify({ keys: [publicJwk], pad: 'x'.repeat(70 * 1024) }), { status: 200 }),
    new Response(JSON.stringify({ keys: [publicJwk] }), { status: 203 }),
  ];
  for (const answer of answers) {
    const fetchImpl = documents({ [url]: answer });
    assert.equal(await verifyRequestSignature(await make(), { cache: createKeyCache(), fetchImpl }), null, String(answer.status));
  }
});

test('only an https URL on a public host name is ever fetched', () => {
  for (const ok of ['https://signer.example', 'https://agent.bot.goog/', 'https://a.example/card']) {
    assert.ok(fetchableUrl(ok), ok);
  }
  for (const refused of [
    'http://signer.example',
    'https://127.0.0.1',
    'https://[::1]/',
    'https://localhost',
    'https://printer.local',
    'https://db.internal',
    'https://signer.example:8443',
    'https://user:pass@signer.example',
    'https://intranet',
    'not a url',
  ]) {
    assert.equal(fetchableUrl(refused), null, refused);
  }
});

test('a directory member must be an origin; jwks_uri and cimd keep their path', () => {
  assert.deepEqual(resolveMember({ uri: 'https://signer.example', type: 'directory' }), {
    type: 'directory',
    fetchUrl: `https://signer.example${DIRECTORY_PATH}`,
    identifier: `https://signer.example${DIRECTORY_PATH}`,
  });
  assert.equal(resolveMember({ uri: 'https://signer.example/keys', type: 'directory' }), null);
  // The identifier drops the query; the fetch does not (draft section 5.5).
  assert.deepEqual(resolveMember({ uri: 'https://signer.example/card?v=2', type: 'cimd' }), {
    type: 'cimd',
    fetchUrl: 'https://signer.example/card?v=2',
    identifier: 'https://signer.example/card',
  });
  assert.equal(resolveMember({ uri: 'https://signer.example/x', type: 'unknown' }), null);
});

test('a cimd member resolves through the card to its jwks_uri, and a card for another URL is refused', async () => {
  const { privateJwk, publicJwk } = await throwawayKey();
  const card = 'https://signer.example/.well-known/signature-agent-card';
  const make = () =>
    signedRequest({ url: 'https://www.mattpyle.com/llms.txt', privateJwk, agent: `sig1="${card}";type=cimd` });

  const good = documents({
    [card]: { body: { client_id: card, client_name: 'Test', jwks_uri: `https://signer.example${DIRECTORY_PATH}` }, type: 'application/json' },
    [`https://signer.example${DIRECTORY_PATH}`]: { keys: [publicJwk] },
  });
  assert.deepEqual(await verifyRequestSignature(await make(), { cache: createKeyCache(), fetchImpl: good }), {
    identifier: card,
  });

  const wrong = documents({
    [card]: { body: { client_id: 'https://other.example/card', jwks: { keys: [publicJwk] } }, type: 'application/json' },
  });
  assert.equal(await verifyRequestSignature(await make(), { cache: createKeyCache(), fetchImpl: wrong }), null);
});

test('identifyRequest never rejects, whatever the headers hold', async () => {
  const garbage = new Request('https://www.mattpyle.com/', {
    headers: { 'User-Agent': 'curl/8', 'Signature-Agent': '((((', 'Signature-Input': 'x', Signature: 'y' },
  });
  assert.deepEqual(await identifyRequest(garbage, { fetchImpl: documents({}), cache: createKeyCache() }), {
    family: 'curl',
    verification: 'claimed',
    signerHost: null,
  });
});

test('signature labels are read at the top level only', () => {
  assert.deepEqual(signatureLabels('a=("@authority");keyid="k,=x", b=("@path");tag="t"'), ['a', 'b']);
  assert.deepEqual(signatureLabels(null), []);
});

// ── Published ranges ─────────────────────────────────────────────────────────────────────────

test('addresses parse in both families, and garbage does not', () => {
  assert.deepEqual(parseAddress('66.249.66.1'), { v6: false, value: 0x42f94201n });
  assert.deepEqual(parseAddress('::ffff:66.249.66.1'), { v6: false, value: 0x42f94201n });
  assert.equal(parseAddress('2001:4860:4801:4004::1').v6, true);
  for (const bad of ['', '300.1.1.1', '1.2.3', 'gggg::', '1::2::3', 'hello', null]) {
    assert.equal(parseAddress(bad), null, String(bad));
  }
});

test('an address is in a family range or it is not, in both IP versions', () => {
  assert.equal(inPublishedRange('googlebot', '66.249.66.1'), true);
  assert.equal(inPublishedRange('googlebot', '8.8.8.8'), false);
  assert.equal(inPublishedRange('google-agent', '2001:4860:4801:4004::1'), true);
  assert.equal(inPublishedRange('curl', '66.249.66.1'), false, 'a family with no ranges is never in one');
  assert.equal(inPublishedRange('googlebot', 'nonsense'), false);
});

test('the committed ranges carry their fetch date and only name families the counter stores', () => {
  assert.match(botRanges.fetched, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(botRanges.sources.length === SOURCES.length);
  for (const { family, url, prefixes } of botRanges.sources) {
    assert.ok(isKnownFamily(family), family);
    assert.ok(SOURCES.some((source) => source.family === family && source.url === url), url);
    assert.ok(prefixes.length > 0, url);
  }
  assert.deepEqual(new Set(rangeFamilies()), new Set(SOURCES.map(({ family }) => family)));
});

test('the refresh normaliser keeps CIDRs and refuses a list without them', () => {
  assert.deepEqual(
    normaliseRangeList({
      creationTime: '2026-10-16T00:00:00',
      prefixes: [{ ipv4Prefix: '66.249.64.0/27' }, { ipv6Prefix: '2001:4860:4801:10::/64' }, { ipv4Prefix: 'junk' }],
    }),
    { creationTime: '2026-10-16T00:00:00', prefixes: ['2001:4860:4801:10::/64', '66.249.64.0/27'] }
  );
  assert.throws(() => normaliseRangeList({ prefixes: [] }));
  assert.throws(() => normaliseRangeList('nope'));
});

// ── Accept-Signature ─────────────────────────────────────────────────────────────────────────

test('/llms.txt carries the Accept-Signature this module defines', () => {
  const rule = vercelConfig.headers.find(({ source }) => source === '/llms.txt');
  assert.ok(rule, 'vercel.json has a /llms.txt header rule');
  const header = rule.headers.find(({ key }) => key === 'Accept-Signature');
  assert.equal(header?.value, ACCEPT_SIGNATURE);
  // The profile's minimum: @authority, the Signature-Agent member, and the web-bot-auth tag.
  assert.match(ACCEPT_SIGNATURE, /"@authority"/);
  assert.match(ACCEPT_SIGNATURE, /"signature-agent";key="sig1"/);
  assert.match(ACCEPT_SIGNATURE, /tag="web-bot-auth"/);
});

test('the committed ranges module is exactly what the refresh script writes', () => {
  const committed = readFileSync(new URL('../src/data/bot-ranges.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, renderRangesModule(BOT_RANGES));
});

test('nothing the middleware imports uses an import attribute', () => {
  // Vercel's middleware bundler rejects `import ... with { type: 'json' }`, and the failure only
  // shows on a deploy. The middleware's own modules are checked here instead.
  const files = [
    '../middleware.ts',
    '../src/lib/web-bot-auth.mjs',
    '../src/lib/agent-hits.mjs',
    '../src/lib/agent-traffic.mjs',
    '../src/lib/activity-summary.mjs',
    '../src/data/bot-ranges.mjs',
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^import[^;]+\bwith\s*\{/m, file);
  }
});
