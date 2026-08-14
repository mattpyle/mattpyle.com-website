import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemporalConnection } from '../../src/config.js';

/**
 * The client and the worker build their connections from this one function, so
 * these cases are what stops the two halves of the stack from talking to
 * different services. The switch is the API key rather than the address: both
 * the address and the namespace have local defaults that a Cloud setup must
 * also override, so keying off either would read a half-configured environment
 * as a complete one.
 */

const CLOUD_ADDRESS = 'ns.acct.tmprl.cloud:7233';
const CLOUD_NAMESPACE = 'ns.acct';

test('no API key means the local dev server, plaintext', () => {
  const opts = resolveTemporalConnection('localhost:7233', 'default', '');
  assert.deepEqual(opts, { address: 'localhost:7233' });
});

test('every loopback form the dev server binds is accepted', () => {
  for (const address of ['localhost:7233', '127.0.0.1:7233', '[::1]:7233']) {
    assert.deepEqual(resolveTemporalConnection(address, 'default', ''), { address }, address);
  }
});

test('an API key means Cloud: TLS on, key attached, namespace in the metadata', () => {
  const opts = resolveTemporalConnection(CLOUD_ADDRESS, CLOUD_NAMESPACE, 'secret-key');
  assert.deepEqual(opts, {
    address: CLOUD_ADDRESS,
    tls: true,
    apiKey: 'secret-key',
    metadata: { 'temporal-namespace': CLOUD_NAMESPACE },
  });
});

/**
 * The namespace header is redundant against the namespace endpoint and load-
 * bearing against a regional one, where API-key auth otherwise fails with a
 * bare `Request unauthorized` that names no cause. Sending it always is what
 * keeps a future endpoint change from reintroducing that.
 */
test('the namespace header is sent even though the namespace endpoint implies it', () => {
  const opts = resolveTemporalConnection(CLOUD_ADDRESS, CLOUD_NAMESPACE, 'secret-key');
  assert.equal(opts.metadata?.['temporal-namespace'], CLOUD_NAMESPACE);
});

test('a remote address with no key is refused, and the error names both fixes', () => {
  assert.throws(
    () => resolveTemporalConnection(CLOUD_ADDRESS, CLOUD_NAMESPACE, ''),
    (err: Error) => {
      assert.match(err.message, /TEMPORAL_API_KEY/);
      assert.match(err.message, /agents\/steward\/\.env/);
      assert.match(err.message, /localhost:7233/);
      return true;
    },
  );
});

/**
 * A hostname that merely starts with a loopback name is not loopback. Without
 * the exact-host check, `localhost.attacker.example` would read as the dev
 * server and connect in plaintext with no credentials.
 */
test('a hostname that only looks loopback is still refused', () => {
  for (const address of ['localhost.example.com:7233', '127.0.0.1.example.com:7233']) {
    assert.throws(() => resolveTemporalConnection(address, 'default', ''), /TEMPORAL_API_KEY/, address);
  }
});

test('the key never leaks into the address or the metadata', () => {
  const opts = resolveTemporalConnection(CLOUD_ADDRESS, CLOUD_NAMESPACE, 'secret-key');
  assert.equal(opts.address.includes('secret-key'), false);
  assert.equal(JSON.stringify(opts.metadata).includes('secret-key'), false);
});
