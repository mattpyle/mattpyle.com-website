import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import dnsCallback from 'node:dns';
import net, { type AddressInfo } from 'node:net';
import { DEFAULT_POLICY, type FetchPolicy } from '../../src/lib/agent-audit/safe-fetch.js';
import { startVettingProxy, type VettingProxy } from '../../src/lib/agent-audit/vetting-proxy.js';

/**
 * The guard over the requests a browser makes for itself.
 *
 * Chrome is not launched here, and does not need to be: the proxy is the whole
 * mechanism, and what reaches it is an ordinary proxied HTTP request. The tests
 * speak the same protocol Chrome speaks — an absolute-URI request for plain
 * HTTP, a `CONNECT` for TLS — so a subresource, a redirect target and a
 * top-level navigation are literally the same thing arriving at the same place,
 * which is the property that made one mechanism close two gaps.
 *
 * `agent-audit-deep.test.ts` covers the other half: that the deep tier starts
 * one of these and hands its flags to both tools.
 */

interface Mock {
  origin: string;
  port: number;
  requests: string[];
  connections: number;
  close: () => Promise<void>;
}

async function mockServer(handler: http.RequestListener): Promise<Mock> {
  const requests: string[] = [];
  const state = { connections: 0 };
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    handler(req, res);
  });
  server.on('connection', () => {
    state.connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    get connections() {
      return state.connections;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface ProxiedResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * One request through the proxy, in the form a browser sends it: the absolute
 * URI on the request line, and no redirect following. Not following is the point
 * — a browser decides what to do with a 3xx and comes back through the proxy for
 * the new target, and this test client has to behave the same way to see that.
 */
function throughProxy(proxy: VettingProxy, url: string): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        method: 'GET',
        path: url,
        headers: { host: target.host, 'proxy-connection': 'keep-alive' },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A `CONNECT` through the proxy: what Chrome sends for any https subresource. */
function tunnelThroughProxy(proxy: VettingProxy, authority: string): Promise<{ established: boolean; status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      agent: false,
    });
    // Node's client emits `connect` for *any* response to a CONNECT, refusals
    // included — it is "the server answered", not "the tunnel is open". Only a
    // 200 means the proxy joined the two sockets.
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve({ established: res.statusCode === 200, status: res.statusCode ?? 0 });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ established: false, status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });
}

function policy(over: Partial<FetchPolicy> = {}): FetchPolicy {
  return { ...DEFAULT_POLICY, ...over };
}

test('a subresource pointed at a blocked address is refused, and nothing connects to it', async (t) => {
  // The gap this closes, in its original form: a rendered page whose `<img>` or
  // `fetch()` points at the cloud metadata service. Chrome would have made that
  // request itself, having consulted nothing.
  const proxy = await startVettingProxy(policy());
  t.after(() => proxy.close());

  const res = await throughProxy(proxy, 'http://169.254.169.254/latest/meta-data/');
  assert.equal(res.status, 403);
  assert.match(res.body, /link-local/);
  assert.deepEqual(
    proxy.blocked.map((b) => b.url),
    ['http://169.254.169.254/latest/meta-data/'],
  );
});

test('an allowed subresource reaches the site unchanged', async (t) => {
  // The control. Without it, "refuses everything" would pass the test above.
  const site = await mockServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('body{}');
  });
  t.after(() => site.close());
  const proxy = await startVettingProxy(policy({ allowedPrivateHosts: ['127.0.0.1'] }));
  t.after(() => proxy.close());

  const res = await throughProxy(proxy, `${site.origin}/style.css`);
  assert.equal(res.status, 200);
  assert.equal(res.body, 'body{}');
  assert.equal(res.headers['content-type'], 'text/css');
  assert.deepEqual(site.requests, ['/style.css']);
  assert.deepEqual(proxy.blocked, []);
});

