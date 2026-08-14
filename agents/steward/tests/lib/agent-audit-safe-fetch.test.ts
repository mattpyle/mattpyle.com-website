import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import dnsCallback from 'node:dns';
import type { AddressInfo } from 'node:net';
import { AUDIT_AGENT_TOKEN, TOOL_VERSION } from '../../src/lib/agent-audit/checks.js';
import {
  assertConnectableUrl,
  AUDIT_USER_AGENT,
  AUDIT_VERSION,
  BlockedTargetError,
  BudgetExhaustedError,
  DEFAULT_POLICY,
  SafeFetcher,
} from '../../src/lib/agent-audit/safe-fetch.js';

/**
 * The audit fetcher's behaviour against a real (local) server.
 *
 * The first test is the one the card asks for by name: a target that resolves
 * to a private address is refused **before any connection**, and the assertion
 * is on the server's connection counter, not just on the thrown error. A guard
 * that refuses after opening the socket has already made the request the guard
 * exists to prevent.
 */

interface Mock {
  origin: string;
  host: string;
  port: number;
  connections: number;
  close: () => Promise<void>;
}

async function mockServerOn(host: string, port: number, handler: http.RequestListener): Promise<Mock> {
  const server = http.createServer(handler);
  const state = { connections: 0 };
  server.on('connection', () => {
    state.connections++;
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo).port;
  return {
    origin: `http://${host}:${bound}`,
    host,
    port: bound,
    get connections() {
      return state.connections;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const mockServer = (handler: http.RequestListener): Promise<Mock> => mockServerOn('127.0.0.1', 0, handler);

interface AddressPair {
  port: number;
  vetted: Mock;
  rebound: Mock;
  close: () => Promise<void>;
}

/**
 * Two servers on the same port and different loopback addresses.
 *
 * The port has to match, because a pin carries an address and the URL carries
 * the port: if the two servers differed by port, a connection reaching the wrong
 * one would be impossible for reasons that have nothing to do with pinning and
 * the test would pass without testing anything. Binding the second one can lose
 * a race against an unrelated process taking the port, so it retries.
 */
async function addressPair(handler: http.RequestListener = (_req, res) => res.end('vetted')): Promise<AddressPair> {
  for (let attempt = 0; ; attempt++) {
    const vetted = await mockServerOn('127.0.0.2', 0, handler);
    try {
      const rebound = await mockServerOn('127.0.0.1', vetted.port, (_req, res) => res.end('rebound'));
      return {
        port: vetted.port,
        vetted,
        rebound,
        close: async () => {
          await vetted.close();
          await rebound.close();
        },
      };
    } catch (err) {
      await vetted.close();
      if (attempt >= 4) throw err;
    }
  }
}

/** The policy the check tests run under: this one mock host, nothing else. */
function testPolicy(extra: Record<string, unknown> = {}) {
  return { allowedPrivateHosts: ['127.0.0.1'], ...extra };
}

test('a target that resolves to a private address is refused before any connection', async (t) => {
  const mock = await mockServer((_req, res) => res.end('should never be reached'));
  t.after(() => mock.close());

  const fetcher = new SafeFetcher(); // default policy — the guard is on
  await assert.rejects(
    () => fetcher.fetch(`${mock.origin}/`),
    (err: unknown) => err instanceof BlockedTargetError && /loopback/.test(err.reason),
  );
  assert.equal(mock.connections, 0, 'the guard opened a socket before refusing');
});

test('the cloud metadata address is refused by literal', async () => {
  const fetcher = new SafeFetcher();
  await assert.rejects(
    () => fetcher.fetch('http://169.254.169.254/latest/meta-data/'),
    (err: unknown) => err instanceof BlockedTargetError && /link-local/.test(err.reason),
  );
});

test('non-http schemes and embedded credentials are refused', async () => {
  const fetcher = new SafeFetcher();
  await assert.rejects(
    () => fetcher.fetch('file:///etc/passwd'),
    (err: unknown) => err instanceof BlockedTargetError && /scheme/.test(err.reason),
  );
  await assert.rejects(
    () => fetcher.fetch('https://user:pass@example.com/'),
    (err: unknown) => err instanceof BlockedTargetError && /credentials/.test(err.reason),
  );
});

test('a redirect into a blocked address is refused, and the hop is never fetched', async (t) => {
  // The redirect chain is where a guard that only checks the URL it was given
  // leaks: the origin is public, and the Location points at the metadata
  // service. Following redirects by hand is what makes this catchable.
  const mock = await mockServer((_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  t.after(() => mock.close());

  const fetcher = new SafeFetcher(testPolicy());
  await assert.rejects(
    () => fetcher.fetch(`${mock.origin}/start`),
    (err: unknown) => err instanceof BlockedTargetError && /169\.254\.169\.254/.test(err.url),
  );
});

test('a redirect to another private host is refused even though the first hop was allowed', async (t) => {
  const mock = await mockServer((_req, res) => {
    res.writeHead(302, { location: 'http://10.0.0.5/internal' });
    res.end();
  });
  t.after(() => mock.close());

  const fetcher = new SafeFetcher(testPolicy());
  await assert.rejects(
    () => fetcher.fetch(`${mock.origin}/start`),
    (err: unknown) => err instanceof BlockedTargetError && /RFC 1918/.test(err.reason),
  );
});

test('same-origin redirects are followed and recorded', async (t) => {
  const mock = await mockServer((req, res) => {
    if (req.url === '/one') {
      res.writeHead(302, { location: '/two' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('arrived');
  });
  t.after(() => mock.close());

  const res = await new SafeFetcher(testPolicy()).fetch(`${mock.origin}/one`);
  assert.equal(res.status, 200);
  assert.equal(res.body, 'arrived');
  assert.equal(res.redirects.length, 1);
  assert.match(res.url, /\/two$/);
  assert.equal(res.requestedUrl, `${mock.origin}/one`);
});

test('a redirect loop stops at the cap', async (t) => {
  const mock = await mockServer((_req, res) => {
    res.writeHead(302, { location: '/again' });
    res.end();
  });
  t.after(() => mock.close());

  const fetcher = new SafeFetcher(testPolicy({ maxRedirects: 3 }));
  await assert.rejects(
    () => fetcher.fetch(`${mock.origin}/`),
    (err: unknown) => err instanceof BlockedTargetError && /more than 3 redirects/.test(err.reason),
  );
  // 4 requests: the original plus three followed hops.
  assert.equal(fetcher.requests, 4);
});

test('an oversized body is truncated rather than buffered whole', async (t) => {
  const mock = await mockServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    // Ten chunks of 100 KB — far past the 1 KB cap this test sets.
    for (let i = 0; i < 10; i++) res.write('x'.repeat(100 * 1024));
    res.end();
  });
  t.after(() => mock.close());

  const res = await new SafeFetcher(testPolicy({ maxBytes: 1024 })).fetch(`${mock.origin}/`);
  assert.equal(res.bytes, 1024);
  assert.equal(res.body.length, 1024);
  assert.equal(res.truncated, true);
});

test('a non-2xx status is a result, not an error', async (t) => {
  const mock = await mockServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  t.after(() => mock.close());

  const res = await new SafeFetcher(testPolicy()).fetch(`${mock.origin}/llms.txt`);
  assert.equal(res.status, 404);
  assert.equal(res.body, 'nope');
});

test('the total budget is shared across requests and refuses the next one', async (t) => {
  const mock = await mockServer((_req, res) => res.end('ok'));
  t.after(() => mock.close());

  // Constructed with a deadline already in the past: the budget is anchored on
  // the timestamp handed to the constructor, which is what lets one audit share
  // one clock across every check.
  const fetcher = new SafeFetcher(testPolicy({ totalBudgetMs: 1 }), Date.now() - 60_000);
  await assert.rejects(
    () => fetcher.fetch(`${mock.origin}/`),
    (err: unknown) => err instanceof BudgetExhaustedError,
  );
  assert.equal(mock.connections, 0);
});

test('a name resolving to both a public and a private address is refused whole', async (t) => {
  // The case the address table alone cannot cover, because it needs DNS to
  // answer with two records. A resolver that returns one routable address and
  // one internal one is the attack, not an invitation to connect to the
  // routable one — and which record `fetch` would actually pick is not this
  // code's decision to rely on.
  t.mock.method(dns, 'lookup', async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.7', family: 4 },
  ]);
  await assert.rejects(
    () => new SafeFetcher().fetch('http://split-horizon.test/'),
    (err: unknown) =>
      err instanceof BlockedTargetError &&
      /10\.0\.0\.7/.test(err.reason) &&
      /RFC 1918/.test(err.reason),
  );
});

test('an all-public DNS answer is allowed through the same path', async (t) => {
  // The control for the test above: two records, both routable, and the guard
  // gets out of the way. Without this, "refuses everything" would also pass.
  //
  // The guard is called on its own rather than through `fetch`, and that is a
  // consequence of pinning. This used to assert that `fetch` got past the guard
  // and died on a transport error, which worked only because `both-public.test`
  // does not resolve. Now the connection is pinned to whatever this mock
  // returns, so the same test would open a real socket to 93.184.216.34 — a
  // live request to somebody else's server, from a unit test. The property
  // under test is the guard's verdict, so the guard is what is called.
  t.mock.method(dns, 'lookup', async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700::1111', family: 6 },
  ]);
  await assert.doesNotReject(() => assertConnectableUrl('http://both-public.test/', DEFAULT_POLICY));
});

test('the connection goes to the address that was vetted, not to a swapped second answer', async (t) => {
  // DNS rebinding, closed. Two servers on the same port and different loopback
  // addresses: 127.0.0.2 is what the vetting lookup returns, 127.0.0.1 is what
  // the resolver answers the *second* time — the answer an unpinned connect
  // would use, because `net.connect` resolves the name again on its own.
  //
  // Loopback on both sides on purpose. The property is "the socket goes to the
  // address that was judged", and demonstrating it needs two addresses this
  // test can actually listen on; the exemption covers the classification, and
  // the pin is what is being measured.
  const pair = await addressPair();
  t.after(() => pair.close());

  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.2', family: 4 }]);
  const swapped = t.mock.method(dnsCallback, 'lookup', ((
    _host: string,
    _opts: unknown,
    cb: (err: null, addresses: Array<{ address: string; family: number }>) => void,
  ) => {
    cb(null, [{ address: '127.0.0.1', family: 4 }]);
  }) as typeof dnsCallback.lookup);

  const fetcher = new SafeFetcher({ allowedPrivateHosts: ['rebind.test'] });
  const res = await fetcher.fetch(`http://rebind.test:${pair.port}/`);

  assert.equal(res.body, 'vetted', 'the request landed on the rebound address');
  assert.equal(pair.rebound.connections, 0, 'the swapped answer was connected to');
  assert.equal(swapped.mock.callCount(), 0, 'the connect consulted a resolver a second time');
});

test('a swapped answer cannot reach a private address on a redirect hop either', async (t) => {
  // The same pin, on the hop the fetcher follows by hand. The first hop is
  // vetted and pinned; so is the second, from its own single lookup.
  const pair = await addressPair((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/moved' });
      return res.end();
    }
    res.end('vetted');
  });
  t.after(() => pair.close());

  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.2', family: 4 }]);
  t.mock.method(dnsCallback, 'lookup', ((
    _host: string,
    _opts: unknown,
    cb: (err: null, addresses: Array<{ address: string; family: number }>) => void,
  ) => {
    cb(null, [{ address: '127.0.0.1', family: 4 }]);
  }) as typeof dnsCallback.lookup);

  const fetcher = new SafeFetcher({ allowedPrivateHosts: ['rebind.test'] });
  await fetcher.fetch(`http://rebind.test:${pair.port}/start`);
  assert.equal(pair.rebound.connections, 0, 'a redirect hop escaped the pin');
});

test('the per-request timer covers the body read, not just the headers', async (t) => {
  // A server that answers headers instantly and then dribbles forever. Clearing
  // the timer once `fetch` resolves — which is what this did first — left this
  // hanging until the process died, past every cap the policy declares.
  const mock = await mockServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('start');
    // Never ends. The interval keeps the socket alive without finishing.
    const timer = setInterval(() => res.write('.'), 50);
    res.on('close', () => clearInterval(timer));
  });
  t.after(() => mock.close());

  const started = Date.now();
  await assert.rejects(() =>
    new SafeFetcher(testPolicy({ perRequestTimeoutMs: 400 })).fetch(`${mock.origin}/`),
  );
  assert.ok(Date.now() - started < 5000, 'the body read outlived the per-request timeout');
});

test('the per-request timer is capped by whatever is left of the audit budget', async (t) => {
  const mock = await mockServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('start');
    const timer = setInterval(() => res.write('.'), 50);
    res.on('close', () => clearInterval(timer));
  });
  t.after(() => mock.close());

  // Per-request allows 30s; the audit has ~500ms left. The shorter one wins.
  const started = Date.now();
  const fetcher = new SafeFetcher(
    testPolicy({ perRequestTimeoutMs: 30_000, totalBudgetMs: 500 }),
    Date.now(),
  );
  await assert.rejects(() => fetcher.fetch(`${mock.origin}/`));
  assert.ok(Date.now() - started < 5000, 'the request outlived the remaining audit budget');
});

