import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicKey, verify } from 'node:crypto';
import {
  SIGNATURE_AGENT_CARD_URL,
  SIGNATURE_LIFETIME_SECONDS,
  SIGNING_KEY_ENV,
  generateSigningKey,
  jwkThumbprint,
  signatureBase,
  signerFromEnv,
  signerFromJwk,
} from '../../src/lib/agent-audit/request-signing.js';
import { SafeFetcher } from '../../src/lib/agent-audit/safe-fetch.js';
import { describeKeyPair, runKeysGenerate } from '../../src/lib/signing-keys-cli.js';

/**
 * Steward's outbound signatures. Every key in this file is generated when the test runs and
 * dropped when it ends; the real key in `.env` is blanked by tests/helpers/no-real-credentials.ts
 * before any of this loads.
 */

test('the headers follow the draft profile', () => {
  const { privateJwk } = generateSigningKey();
  const signer = signerFromJwk(privateJwk);
  const now = new Date('2026-10-17T20:00:00Z');
  const headers = signer.headersFor(new URL('https://example.com/'), 'GET', now);
  const created = Math.floor(now.getTime() / 1000);

  assert.equal(headers['signature-agent'], `sig1="${SIGNATURE_AGENT_CARD_URL}";type=cimd`);
  assert.match(headers['signature-input'], /^sig1=\("@method" "@authority" "@path" "signature-agent";key="sig1"\)/);
  assert.ok(headers['signature-input'].includes(`;created=${created};expires=${created + SIGNATURE_LIFETIME_SECONDS};`));
  assert.ok(headers['signature-input'].includes(`;keyid="${signer.keyid}";alg="ed25519";`));
  assert.ok(headers['signature-input'].endsWith(';tag="web-bot-auth"'));
  assert.match(headers.signature, /^sig1=:[A-Za-z0-9+/]{86}==:$/);
  // A fresh nonce each time, so two identical requests never carry one reusable value.
  assert.notEqual(signer.headersFor(new URL('https://example.com/'), 'GET', now).signature, headers.signature);
});

test('the keyid is the RFC 8037 thumbprint', () => {
  // RFC 8037 appendix A.3: the thumbprint of the appendix A.1 public key.
  assert.equal(jwkThumbprint('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'), 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  const { privateJwk, publicJwk } = generateSigningKey();
  assert.equal(signerFromJwk(privateJwk).keyid, jwkThumbprint(publicJwk.x));
  assert.equal(publicJwk.kid, jwkThumbprint(publicJwk.x));
});

test('no key, or a key that will not parse, is an unsigned fetcher and never a throw', () => {
  assert.equal(signerFromEnv({}), null);
  assert.equal(signerFromEnv({ [SIGNING_KEY_ENV]: '' }), null);
  assert.equal(signerFromEnv({ [SIGNING_KEY_ENV]: 'not json' }), null);
  assert.equal(signerFromEnv({ [SIGNING_KEY_ENV]: JSON.stringify({ kty: 'RSA' }) }), null);
  const { privateJwk } = generateSigningKey();
  assert.ok(signerFromEnv({ [SIGNING_KEY_ENV]: JSON.stringify(privateJwk) }));
  // The test environment has the real key blanked, so the default fetcher signs nothing.
  assert.equal(new SafeFetcher().signer, null);
});

test('a public key is not a signing key', () => {
  const { publicJwk } = generateSigningKey();
  assert.throws(() => signerFromJwk(publicJwk), /private JWK/);
});

test('the fetcher signs every hop, each for its own host and path', async () => {
  const { privateJwk, publicJwk } = generateSigningKey();
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    if (req.url === '/start') {
      res.writeHead(302, { location: '/end' }).end();
      return;
    }
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const fetcher = new SafeFetcher({ allowedPrivateHosts: ['127.0.0.1'] }, Date.now(), signerFromJwk(privateJwk));
    const response = await fetcher.fetch(`http://127.0.0.1:${port}/start`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      seen.map(({ url }) => url),
      ['/start', '/end'],
    );

    // Each hop's signature checks out over that hop's own authority and path. The site's suite
    // (tests/steward-signing.test.mjs) checks the same signer through the site's verifier.
    const publicKey = createPublicKey({ key: { ...publicJwk }, format: 'jwk' });
    for (const { url, headers } of seen) {
      assert.ok(headers.signature && headers['signature-input'] && headers['signature-agent'], url);
      const input = String(headers['signature-input']);
      const param = (name: string) => input.match(new RegExp(`;${name}="?([^";]+)"?`))?.[1] ?? '';
      const { base } = signatureBase(new URL(`http://127.0.0.1:${port}${url}`), 'GET', {
        created: Number(param('created')),
        expires: Number(param('expires')),
        keyid: param('keyid'),
        nonce: param('nonce'),
      });
      const signature = Buffer.from(String(headers.signature).replace(/^sig1=:|:$/g, ''), 'base64');
      assert.ok(verify(null, Buffer.from(base), publicKey, signature), `hop ${url} verifies`);
    }
    assert.notEqual(seen[0].headers.signature, seen[1].headers.signature);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an unsigned fetcher sends no signature headers at all', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await new SafeFetcher({ allowedPrivateHosts: ['127.0.0.1'] }, Date.now(), null).fetch(`http://127.0.0.1:${port}/`);
    assert.equal(seen[0].signature, undefined);
    assert.equal(seen[0]['signature-agent'], undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('keys generate prints both halves, writes nothing, and the private half signs', () => {
  const lines: string[] = [];
  runKeysGenerate({ json: true }, (line) => lines.push(line));
  const pair = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(pair.privateJwk).sort(), ['crv', 'd', 'kty', 'x']);
  assert.deepEqual(Object.keys(pair.publicJwk).sort(), ['crv', 'kid', 'kty', 'use', 'x']);
  assert.equal(signerFromJwk(pair.privateJwk).keyid, pair.publicJwk.kid);

  const text = describeKeyPair(pair);
  assert.ok(text.some((line) => line.startsWith(`${SIGNING_KEY_ENV}={`)));
  assert.ok(text.some((line) => line.includes('src/data/steward-signing-keys.json')));
  // The public line carries no private member.
  const publicLine = text.find((line) => line.startsWith('{') && line.includes('"kid"'));
  assert.ok(publicLine && !publicLine.includes('"d"'));
});
