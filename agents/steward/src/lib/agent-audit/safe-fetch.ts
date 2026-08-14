import dns from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { classifyAddress } from './net.js';
import { pinnedLookup, type PinnedAddress } from './pinning.js';

/**
 * The fetch layer every tier of `audit-url` rides on.
 *
 * Auditing a caller-supplied URL means this process makes requests on behalf of
 * a stranger, so the fetcher — not the checks — is where the safety properties
 * live (hosted-mcp-server card, "Security, binding from stage 0"):
 *
 * 1. **Resolve, judge, then connect to the address that was judged.** Every
 *    hostname is resolved once with `dns.lookup` and *all* returned addresses
 *    are classified before a socket is opened. One private address in the set
 *    refuses the whole request: a name that resolves to both a public and a
 *    private address is exactly the shape of the attack, not a reason to try the
 *    public one. The surviving addresses are then *pinned*: the request runs on
 *    an undici `Agent` whose `connect.lookup` answers from that vetted set and
 *    consults no resolver, so the address that was judged is the address the
 *    socket goes to. This is what closes DNS rebinding — see `pinning.ts` for
 *    the mechanism and why one lookup rather than two is the whole fix. SNI and
 *    certificate validation are unaffected, because undici sets `servername`
 *    from the URL and only the address resolution is overridden.
 * 2. **Every redirect hop is a new request.** Redirects are followed manually
 *    (`redirect: 'manual'`) so each `Location` goes through the same scheme,
 *    DNS, address and pinning path. Automatic following would hand the guard's
 *    job to undici, which does not do it.
 * 3. **Caps, all of them.** Redirect count, response bytes, per-request time,
 *    and a whole-audit time budget shared by every request.
 * 4. **It says who it is.** One honest User-Agent, pointing at a page that
 *    explains the traffic.
 *
 * The fetch used here is `undici`'s own rather than the global one, because a
 * dispatcher only applies to the client that created it: handing an `Agent`
 * built by the `undici` package to Node's built-in `fetch` mixes two copies of
 * the library. One import of both keeps the dispatcher and the fetch that reads
 * it the same code.
 *
 * The one connection this does *not* pin is a host in `allowedPrivateHosts`
 * whose name does not resolve, which is the tests' `example.test` and nothing
 * else. There is no flag that reaches that path from the CLI.
 */

/**
 * The one identity every request of an audit carries, whichever client makes it:
 * this fetcher, Lighthouse's Chrome, and axe's.
 *
 * **No commas and no semicolons in this string.** `@axe-core/cli` takes its
 * Chrome flags through `--chrome-options` and splits that value on `[,;]`, so a
 * UA comment in the conventional `(+url; description)` form arrives at Chrome as
 * two mangled flags. The description that used to live here moved to the page
 * the URL points at, which is where a person who looks this up in their logs is
 * going anyway. A test holds the property, because the failure it prevents is
 * silent: Chrome would start with a broken flag and the audit would still finish.
 */
export const AUDIT_USER_AGENT = 'steward-audit/0.2 (+https://www.mattpyle.com/steward)';

export interface FetchPolicy {
  /** How many `Location` hops to follow before giving up. */
  maxRedirects: number;
  /** Hard cap on a single response body. Bodies are truncated, not rejected. */
  maxBytes: number;
  /** Wall-clock cap on one request, including its body read. */
  perRequestTimeoutMs: number;
  /** Wall-clock cap on everything this fetcher does, across all requests. */
  totalBudgetMs: number;
  /**
   * Hostnames exempt from the address check. Empty everywhere but the tests,
   * which serve their mock sites on 127.0.0.1 — the address the guard exists to
   * refuse.
   *
   * A list of hosts rather than an `allowPrivateAddresses` boolean on purpose.
   * A boolean would switch the guard off wholesale, and then the tests that
   * matter most — a redirect from the mock origin to 169.254.169.254 must still
   * be refused — could not be written at all. Nothing in the CLI sets this;
   * there is no flag for it.
   */
  allowedPrivateHosts: string[];
}

export const DEFAULT_POLICY: FetchPolicy = {
  maxRedirects: 5,
  maxBytes: 5 * 1024 * 1024,
  perRequestTimeoutMs: 15_000,
  totalBudgetMs: 120_000,
  allowedPrivateHosts: [],
};