test('a top-level redirect is handed back rather than followed, and its target is vetted on its own', async (t) => {
  // The second gap, and the reason one mechanism covers both. The proxy does not
  // chase the `Location`: it returns the 302 to the browser, and the request the
  // browser then makes for the new target arrives here as a request like any
  // other and is refused on its own address.
  const site = await mockServer((_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  t.after(() => site.close());
  const proxy = await startVettingProxy(policy({ allowedPrivateHosts: ['127.0.0.1'] }));
  t.after(() => proxy.close());

  const first = await throughProxy(proxy, `${site.origin}/sampled-page`);
  assert.equal(first.status, 302, 'the proxy followed the redirect itself');
  assert.equal(first.headers.location, 'http://169.254.169.254/latest/meta-data/');
  assert.deepEqual(proxy.blocked, [], 'nothing was refused before the browser asked for the target');

  const followed = await throughProxy(proxy, String(first.headers.location));
  assert.equal(followed.status, 403);
  assert.match(followed.body, /link-local/);
  assert.equal(proxy.blocked.length, 1);
});

test('a CONNECT to a blocked host never opens a tunnel', async (t) => {
  // Everything https a page pulls in arrives as a CONNECT, so a proxy that
  // vetted only plain requests would cover almost nothing a real site loads.
  const proxy = await startVettingProxy(policy());
  t.after(() => proxy.close());

  const res = await tunnelThroughProxy(proxy, '169.254.169.254:443');
  assert.equal(res.established, false, 'a tunnel to a link-local address was established');
  assert.equal(res.status, 403);
  assert.deepEqual(
    proxy.blocked.map((b) => b.url),
    ['https://169.254.169.254/'],
  );
});

test('a name that resolves to a private address is refused whichever way it arrives', async (t) => {
  // The address is what is judged, not the string. A hostname is the ordinary
  // case for a subresource, and a resolver that answers with an internal address
  // is the ordinary way to smuggle one in.
  t.mock.method(dns, 'lookup', async () => [{ address: '10.1.2.3', family: 4 }]);
  const proxy = await startVettingProxy(policy());
  t.after(() => proxy.close());

  const plain = await throughProxy(proxy, 'http://internal.example/admin');
  assert.equal(plain.status, 403);
  assert.match(plain.body, /RFC 1918/);

  const tunnel = await tunnelThroughProxy(proxy, 'internal.example:443');
  assert.equal(tunnel.established, false);
  assert.equal(tunnel.status, 403);
});

test('the proxy connects to the address it vetted, not to a swapped second answer', async (t) => {
  // The proxy has its own connect path, so it needs its own proof that the pin
  // is applied there. Same shape as the fetcher's rebinding test: two servers on
  // one port and two loopback addresses, the vetting lookup naming one and the
  // resolver naming the other.
  const vetted = await listenOn('127.0.0.2', 0, 'vetted');
  const rebound = await listenOn('127.0.0.1', vetted.port, 'rebound');
  t.after(async () => {
    await vetted.close();
    await rebound.close();
  });

  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.2', family: 4 }]);
  t.mock.method(dnsCallback, 'lookup', ((
    _host: string,
    _opts: unknown,
    cb: (err: null, addresses: Array<{ address: string; family: number }>) => void,
  ) => {
    cb(null, [{ address: '127.0.0.1', family: 4 }]);
  }) as typeof dnsCallback.lookup);

  const proxy = await startVettingProxy(policy({ allowedPrivateHosts: ['rebind.test'] }));
  t.after(() => proxy.close());

  const res = await throughProxy(proxy, `http://rebind.test:${vetted.port}/asset.js`);
  assert.equal(res.body, 'vetted');
  assert.equal(rebound.connections, 0, 'the proxy connected to the swapped answer');
});

interface Bound {
  port: number;
  connections: number;
  close: () => Promise<void>;
}

/** One server, one fixed body, on a named loopback address. */
async function listenOn(host: string, port: number, body: string): Promise<Bound> {
  const state = { connections: 0 };
  const server = http.createServer((_req, res) => res.end(body));
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
  return {
    port: (server.address() as AddressInfo).port,
    get connections() {
      return state.connections;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * The regression test for the 2026-08-15 hosted-worker failure.
 *
 * `close()` runs in `auditRenderedPage`'s `finally`, so a `close()` that never
 * resolves is an activity that never returns. The first deep audit on Railway
 * rendered its page, logged the result, and was then timed out and retried by
 * the server; the second attempt succeeded and was discarded the same way. The
 * finished report carried `browserPages=0` after ten minutes.
 *
 * The cause was an open `CONNECT` tunnel: the hijacked client socket and the
 * upstream socket spliced to it were both untracked, and the upstream half was
 * torn down only on `error`, so a tunnel that ended *cleanly* — which is what
 * killing a browser does — left a live socket for `server.close()` to wait on.
 *
 * This test holds a real tunnel open across `close()`, which is the state Chrome
 * leaves behind, and asserts the promise settles well inside the activity's
 * deadline.
 */
test('close resolves promptly with a CONNECT tunnel still open', { timeout: 15_000 }, async (t) => {
  const site = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  // `closeAllConnections` first: the tunnel this test opens is a live connection
  // to this server, and a bare `close()` would wait for it and hang the suite.
  t.after(() => {
    site.closeAllConnections();
    site.close();
  });
  const sitePort = (site.address() as AddressInfo).port;

  const proxy = await startVettingProxy(policy({ allowedPrivateHosts: ['127.0.0.1'] }));

  // Open a tunnel and deliberately leave it open, exactly as a browser that is
  // about to be killed does. CRLF built with explicit escapes: a bare LF request
  // line is not a CONNECT the proxy will answer, and a test that silently fails
  // to open a tunnel would "pass" this assertion for the wrong reason.
  const request =
    `CONNECT 127.0.0.1:${sitePort} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${sitePort}\r\n` +
    '\r\n';

  const tunnel = await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => socket.write(request));
    socket.once('data', (chunk) => {
      // Assert the tunnel actually opened. Without this the test would still
      // pass if the proxy answered 403, which exercises none of what it guards.
      assert.match(chunk.toString(), /^HTTP\/1\.1 200 /, 'the CONNECT tunnel did not open');
      resolve(socket);
    });
    socket.once('error', reject);
  });
  t.after(() => tunnel.destroy());

  const started = Date.now();
  await proxy.close();
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < 5_000,
    `close() took ${elapsed}ms with a tunnel open — it must not wait on sockets the server cannot reach`,
  );
});
