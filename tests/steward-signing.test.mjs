import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifierFromJWK } from 'web-bot-auth/crypto';
// Steward's signer, imported as TypeScript through Node's type stripping, as tests/a2a-digest.test.mjs
// does: request-signing.ts imports nothing but node:crypto, so it loads without the workspace.
import {
  SIGNATURE_AGENT_CARD_URL,
  generateSigningKey,
  jwkThumbprint,
  signerFromJwk,
} from '../agents/steward/src/lib/agent-audit/request-signing.ts';
import {
  KNOWN_SIGNERS,
  classifyVerification,
  createKeyCache,
  verifyRequestSignature,
} from '../src/lib/web-bot-auth.mjs';
import {
  DIRECTORY_MEDIA_TYPE,
  DIRECTORY_PATH,
  SIGNATURE_AGENT_CARD_PATH,
  STEWARD_AGENT_TOKEN,
  STEWARD_USER_AGENT,
  buildDirectory,
  buildSignatureAgentCard,
} from '../src/lib/steward-identity.mjs';
import { WELL_KNOWN_SURFACE_PATHS } from '../src/lib/agent-surfaces.mjs';
// The production origin, not the build's: the card URL Steward signs with is production's.
import { PRODUCTION_ORIGIN as SITE_ORIGIN } from '../src/data/site-origin.mjs';

/**
 * Web Bot Auth, both halves at once: what Steward signs, checked by what the site verifies.
 *
 * The signer (agents/steward/src/lib/agent-audit/request-signing.ts) is hand-written on
 * node:crypto; the verifier (src/lib/web-bot-auth.mjs) rests on Cloudflare's package. Neither was
 * written against the other's output, so a signature that verifies here is evidence that both
 * follow the draft rather than that they agree with each other by construction. Every key is a
 * throwaway generated when the test runs.
 */

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const vercelConfig = JSON.parse(read('vercel.json'));
const committedKeys = JSON.parse(read('src/data/steward-signing-keys.json'));

/** The request as the site's middleware would see it. */
function received(url, method, headers) {
  return new Request(url, { method, headers: { 'user-agent': STEWARD_USER_AGENT, ...headers } });
}

