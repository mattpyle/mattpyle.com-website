/**
 * The two documents a verifier needs to check a Steward signature, built from committed data.
 *
 * Steward signs its requests with Web Bot Auth (agents/steward/src/lib/agent-audit/request-signing.ts)
 * and names one URL in `Signature-Agent`, with `type=cimd`:
 *
 * | Path | Document | Spec |
 * |---|---|---|
 * | `/.well-known/signature-agent-card` | the Signature Agent Card, which is also the OAuth Client ID Metadata Document for `steward-audit` | draft-meunier-webbotauth-registry-03, draft-ietf-oauth-client-id-metadata-document-02 |
 * | `/.well-known/http-message-signatures-directory` | the key directory the card's `jwks_uri` names, and the fallback for a verifier that resolves the origin | draft-ietf-webbotauth-httpsig-protocol-00 |
 *
 * One document serving both roles is the experiment: the card draft says an existing CIMD is
 * already a valid card, so the bot's identity and its OAuth client identity can be one URL.
 *
 * The keys are src/data/steward-signing-keys.json, public values only. The User-Agent is typed out
 * here because a prerendered route may not import the Steward workspace (root CLAUDE.md);
 * tests/steward-signing.test.mjs pins it, and the card URL, against the workspace's constants.
 */

import signingKeys from '../data/steward-signing-keys.json' with { type: 'json' };

/** The media type the draft registers for the directory (section 8.2). */
export const DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';

export const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const SIGNATURE_AGENT_CARD_PATH = '/.well-known/signature-agent-card';

/** Steward's User-Agent, verbatim. Pinned to AUDIT_USER_AGENT by tests/steward-signing.test.mjs. */
export const STEWARD_USER_AGENT = 'steward-audit/0.2.0 (+https://www.mattpyle.com/steward)';
export const STEWARD_AGENT_TOKEN = 'steward-audit';

/**
 * The directory: a JWK Set of the keys Steward signs with. Each key carries `kid` set to its
 * thumbprint, which the draft requires when a `kid` is present at the well-known URI (section
 * 5.5), so a verifier can match `keyid` against it without trusting the label.
 *
 * @returns {{ keys: Array<Record<string, string>> }}
 */
export function buildDirectory(keys = signingKeys.keys) {
  return {
    keys: keys.map(({ kty, crv, x, kid }) => ({ kty, crv, x, kid, use: 'sig' })),
  };
}

/**
 * The card. `client_id` is the URL it is served at, exactly, because a CIMD consumer and a card
 * verifier both refuse a document whose `client_id` differs from the URL fetched.
 *
 * No `rate-expectation`: the audit's caps live in the deployment's environment, and a number typed
 * here would drift from what the limiter enforces. `/steward` renders the resolved values.
 *
 * @param {string} origin the site's origin, from astro.config.mjs `site`
 */
export function buildSignatureAgentCard(origin) {
  const base = origin.replace(/\/+$/, '');
  return {
    client_id: `${base}${SIGNATURE_AGENT_CARD_PATH}`,
    client_name: 'Steward',
    client_uri: `${base}/steward/`,
    jwks_uri: `${base}${DIRECTORY_PATH}`,
    web_bot_auth: {
      'expected-user-agent': STEWARD_USER_AGENT,
      'rfc9309-product-token': STEWARD_AGENT_TOKEN,
      'rfc9309-compliance': ['User-Agent', 'Allow', 'Disallow'],
      trigger: 'fetcher',
      'targeted-content':
        'Agent-readiness audit: robots.txt, sitemaps, llms.txt, agents.md, the well-known discovery documents and the headers of a few pages',
      'rate-control': 'robots.txt Disallow for the steward-audit token; one audit then costs one robots.txt fetch',
      'known-urls': ['/robots.txt', '/', '/sitemap.xml', '/llms.txt', '/agents.md', '/.well-known/*'],
    },
  };
}