/** The target was refused before any connection was attempted. */
export class BlockedTargetError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`refused ${url}: ${reason}`);
    this.name = 'BlockedTargetError';
  }
}

/** The audit's total time budget ran out. Every remaining check reports it. */
export class BudgetExhaustedError extends Error {
  constructor(readonly url: string) {
    super(`audit time budget exhausted before fetching ${url}`);
    this.name = 'BudgetExhaustedError';
  }
}

export interface SafeResponse {
  /** The URL asked for. */
  requestedUrl: string;
  /** Where the redirect chain ended. Same as `requestedUrl` when there were none. */
  url: string;
  status: number;
  /** Lowercased header names — callers read `headers['content-type']`. */
  headers: Record<string, string>;
  /** Decoded as UTF-8, truncated at `maxBytes`. */
  body: string;
  truncated: boolean;
  bytes: number;
  /** Every hop's URL, in order, excluding the first request. */
  redirects: string[];
  elapsedMs: number;
}

export interface SafeFetchInit {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
}

/**
 * Runs the address guard over a URL string, for a caller that is about to
 * connect to it by some route other than this fetcher.
 *
 * The deep tier is that caller: Chrome navigates on its own, so the vetting the
 * fetcher would have done has to be done explicitly first. Throws
 * `BlockedTargetError` exactly as `fetch` would.
 */
export async function assertConnectableUrl(rawUrl: string, policy: FetchPolicy): Promise<void> {
  await vetConnectableUrl(rawUrl, policy);
}

/**
 * The same guard, handing back the addresses the connection must be pinned to.
 *
 * `null` means "connect without pinning", which happens for one case only: a
 * host in `allowedPrivateHosts` whose name does not resolve. That is the deep
 * tier's `example.test` fixture and nothing a caller can reach.
 *
 * `vetting-proxy.ts` uses this rather than `assertConnectableUrl`, because a
 * proxy that vetted an address and then let Chrome's socket resolve the name
 * again would have the same rebinding hole this fetcher just closed.
 */
export async function vetConnectableUrl(
  rawUrl: string,
  policy: FetchPolicy,
): Promise<PinnedAddress[] | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedTargetError(rawUrl, 'not a valid absolute URL');
  }
  return vetAndResolve(url, policy);
}

/**
 * Checks the scheme, resolves the name once, and classifies every address it
 * returned. What comes back is the pin for the connection that follows.
 */
