import crypto from 'node:crypto';

/**
 * The check every request to the Interactions Endpoint passes first.
 *
 * Discord signs each interaction with the application's Ed25519 key. The
 * signed message is the `X-Signature-Timestamp` header followed by the raw
 * request body, and the signature arrives as hex in `X-Signature-Ed25519`.
 * Node's own `crypto.verify` checks it, so there is no dependency here.
 *
 * The timestamp window is this service's rule, not Discord's: a signed request
 * older or newer than {@link TIMESTAMP_TOLERANCE_MS} is refused, so a captured
 * request cannot be sent again later.
 *
 * Pure: no environment, no clock of its own.
 */

/** Five minutes either way. */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

export const SIGNATURE_HEADER = 'x-signature-ed25519';
export const TIMESTAMP_HEADER = 'x-signature-timestamp';

const HEX_32 = /^[0-9a-f]{64}$/i;
const HEX_64 = /^[0-9a-f]{128}$/i;

/** True for the application's public key as the Developer Portal shows it: 32 bytes of hex. */
export function isDiscordPublicKey(hex: string): boolean {
  return HEX_32.test(hex);
}

/** The key object for a public key in hex. Throws for anything that is not 32 bytes of hex. */
export function discordPublicKey(hex: string): crypto.KeyObject {
  if (!isDiscordPublicKey(hex)) throw new Error('The Discord public key is not 64 hexadecimal characters.');
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
    format: 'jwk',
  });
}

export type SignatureRefusal = 'missing-headers' | 'malformed-signature' | 'malformed-timestamp' | 'stale-timestamp' | 'bad-signature';

export interface SignedRequest {
  publicKey: crypto.KeyObject;
  /** `X-Signature-Ed25519`. */
  signature: string | undefined;
  /** `X-Signature-Timestamp`: seconds since the epoch. */
  timestamp: string | undefined;
  /** The body exactly as it arrived. */
  rawBody: Buffer;
  now: Date;
  toleranceMs?: number;
}

/** Null when the request is Discord's and fresh; otherwise why it is refused. */
export function refuseSignedRequest(request: SignedRequest): SignatureRefusal | null {
  const { signature, timestamp } = request;
  if (!signature || !timestamp) return 'missing-headers';
  if (!HEX_64.test(signature)) return 'malformed-signature';
  if (!/^\d{1,12}$/.test(timestamp)) return 'malformed-timestamp';
  // The signature first: an unsigned request learns nothing about the clock.
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), request.rawBody]);
  let verified = false;
  try {
    verified = crypto.verify(null, message, request.publicKey, Buffer.from(signature, 'hex'));
  } catch {
    verified = false;
  }
  if (!verified) return 'bad-signature';
  const age = Math.abs(request.now.getTime() - Number(timestamp) * 1000);
  if (age > (request.toleranceMs ?? TIMESTAMP_TOLERANCE_MS)) return 'stale-timestamp';
  return null;
}
