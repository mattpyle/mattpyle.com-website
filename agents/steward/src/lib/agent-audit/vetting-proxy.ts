import http from 'node:http';
import net from 'node:net';
import type stream from 'node:stream';
import type { AddressInfo } from 'node:net';
import { pinnedLookup, type PinnedAddress } from './pinning.js';
import { BlockedTargetError, vetConnectableUrl, type FetchPolicy } from './safe-fetch.js';

/**
 * The address guard for the requests Chrome makes on its own.
 *
 * The deep tier vets the page it hands to the browser, and until this existed
 * that was the end of the guard's reach. A rendered page makes requests nobody
 * here chose: images, scripts, stylesheets, `fetch()` calls, and the target of
 * any redirect the page answers with. Chrome issues those itself, consulting
 * nothing. A page referencing `http://169.254.169.254/latest/meta-data/`, or a
 * sampled URL answering `302` to a private address, reached inside the network
 * the auditor runs in.
 *
 * A forward proxy is the mechanism because it is the one place *every* request
 * a browser makes has to pass through, whatever made it and whatever it is for.
 * Chrome is launched with `--proxy-server` pointed here and with the loopback
 * bypass removed, so there is no category of request that goes around it:
 *
 * - **Plain HTTP** arrives as an absolute-URI request. The URL is vetted with
 *   the same `net.ts` classification the fetcher uses, and the upstream socket
 *   is pinned to the vetted address, so the proxy cannot be rebound either.
 * - **HTTPS** arrives as `CONNECT host:port`. The host is vetted and the tunnel
 *   is pinned the same way. TLS stays end-to-end between Chrome and the site —
 *   nothing here terminates it, so there is no certificate to forge and no
 *   traffic to read.
 * - **Redirects are not followed here.** A 3xx is passed back to Chrome
 *   verbatim, and the request Chrome then makes for the new target comes back
 *   through this proxy and is vetted on its own terms. Following the hop inside
 *   the proxy would put the guard back in the position of trusting a `Location`.
 *
 * What it deliberately does not do: re-check robots.txt for a redirect target.
 * robots is a courtesy protocol the deep tier honours for the pages it *chooses*
 * to sample, and it is not a security boundary; conflating the two would make a
 * missing robots.txt look like a safety property. The sampled URL is still
 * robots-checked before Chrome sees it, as it always was.
 *
 * Two constraints shaped the choice. The worker runs on a Windows desktop, so a
 * Linux network namespace with no route to anything private was not available.
 * And Lighthouse numbers have to stay comparable with the scorecard's, which a
 * proxy affects and a namespace would not — the measured cost is in the build
 * log for the run that introduced this.
 */

/** One request the proxy refused, kept so the audit can report what it stopped. */
export interface BlockedRequest {
  /** The absolute URL for a plain request, or `https://host:port` for a tunnel. */
  url: string;
  reason: string;
}

export interface VettingProxy {
  port: number;
  /** Chrome flags, dashed, for a launcher that takes them that way (Lighthouse). */
  chromeFlags: string[];
  /** The same flags undashed, for `@axe-core/cli`'s `--chrome-options`. */
  chromeOptions: string[];
  /** Every refused request, in the order they arrived. */
  readonly blocked: BlockedRequest[];
  close(): Promise<void>;
}

/**
 * Headers that belong to one hop and must not be forwarded to the next.
 *
 * `proxy-connection` is the one that matters in practice: Chrome sends it to a
 * proxy and a target server has no idea what it is.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardableHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) out[key] = value;
  }
  return out;
}

function refusalReason(err: unknown): string {
  return err instanceof BlockedTargetError ? err.reason : err instanceof Error ? err.message : String(err);
}

/**
 * Starts the proxy on a loopback port and returns the flags that point Chrome
 * at it. Always paired with `close()`; the deep tier does that in a `finally`.
 */
export async function startVettingProxy(policy: FetchPolicy): Promise<VettingProxy> {
  const blocked: BlockedRequest[] = [];
  const server = http.createServer();
  // Nothing here should hold a connection open between pages; a browser that
  // has gone away must not keep the proxy's sockets alive.
  server.keepAliveTimeout = 5_000;

  server.on('request', (req, res) => {
    void handlePlain(req, res, policy, blocked);
  });
  server.on('connect', (req, socket, head) => {
    void handleTunnel(req, socket, head, policy, blocked);
  });
  // A socket erroring after the client walked away is ordinary here and must not
  // become an unhandled exception in the worker.
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  // `<-loopback>` *removes* loopback from Chrome's default bypass list, which is
  // the whole point: without it Chrome reaches 127.0.0.1 and ::1 directly and
  // the guard never sees the request. Chrome's own connection to the proxy is
  // not subject to the bypass list, so there is no loop.
  const flags = [`proxy-server=http://127.0.0.1:${port}`, 'proxy-bypass-list=<-loopback>'];

  return {
    port,
    chromeFlags: flags.map((f) => `--${f}`),
    chromeOptions: flags,
    blocked,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function handlePlain(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  policy: FetchPolicy,
  blocked: BlockedRequest[],
): Promise<void> {
  // A proxy request carries an absolute URI. Anything else is not a proxied
  // request at all — a browser talking to this port directly — and is refused
  // rather than guessed at.
  const target = req.url ?? '';
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    refuse(res, target, 'the proxy was sent a request that is not an absolute URL', blocked);
    return;
  }

  let pinned: PinnedAddress[] | null;
  try {
    pinned = await vetConnectableUrl(url.href, policy);
  } catch (err) {
    refuse(res, url.href, refusalReason(err), blocked);
    return;
  }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const upstream = http.request(
    {
      host: url.hostname,
      port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: forwardableHeaders(req.headers),
      // One socket per request, never pooled: a pooled socket is keyed by
      // host and port and would carry one request's pin into another's.
      agent: false,
      ...(pinned ? { lookup: pinnedLookup(pinned) } : {}),
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, forwardableHeaders(upRes.headers));
      upRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`audit proxy: upstream error for ${url.href}: ${err.message}`);
  });
  req.pipe(upstream);
}

async function handleTunnel(
  req: http.IncomingMessage,
  socket: stream.Duplex,
  head: Buffer,
  policy: FetchPolicy,
  blocked: BlockedRequest[],
): Promise<void> {
  // `CONNECT` carries `host:port` and no scheme. The scheme is supplied only so
  // the guard has a URL to parse; nothing about the check depends on it.
  const authority = req.url ?? '';
  let url: URL;
  try {
    url = new URL(`https://${authority}`);
  } catch {
    refuseTunnel(socket, `https://${authority}`, 'the proxy was sent an unparseable CONNECT target', blocked);
    return;
  }

  let pinned: PinnedAddress[] | null;
  try {
    pinned = await vetConnectableUrl(url.href, policy);
  } catch (err) {
    refuseTunnel(socket, url.href, refusalReason(err), blocked);
    return;
  }

  const upstream = net.connect({
    host: url.hostname,
    port: Number(url.port || 443),
    ...(pinned ? { lookup: pinnedLookup(pinned) } : {}),
  });
  upstream.on('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

function refuse(res: http.ServerResponse, url: string, reason: string, blocked: BlockedRequest[]): void {
  blocked.push({ url, reason });
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end(`audit proxy refused ${url}: ${reason}`);
}

function refuseTunnel(socket: stream.Duplex, url: string, reason: string, blocked: BlockedRequest[]): void {
  blocked.push({ url, reason });
  socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  socket.destroy();
}