async function vetAndResolve(url: URL, policy: FetchPolicy): Promise<PinnedAddress[] | null> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BlockedTargetError(url.href, `unsupported scheme "${url.protocol}" — only http and https are fetched`);
  }
  if (url.username || url.password) {
    // Credentials in a URL are both a smell and a way to make a target look
    // like a different host in a log line.
    throw new BlockedTargetError(url.href, 'the URL carries embedded credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const exempt = policy.allowedPrivateHosts.includes(hostname);

  let addresses: PinnedAddress[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    // An exempt host that does not resolve is the mock-origin fixture, which is
    // vetted and never actually connected to. Everything else is refused: a name
    // this process cannot resolve is not a name it should be opening a socket to.
    if (exempt) return null;
    throw new BlockedTargetError(url.href, `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (addresses.length === 0) {
    if (exempt) return null;
    throw new BlockedTargetError(url.href, 'DNS returned no addresses');
  }

  if (!exempt) {
    for (const { address } of addresses) {
      const reason = classifyAddress(address);
      // One bad address refuses the whole name — see the docblock.
      if (reason) throw new BlockedTargetError(url.href, `${hostname} resolves to ${reason}`);
    }
  }
  // Exempt or not, the connection is pinned to what this lookup returned. The
  // exemption is about which addresses are *allowed*, never about whether the
  // socket may go somewhere other than the one that was looked at.
  return addresses;
}

/** The response type of the undici `fetch` this module uses; not the DOM one. */
type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

/** Reads a response body with a hard byte cap, without buffering past it. */
async function readCapped(res: UndiciResponse, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (bytes + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - bytes));
      bytes = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}

/**
 * A fetcher bound to one audit: one policy, one shared time budget.
 *
 * Stateful on purpose — the budget is the state, and it has to be shared across
 * every check so a site that stalls on its sitemap cannot spend forever there
 * and then start fresh on llms.txt.
 */
export class SafeFetcher {
  readonly policy: FetchPolicy;
  private readonly deadline: number;
  private requestCount = 0;

  constructor(policy: Partial<FetchPolicy> = {}, now: number = Date.now()) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.deadline = now + this.policy.totalBudgetMs;
  }

  /** Milliseconds left in the audit's total budget; never negative. */
  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  /** How many HTTP requests this audit has made, redirect hops included. */
  get requests(): number {
    return this.requestCount;
  }

  /**
   * Fetches `rawUrl`, following redirects by hand.
   *
   * Throws `BlockedTargetError` for a refused target (including a refused
   * redirect hop), `BudgetExhaustedError` when the audit is out of time, and
   * whatever the platform throws for a transport failure. A non-2xx status is
   * *not* an error — "the surface is missing" is the finding half the checks
   * are looking for.
   */
  async fetch(rawUrl: string, init: SafeFetchInit = {}): Promise<SafeResponse> {
    const started = Date.now();
    const requestedUrl = rawUrl;
    const redirects: string[] = [];
    let current: URL;
    try {
      current = new URL(rawUrl);
    } catch {
      throw new BlockedTargetError(rawUrl, 'not a valid absolute URL');
    }

    for (let hop = 0; ; hop++) {
      const remaining = this.remainingMs();
      if (remaining <= 0) throw new BudgetExhaustedError(current.href);
      const pinned = await vetAndResolve(current, this.policy);

      // The timer covers the body read as well as the headers, and never
      // outlives the audit's own budget. Clearing it as soon as `fetch`
      // resolved — which is what this did first — left the body read
      // unbounded: a server that answers headers instantly and then dribbles
      // bytes forever would hold the audit open past every cap, which is the
      // cheapest way to stall an auditor and the exact thing `perRequestTimeoutMs`
      // claims to prevent. Aborting the signal after the response arrives
      // errors the body stream, so one timer covers both halves.
      const controller = new AbortController();
      const budgeted = Math.min(this.policy.perRequestTimeoutMs, remaining);
      const timeout = setTimeout(
        () => controller.abort(new Error(`request exceeded ${budgeted}ms (headers and body)`)),
        budgeted,
      );
      // One dispatcher per hop, because the pin is per hop: the addresses vetted
      // for this URL say nothing about the next `Location`, and a pooled agent
      // would carry one hop's pin into another hop's connection.
      const dispatcher = pinned ? new Agent({ connect: { lookup: pinnedLookup(pinned) } }) : undefined;
      try {
        this.requestCount++;
        const res = await undiciFetch(current.href, {
          method: init.method ?? 'GET',
          redirect: 'manual',
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
          headers: {
            'user-agent': AUDIT_USER_AGENT,
            accept: '*/*',
            // Forwarded to every hop, cross-origin included. Safe *because of
            // what is in here*: a product token and an Accept preference, and
            // never a cookie, an Authorization header or anything else that
            // would be a credential to leak to a redirect target. `fetch` is
            // called without credentials and nothing in this file adds any, so
            // there is no per-hop stripping to do. Adding a header that carries
            // authority to this call would change that, and would need the
            // same-origin filter this comment stands in for.
            ...init.headers,
          },
        });

        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          // The body of a redirect is never read; cancel it rather than leaking
          // the socket while we chase the Location.
          await res.body?.cancel().catch(() => {});
          if (hop >= this.policy.maxRedirects) {
            throw new BlockedTargetError(requestedUrl, `more than ${this.policy.maxRedirects} redirects`);
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new BlockedTargetError(current.href, `redirect to an unparseable Location: "${location}"`);
          }
          redirects.push(next.href);
          current = next;
          continue;
        }

        const headers: Record<string, string> = {};
        for (const [key, value] of res.headers) headers[key.toLowerCase()] = value;
        const { text, bytes, truncated } = await readCapped(res, this.policy.maxBytes);
        return {
          requestedUrl,
          url: current.href,
          status: res.status,
          headers,
          body: text,
          truncated,
          bytes,
          redirects,
          elapsedMs: Date.now() - started,
        };
      } finally {
        clearTimeout(timeout);
        // After the body has been read, which it has: the `return` above builds
        // its value before this runs. `destroy` rather than `close` so a
        // truncated body — cancelled mid-stream by the byte cap — does not leave
        // this waiting for a request that will never finish.
        if (dispatcher) await dispatcher.destroy().catch(() => {});
      }
    }
  }
}
