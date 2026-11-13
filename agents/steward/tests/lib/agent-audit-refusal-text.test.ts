import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import {
  BLOCKED_REASON_MARKERS,
  BlockedTargetError,
  DEFAULT_POLICY,
  SafeFetcher,
} from '../../src/lib/agent-audit/safe-fetch.js';
import { startVettingProxy } from '../../src/lib/agent-audit/vetting-proxy.js';
import { blockedFrom, refusalFor } from '../../src/lib/agent-audit/deep.js';
import { blockedNotes } from '../../src/lib/agent-audit/deep-assemble.js';

/**
 * A refusal for a private address says only that the address is private. The text reaches a
 * caller by four routes: a check's `observed` line (fast tier), the activity's failure message,
 * a skipped page's note (deep tier) and the vetting proxy's blocked-request notes and 403 body.
 * All four are built from `BlockedTargetError.reason`, so this test drives each source of that
 * reason with resolver answers of every shape the guard classifies, and fails if any text a caller
 * can read carries the address, its range name or its family.
 */

/** One DNS answer per way `classifyAddress` words a refusal. */
const ANSWERS: Array<{ name: string; addresses: Array<{ address: string; family: number }> }> = [
  { name: 'rfc1918', addresses: [{ address: '10.0.0.7', family: 4 }] },
  { name: 'loopback', addresses: [{ address: '127.0.0.1', family: 4 }] },
  { name: 'link-local metadata', addresses: [{ address: '169.254.169.254', family: 4 }] },
  { name: 'split horizon', addresses: [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }] },
  { name: 'v4-mapped v6', addresses: [{ address: '::ffff:192.168.1.9', family: 6 }] },
  { name: 'unique local v6', addresses: [{ address: 'fd12:3456:789a::1', family: 6 }] },
  { name: '6to4', addresses: [{ address: '2002:c0a8:101::1', family: 6 }] },
];

/** What a caller must not be able to read: an address, a CIDR, a range name or a family. */
const LEAKS: RegExp[] = [
  /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, // any IPv4 literal
  /[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f:.]*/i, // any IPv6 literal
  /\/\d{1,3}\b/, // a CIDR suffix
  /RFC|loopback|link-local|tunnel|benchmark|documentation|unique|multicast|unicast|IPv[46]|family/i,
];

function assertClean(text: string, what: string): void {
  for (const re of LEAKS) assert.doesNotMatch(text, re, `${what} leaks ${re}: ${text}`);
  assert.ok(text.includes('private address'), `${what} no longer says the address is private: ${text}`);
}

function viaProxy(port: number, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: new URL(url).host }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

for (const answer of ANSWERS) {
  test(`a private-address refusal names no address: ${answer.name}`, async (t) => {
    t.mock.method(dns, 'lookup', async () => answer.addresses);
    const warn = t.mock.method(console, 'warn', () => {});
    const url = 'http://internal.example/admin';

    // Fast tier and the activity: both read `reason` / `message` off this error.
    const err = await new SafeFetcher().fetch(url).then(
      () => assert.fail('the guard let a private address through'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof BlockedTargetError);
    assert.ok(err.reason.includes(BLOCKED_REASON_MARKERS.privateAddress), '/audit matches on this fragment');
    assertClean(err.reason, 'reason');
    assertClean(err.message, 'message');
    // `asBlockedFailure` in activities/agent-audit.ts interpolates exactly these two fields.
    assertClean(`refused to audit ${err.url}: ${err.reason}`, 'activity failure message');

    // Deep tier, sampled page.
    assertClean((await refusalFor(url, DEFAULT_POLICY)) ?? '', 'refusalFor');

    // Deep tier, Chrome's own requests: the 403 body, the recorded reason and the report notes.
    const proxy = await startVettingProxy(DEFAULT_POLICY);
    t.after(() => proxy.close());
    assertClean(await viaProxy(proxy.port, url), 'proxy 403 body');
    assert.equal(proxy.blocked.length, 1);
    assertClean(proxy.blocked[0].reason, 'proxy blocked reason');
    for (const note of blockedNotes(blockedFrom(proxy))) assertClean(note, 'blocked note');

    // The worker's own log still says what the name resolved to.
    const logged = warn.mock.calls.map((c) => String(c.arguments[0])).join('\n');
    const record = JSON.parse(logged.split('\n')[0]);
    assert.equal(record.event, 'audit-refused-private-address');
    assert.equal(record.host, 'internal.example');
    assert.deepEqual(record.addresses, answer.addresses.map((a) => a.address));
    assert.ok(record.reason.length > 0);
  });
}
