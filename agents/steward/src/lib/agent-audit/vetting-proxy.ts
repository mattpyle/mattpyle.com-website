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
 * A forward proxy is the mechanism because it is the one place every HTTP-shaped
 * request a browser makes has to pass through, whatever made it and whatever it
 * is for. Chrome is launched with `--proxy-server` pointed here and with the
 * loopback bypass removed, so no HTTP-shaped request goes around it:
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
 * **WebRTC is the traffic a proxy does not see**, and it is why the sentence
 * above says HTTP-shaped rather than everything. A page can open a peer
 * connection and send STUN over UDP, which `--proxy-server` does not govern at
 * all; the addresses it reaches are private ones by design, since host discovery
 * is what STUN is for. `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
 * is on the launch flags for that: it confines WebRTC to transports the proxy
 * carries, and TURN over TCP then arrives here as an ordinary `CONNECT` and is
 * vetted like any other. What that leaves is a browser setting rather than a
 * boundary this code enforces, so the flag is asserted by a test.
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
/**
 * How long {@link VettingProxy.close} will wait for a graceful shutdown before
 * destroying whatever is left and resolving anyway.
 *
 * Short on purpose. By the time this runs the page is rendered and the result
 * is in hand, so every millisecond here is spent tidying up after work that
 * already succeeded. Five seconds is far past a healthy close and far inside the
 * activity's 5-minute deadline.
 */
const CLOSE_TIMEOUT_MS = 5_000;

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

  /**
   * Every socket this proxy is responsible for, client side and upstream alike.
   *
   * `server.close()` waits for the server's connections to end, and
   * `closeAllConnections()` reaches the ones the HTTP server still tracks. A
   * `CONNECT` tunnel is neither: the socket is hijacked out of the server by the
   * `connect` event, and the upstream socket it is spliced to was never the
   * server's at all. Without this set, `close()` waits on sockets it has no way
   * to reach — which is exactly what wedged the first hosted deep audit
   * (2026-08-15, see `close` below).
   */
  const sockets = new Set<stream.Duplex>();
  const track = (socket: stream.Duplex): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  server.on('request', (req, res) => {
    track(req.socket);
    void handlePlain(req, res, policy, blocked);
  });
  server.on('connect', (req, socket, head) => {
    track(socket);
    void handleTunnel(req, socket, head, policy, blocked, track);
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

  // The three flags that make this proxy inescapable, undashed because that is
  // the form `@axe-core/cli` wants; none of them may contain a comma or a
  // semicolon, which is what that CLI splits its `--chrome-options` value on.
  //
  // `<-loopback>` *removes* loopback from Chrome's default bypass list, which is
  // the whole point: without it Chrome reaches 127.0.0.1 and ::1 directly and
  // the guard never sees the request. Chrome's own connection to the proxy is
  // not subject to the bypass list, so there is no loop.
  //
  // `disable_non_proxied_udp` is the WebRTC half, and it belongs on this object
  // rather than beside the audit's identity flag because it exists only because
  // a proxy exists: it takes away the one transport a peer connection could use
  // to reach a private address without passing through here. See the docblock.
  const flags = [
    `proxy-server=http://127.0.0.1:${port}`,
    'proxy-bypass-list=<-loopback>',
    'force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];

  return {
    port,
    chromeFlags: flags.map((f) => `--${f}`),
    chromeOptions: flags,
    blocked,
    /**
     * **A cleanup step must never be able to hang the work it is cleaning up
     * after.** This one could, and did.
     *
     * The first deep audit on the hosted worker (2026-08-15) rendered its page
     * successfully, logged the result, and then never returned: `close()` runs
     * in the activity's `finally`, and the promise below never resolved. The
     * server timed the activity out after its 5-minute `startToCloseTimeout`,
     * retried it, rendered the same page successfully a second time, and threw
     * that away too. The finished report carried `browserPages=0` after ten
     * minutes of work — a total failure of the deep tier reported as a
     * completed run.
     *
     * Two causes, both fixed above. The tunnel sockets were untracked, so
     * `closeAllConnections()` could not reach them; and `handleTunnel` tore the
     * upstream socket down only on `error`, so a browser that closed its
     * tunnels *cleanly* on exit — which is what killing Chrome does — leaked
     * one live upstream socket per tunnel for `server.close()` to wait on
     * forever. It did not reproduce on Windows, where the sockets were already
     * gone by the time this ran.
     *
     * Destroying the tracked sockets is the fix. The timeout is the belt: no
     * future socket this set fails to cover can cost more than
     * `CLOSE_TIMEOUT_MS`, because a proxy that will not shut down must not be
     * able to fail an audit that already succeeded.
     */
    close: () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };

        const destroyAll = (): void => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
        };

        const timer = setTimeout(() => {
          destroyAll();
          finish();
        }, CLOSE_TIMEOUT_MS);
        // Never hold the process open on the backstop itself.
        timer.unref();

        destroyAll();
        server.closeAllConnections();
        server.close(() => finish());
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
  track: (socket: stream.Duplex) => void,
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
  // The upstream half belongs to this proxy too, and `close()` has to be able to
  // reach it — the server never knew about it.
  track(upstream);
  upstream.on('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  // **`close`, not just `error`.** Tearing the peer down only on `error` leaks
  // the other half of every tunnel that ends cleanly, and killing a browser ends
  // its tunnels cleanly. Each leaked upstream socket was one more thing
  // `server.close()` waited on forever.
  upstream.on('error', () => socket.destroy());
  upstream.on('close', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
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