/** The site's own card and directory, built from a test key, served by a fetch stand-in. */
function siteDocuments(publicJwk) {
  const card = buildSignatureAgentCard(SITE_ORIGIN);
  const directory = buildDirectory([publicJwk]);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url) === card.client_id) return new Response(JSON.stringify(card), { status: 200 });
    if (String(url) === card.jwks_uri) return new Response(JSON.stringify(directory), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

test("a Steward signature verifies through the site's card and directory, as steward-audit", async () => {
  const { privateJwk, publicJwk } = generateSigningKey();
  const url = new URL('https://www.mattpyle.com/llms.txt');
  const request = received(url.href, 'GET', signerFromJwk(privateJwk).headersFor(url, 'GET'));
  const { fetchImpl, calls } = siteDocuments(publicJwk);

  const signer = await verifyRequestSignature(request, { cache: createKeyCache(), fetchImpl });
  assert.deepEqual(signer, { identifier: SIGNATURE_AGENT_CARD_URL });
  // The CIMD path: the card first, then the directory its jwks_uri names.
  assert.deepEqual(calls, [SIGNATURE_AGENT_CARD_URL, `${SITE_ORIGIN}${DIRECTORY_PATH}`]);
  assert.deepEqual(classifyVerification({ ua: STEWARD_USER_AGENT, signer }), {
    family: 'steward-audit',
    verification: 'signed',
  });
});

test('a Steward signature covers method, authority and path, so it does not transfer', async () => {
  const { privateJwk, publicJwk } = generateSigningKey();
  const url = new URL('https://example.com/llms.txt');
  const headers = signerFromJwk(privateJwk).headersFor(url, 'GET');
  const verifiersFor = async () => [await verifierFromJWK(publicJwk)];

  assert.ok(await verifyRequestSignature(received(url.href, 'GET', headers), { verifiersFor }));
  for (const [moved, method] of [
    ['https://example.com/agents.md', 'GET'],
    ['https://other.example/llms.txt', 'GET'],
    ['https://example.com/llms.txt', 'HEAD'],
  ]) {
    assert.equal(await verifyRequestSignature(received(moved, method, headers), { verifiersFor }), null, `${method} ${moved}`);
  }
});

test('the two thumbprint implementations agree', async () => {
  const { publicJwk } = generateSigningKey();
  assert.equal(jwkThumbprint(publicJwk.x), (await verifierFromJWK(publicJwk)).keyid);
});

// ── The documents ────────────────────────────────────────────────────────────────────────────

test('the URL every signature names is the card, and the card says so', () => {
  const card = buildSignatureAgentCard(SITE_ORIGIN);
  assert.equal(`${SITE_ORIGIN}${SIGNATURE_AGENT_CARD_PATH}`, SIGNATURE_AGENT_CARD_URL);
  assert.equal(card.client_id, SIGNATURE_AGENT_CARD_URL);
  assert.equal(card.jwks_uri, `${SITE_ORIGIN}${DIRECTORY_PATH}`);
  assert.equal('jwks' in card, false, 'a card carries jwks or jwks_uri, never both');
  assert.equal(card.web_bot_auth['rfc9309-product-token'], STEWARD_AGENT_TOKEN);
  assert.equal(card.web_bot_auth.trigger, 'fetcher');
});

test("the site counts the card and the directory as Steward's, and nobody else's", () => {
  const signers = KNOWN_SIGNERS.filter(({ family }) => family === 'steward-audit').map(({ identifier }) => identifier);
  assert.deepEqual(signers.sort(), [SIGNATURE_AGENT_CARD_URL, `${SITE_ORIGIN}${DIRECTORY_PATH}`].sort());
});

test("the card's User-Agent is the auditor's, character for character", () => {
  // Rebuilt from the workspace the way tests/steward-page.test.mjs does: the template literal over
  // AUDIT_VERSION, read from source.
  const safeFetch = read('agents/steward/src/lib/agent-audit/safe-fetch.ts');
  const version = safeFetch.match(/export const AUDIT_VERSION = '([^']+)'/)?.[1];
  const template = safeFetch.match(/export const AUDIT_USER_AGENT = `([^`]+)`/)?.[1];
  assert.ok(version && template);
  assert.equal(STEWARD_USER_AGENT, template.replace('${AUDIT_VERSION}', version));
  assert.equal(buildSignatureAgentCard(SITE_ORIGIN).web_bot_auth['expected-user-agent'], STEWARD_USER_AGENT);
});

test('the committed keys are public, and each kid is its thumbprint', () => {
  for (const key of committedKeys.keys) {
    // Public members only: a 'd' here would publish the private half.
    for (const name of Object.keys(key)) assert.ok(['crv', 'kid', 'kty', 'use', 'x'].includes(name), name);
    assert.equal(key.kty, 'OKP');
    assert.equal(key.crv, 'Ed25519');
    assert.equal(key.kid, jwkThumbprint(key.x));
  }
  // The directory serves the same keys with nothing added beyond `use`.
  const { publicJwk } = generateSigningKey();
  assert.deepEqual(buildDirectory([publicJwk]), { keys: [{ ...publicJwk, use: 'sig' }] });
});

test('both documents carry their media type in production and locally, and are watched as surfaces', () => {
  const header = (source, key) =>
    vercelConfig.headers.find((rule) => rule.source === source)?.headers.find((entry) => entry.key === key)?.value;
  assert.equal(header(DIRECTORY_PATH, 'Content-Type'), DIRECTORY_MEDIA_TYPE);
  assert.equal(header(SIGNATURE_AGENT_CARD_PATH, 'Content-Type'), 'application/json; charset=utf-8');

  const server = read('scripts/serve-built-site.mjs');
  assert.ok(server.includes(`'${DIRECTORY_PATH}': '${DIRECTORY_MEDIA_TYPE}'`));
  assert.ok(server.includes(`'${SIGNATURE_AGENT_CARD_PATH}': 'application/json; charset=utf-8'`));

  assert.ok(WELL_KNOWN_SURFACE_PATHS.includes(DIRECTORY_PATH));
  assert.ok(WELL_KNOWN_SURFACE_PATHS.includes(SIGNATURE_AGENT_CARD_PATH));
});
