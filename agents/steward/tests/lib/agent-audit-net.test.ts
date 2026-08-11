import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAddress, expandIPv6, parseIPv4 } from '../../src/lib/agent-audit/net.js';

/**
 * The address table behind the audit fetcher's SSRF guard.
 *
 * A table test rather than a narrative one, because the failure mode this
 * guards against is a range that is *almost* right: an off-by-one prefix on
 * 172.16/12 leaves half of a private network reachable, and nothing else in the
 * system would notice.
 */

const BLOCKED = [
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'the far end of loopback'],
  ['0.0.0.0', '"this network"'],
  ['10.0.0.1', 'RFC 1918 /8'],
  ['172.16.0.1', 'the first address of RFC 1918 /12'],
  ['172.31.255.255', 'the last address of RFC 1918 /12'],
  ['192.168.1.1', 'RFC 1918 /16'],
  ['169.254.169.254', 'the AWS/Azure/GCP metadata service'],
  ['100.100.100.200', "Alibaba's metadata service, inside CGNAT space"],
  ['100.64.0.1', 'CGNAT'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
  ['198.18.0.1', 'the benchmarking range'],
  ['::1', 'IPv6 loopback'],
  ['::', 'the IPv6 unspecified address'],
  ['fe80::1', 'IPv6 link-local'],
  ['fd00::1', 'an IPv6 unique local address'],
  ['fc00::1', 'the other half of the ULA prefix'],
  ['::ffff:127.0.0.1', 'loopback smuggled inside a v4-mapped v6 address'],
  ['::ffff:169.254.169.254', 'the metadata service, v4-mapped'],
  ['64:ff9b::a00:1', 'a private v4 address behind NAT64'],
  ['not-an-address', 'anything that does not parse'],
] as const;

const ALLOWED = [
  ['93.184.216.34', 'a public v4 address'],
  ['8.8.8.8', 'another one'],
  ['172.32.0.1', 'just above the RFC 1918 /12'],
  ['172.15.255.255', 'just below it'],
  ['2606:4700::1111', 'a public v6 address'],
  ['::ffff:93.184.216.34', 'a public v4 address, v4-mapped'],
] as const;

for (const [address, why] of BLOCKED) {
  test(`classifyAddress refuses ${address} (${why})`, () => {
    assert.ok(classifyAddress(address), `${address} should have been refused`);
  });
}

for (const [address, why] of ALLOWED) {
  test(`classifyAddress allows ${address} (${why})`, () => {
    assert.equal(classifyAddress(address), null, `${address} should have been allowed`);
  });
}

test('parseIPv4 rejects the non-decimal octet forms used to bypass checkers', () => {
  // Historic SSRF bypasses: a parser that accepts these and a checker that does
  // not agree on what address is being connected to. Refusing them here means
  // classifyAddress falls through to the "not a recognised IP" refusal.
  for (const bad of ['0177.0.0.1', '0x7f.0.0.1', '127.0.0.01', '127.1', '+1.2.3.4', '1.2.3.256']) {
    assert.equal(parseIPv4(bad), null, `${bad} should not parse as dotted-quad`);
  }
  assert.equal(parseIPv4('127.0.0.1'), 0x7f000001);
});

test('expandIPv6 handles compression, an embedded v4 tail, and a zone id', () => {
  assert.deepEqual(expandIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.deepEqual(expandIPv6('fe80::1%eth0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(expandIPv6('gggg::1'), null);
  assert.equal(expandIPv6('1::2::3'), null);
});