test('the auditor identifies itself', async (t) => {
  let seen = '';
  const mock = await mockServer((req, res) => {
    seen = String(req.headers['user-agent'] ?? '');
    res.end('ok');
  });
  t.after(() => mock.close());

  await new SafeFetcher(testPolicy()).fetch(`${mock.origin}/`);
  assert.match(seen, /^steward-audit\//);
  assert.match(seen, /https:\/\/www\.mattpyle\.com\/steward/);
  assert.equal(seen, AUDIT_USER_AGENT);
});

test('the robots.txt token is the User-Agent product token', () => {
  // A site owner reads the product token out of an access log and writes it into robots.txt. If the
  // token the auditor obeys robots under is not the token it sends, that refusal does nothing and
  // the site owner has no way to tell — the auditor keeps arriving and keeps reporting itself as
  // allowed. Two constants in two files, so nothing but this holds them together.
  assert.equal(AUDIT_USER_AGENT.split('/')[0], AUDIT_AGENT_TOKEN);
});

test('one version describes the auditor everywhere it says so', () => {
  // The number in the User-Agent, the number stamped on every report, and the number both MCP
  // servers announce are one auditor's version. They were three different strings for a day after
  // the 0.2 rename, which sent a reader looking through a report headed 0.1.0 for the 0.2 the wire
  // had carried. `AUDIT_VERSION` is the source, and the User-Agent interpolates it, so what this
  // holds is that the interpolation is still there: a hand-edit back to a literal string is exactly
  // how the drift happened the first time. The site's copies are pinned by
  // tests/steward-page.test.mjs in the site repo.
  assert.equal(AUDIT_USER_AGENT.split('/')[1].split(' ')[0], AUDIT_VERSION);
  assert.equal(TOOL_VERSION, AUDIT_VERSION);
});

test('the User-Agent survives being passed to Chrome as a flag', () => {
  // The deep tier sends the same identity from Lighthouse's browser and axe's,
  // and `@axe-core/cli` takes its Chrome flags as one `--chrome-options` value
  // split on `[,;]`. A comma or a semicolon in here — the conventional
  // `(+url; description)` UA comment has one — reaches Chrome as two mangled
  // flags, and the audit still finishes, so nothing else would catch it.
  assert.doesNotMatch(AUDIT_USER_AGENT, /[,;]/);
});
