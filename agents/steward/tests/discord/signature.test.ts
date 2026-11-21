import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMESTAMP_TOLERANCE_MS, discordPublicKey, isDiscordPublicKey, refuseSignedRequest } from '../../src/discord/signature.js';
import { testApplication } from './support.js';

/**
 * The signature check, with key pairs made at run time: what it accepts, and
 * each way it refuses. The message is the timestamp followed by the raw body.
 */

const NOW = new Date('2026-11-21T20:00:00.000Z');
const STAMP = String(Math.floor(NOW.getTime() / 1000));
const BODY = '{"type":1}';

function check(overrides: { signature?: string; timestamp?: string; body?: string; now?: Date; keyHex?: string } = {}) {
  const app = testApplication();
  const timestamp = overrides.timestamp ?? STAMP;
  return {
    app,
    refusal: refuseSignedRequest({
      publicKey: discordPublicKey(overrides.keyHex ?? app.publicKeyHex),
      signature: overrides.signature ?? app.sign(timestamp, BODY),
      timestamp,
      rawBody: Buffer.from(overrides.body ?? BODY),
      now: overrides.now ?? NOW,
    }),
  };
}

test("a request signed with the application's key over timestamp and body is accepted", () => {
  assert.equal(check().refusal, null);
});

test('a body changed after signing is refused', () => {
  assert.equal(check({ body: '{"type":2}' }).refusal, 'bad-signature');
});

test('a timestamp changed after signing is refused', () => {
  const app = testApplication();
  const refusal = refuseSignedRequest({
    publicKey: discordPublicKey(app.publicKeyHex),
    signature: app.sign(STAMP, BODY),
    timestamp: String(Number(STAMP) + 1),
    rawBody: Buffer.from(BODY),
    now: NOW,
  });
  assert.equal(refusal, 'bad-signature');
});

test("a request signed with another application's key is refused", () => {
  assert.equal(check({ keyHex: testApplication().publicKeyHex }).refusal, 'bad-signature');
});

test('missing headers and a signature that is not 64 bytes of hex are refused before any verify', () => {
  const app = testApplication();
  const base = { publicKey: discordPublicKey(app.publicKeyHex), rawBody: Buffer.from(BODY), now: NOW };
  assert.equal(refuseSignedRequest({ ...base, signature: undefined, timestamp: STAMP }), 'missing-headers');
  assert.equal(refuseSignedRequest({ ...base, signature: app.sign(STAMP, BODY), timestamp: undefined }), 'missing-headers');
  assert.equal(refuseSignedRequest({ ...base, signature: 'zz', timestamp: STAMP }), 'malformed-signature');
  assert.equal(refuseSignedRequest({ ...base, signature: app.sign(STAMP, BODY).slice(2), timestamp: STAMP }), 'malformed-signature');
  assert.equal(refuseSignedRequest({ ...base, signature: app.sign('soon', BODY), timestamp: 'soon' }), 'malformed-timestamp');
});

test('a correctly signed request older or newer than five minutes is refused as stale', () => {
  assert.equal(TIMESTAMP_TOLERANCE_MS, 5 * 60_000);
  const late = new Date(NOW.getTime() + TIMESTAMP_TOLERANCE_MS + 1000);
  const early = new Date(NOW.getTime() - TIMESTAMP_TOLERANCE_MS - 1000);
  assert.equal(check({ now: late }).refusal, 'stale-timestamp');
  assert.equal(check({ now: early }).refusal, 'stale-timestamp');
  assert.equal(check({ now: new Date(NOW.getTime() + TIMESTAMP_TOLERANCE_MS - 1000) }).refusal, null);
});

test('a public key is 64 hexadecimal characters, and anything else throws without echoing it', () => {
  assert.ok(isDiscordPublicKey(testApplication().publicKeyHex));
  const wrong = ['not', 'a', 'key'].join('-');
  assert.equal(isDiscordPublicKey(wrong), false);
  assert.throws(() => discordPublicKey(wrong), (err: Error) => !err.message.includes(wrong));
});
