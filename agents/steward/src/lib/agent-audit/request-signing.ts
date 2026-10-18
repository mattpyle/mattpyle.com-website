import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Web Bot Auth on the way out: the signature every request the fetcher makes can carry.
 *
 * draft-ietf-webbotauth-httpsig-protocol-00 profiles HTTP Message Signatures (RFC 9421) for
 * automated clients. A signed request carries three headers: `Signature-Input` (what was signed),
 * `Signature` (the Ed25519 signature) and `Signature-Agent` (where the verifier finds the key).
 * The `Signature-Agent` member here is `type=cimd` and names one URL on the site that is both the
 * Signature Agent Card and the OAuth Client ID Metadata Document for `steward-audit`; the card
 * names the key directory at `/.well-known/http-message-signatures-directory`.
 *
 * Written against `node:crypto` rather than a library, on purpose. This file is in the fast tier's
 * import graph, which the site's /mcp function bundles, and tests/steward-fast-audit-packaging.test.mjs
 * admits `undici` and `node:` there and nothing else. Signing our own request needs no parser: the
 * fetcher chose every component, so it serialises them itself. Verification, which parses a
 * stranger's headers, is the site's job and uses Cloudflare's package (src/lib/web-bot-auth.mjs).
 * The tests verify what this signs with that verifier, so each half checks the other.
 *
 * Fails open in the same direction as the rest of the fetcher: no key means an unsigned request,
 * exactly as before, and a key that will not parse is reported once and then ignored.
 */

/** The environment variable that holds the private key, as one line of JWK JSON. */
export const SIGNING_KEY_ENV = 'STEWARD_WEB_BOT_AUTH_KEY';

/**
 * The URL a verifier resolves to find the key: the Signature Agent Card, which is also the CIMD
 * for `steward-audit`, so its `client_id` is this same string. The site serves it, and
 * tests/steward-signing.test.mjs pins the two together.
 */
export const SIGNATURE_AGENT_CARD_URL = 'https://www.mattpyle.com/.well-known/signature-agent-card';

/** The signature's label, and the `Signature-Agent` member key it covers. */
export const SIGNATURE_LABEL = 'sig1';

/**
 * How long a signature stays valid. Five minutes covers a slow audit's clock skew; the draft
 * recommends no more than 24 hours and a short lifetime bounds replay (section 5.2).
 */
export const SIGNATURE_LIFETIME_SECONDS = 300;

/** The components every signature covers: one method, one authority, one path, and the agent. */
const COVERED_COMPONENTS = ['@method', '@authority', '@path'] as const;

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
}

export interface RequestSigner {
  /** The key's JWK SHA-256 thumbprint, which is also the `keyid` every signature carries. */
  readonly keyid: string;
  /** The public half, as the key directory publishes it. */
  readonly publicJwk: PublicJwk;
  /** The three headers for one request. */
  headersFor(url: URL, method: string, now?: Date): Record<string, string>;
}

/**
 * The JWK thumbprint of an Ed25519 key (RFC 7638, with RFC 8037 appendix A.3 naming the members):
 * SHA-256 over the required members in lexical order, no whitespace, base64url.
 */
export function jwkThumbprint(x: string): string {
  return createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url');
}

/** The value of the one `Signature-Agent` dictionary member this signer sends. */
export function signatureAgentMember(): string {
  return `"${SIGNATURE_AGENT_CARD_URL}";type=cimd`;
}

/** `@authority`: the host, lowercased, with the port only when it is not the scheme's default. */
function authorityOf(url: URL): string {
  return url.host.toLowerCase();
}

/**
 * The signature base (RFC 9421 section 2.5) and the `Signature-Input` member it ends with. Built
 * from values this function chose, so the serialisation is fixed rather than parsed.
 */
export function signatureBase(
  url: URL,
  method: string,
  params: { created: number; expires: number; keyid: string; nonce: string },
): { base: string; signatureParams: string } {
  const componentList = [
    ...COVERED_COMPONENTS.map((name) => `"${name}"`),
    `"signature-agent";key="${SIGNATURE_LABEL}"`,
  ].join(' ');
  const signatureParams =
    `(${componentList});created=${params.created};expires=${params.expires}` +
    `;keyid="${params.keyid}";alg="ed25519";nonce="${params.nonce}";tag="web-bot-auth"`;
  const lines = [
    `"@method": ${method.toUpperCase()}`,
    `"@authority": ${authorityOf(url)}`,
    `"@path": ${url.pathname || '/'}`,
    `"signature-agent";key="${SIGNATURE_LABEL}": ${signatureAgentMember()}`,
    `"@signature-params": ${signatureParams}`,
  ];
  return { base: lines.join('\n'), signatureParams };
}

/**
 * A signer from a private Ed25519 JWK. Throws on anything else: the caller decides whether a bad
 * key is fatal (the `keys` verb) or a reason to send unsigned (the fetcher).
 */
export function signerFromJwk(jwk: unknown): RequestSigner {
  if (!jwk || typeof jwk !== 'object') throw new Error('the signing key is not a JWK object');
  const { kty, crv, x, d } = jwk as Record<string, unknown>;
  if (kty !== 'OKP' || crv !== 'Ed25519' || typeof x !== 'string' || typeof d !== 'string') {
    throw new Error('the signing key must be an Ed25519 private JWK: kty "OKP", crv "Ed25519", x and d');
  }
  const privateKey: KeyObject = createPrivateKey({ key: { kty, crv, x, d }, format: 'jwk' });
  const keyid = jwkThumbprint(x);
  const publicJwk: PublicJwk = { kty: 'OKP', crv: 'Ed25519', x, kid: keyid, use: 'sig' };

  return {
    keyid,
    publicJwk,
    headersFor(url, method, now = new Date()) {
      const created = Math.floor(now.getTime() / 1000);
      const params = {
        created,
        expires: created + SIGNATURE_LIFETIME_SECONDS,
        keyid,
        // 64 random bytes, standard base64: the shape the draft's vectors and Cloudflare's
        // verifier use. It makes each signature unique, so two identical requests never carry
        // the same reusable value.
        nonce: randomBytes(64).toString('base64'),
      };
      const { base, signatureParams } = signatureBase(url, method, params);
      const signature = sign(null, Buffer.from(base, 'utf8'), privateKey).toString('base64');
      return {
        'signature-agent': `${SIGNATURE_LABEL}=${signatureAgentMember()}`,
        'signature-input': `${SIGNATURE_LABEL}=${signatureParams}`,
        signature: `${SIGNATURE_LABEL}=:${signature}:`,
      };
    },
  };
}

let warned = false;

/**
 * The signer the environment configures, or null for none. Read once per call; the fetcher calls
 * it once per audit. A value that will not parse is a warning and an unsigned audit, never a
 * failed one: signing is identification, and identification is never worth an audit.
 */
export function signerFromEnv(env: Record<string, string | undefined> = process.env): RequestSigner | null {
  const raw = env[SIGNING_KEY_ENV]?.trim();
  if (!raw) return null;
  try {
    return signerFromJwk(JSON.parse(raw));
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(
        `[steward] ${SIGNING_KEY_ENV} is set but unusable, so requests go unsigned: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
}

/**
 * A fresh Ed25519 key pair as JWK, for `steward keys generate`. Writes nothing: the caller prints
 * it and the operator stores it.
 */
export function generateSigningKey(): { privateJwk: Record<string, string>; publicJwk: PublicJwk } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const { x, d } = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const privateJwk = { kty: 'OKP', crv: 'Ed25519', x, d };
  return { privateJwk, publicJwk: signerFromJwk(privateJwk).publicJwk };
}
