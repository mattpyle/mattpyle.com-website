import dns from 'node:dns/promises';
import { classifyAddress } from './net.js';

/**
 * The fetch layer every tier of `audit-url` rides on.
 *
 * Auditing a caller-supplied URL means this process makes requests on behalf of
 * a stranger, so the fetcher — not the checks — is where the safety properties
 * live (hosted-mcp-server card, "Security, binding from stage 0"):
 *
 * 1. **Resolve, then judge, then connect.** Every hostname is resolved with
 *    `dns.lookup` and *all* returned addresses are classified before a socket is
 *    opened. One private address in the set refuses the whole request: a name
 *    that resolves to both a public and a private address is exactly the shape
 *    of the attack, not a reason to try the public one.
 * 2. **Every redirect hop is a new request.** Redirects are followed manually
 *    (`redirect: 'manual'`) so each `Location` goes through the same scheme,
 *    DNS and address checks. Automatic following would hand the guard's job to
 *    undici, which does not do it.
 * 3. **Caps, all of them.** Redirect count, response bytes, per-request time,
 *    and a whole-audit time budget shared by every request.
 * 4. **It says who it is.** One honest User-Agent, pointing at a page that
 *    explains the traffic.
 *
 * Known residual risk, stated rather than papered over: DNS rebinding. The
 * address is checked, then Node resolves the name again when it connects, and
 * a hostile resolver can answer differently the second time. Closing that
 * requires pinning the connection to the vetted IP with a custom undici
 * dispatcher (and carrying the SNI/Host header by hand), which is a bigger
 * change than this slice needs. It is a real gap for a *hosted* auditor —
 * revisit before stage 2 puts this behind a public endpoint.
 */

export const AUDIT_USER_AGENT =
  'steward-audit-url/0.1 (+https://www.mattpyle.com/agents.md; agent-readiness auditor)';

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
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedTargetError(rawUrl, 'not a valid absolute URL');
  }
  await assertConnectable(url, policy);
}

/** Checks the scheme and resolves + classifies every address behind a URL. */
async function assertConnectable(url: URL, policy: FetchPolicy): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BlockedTargetError(url.href, `unsupported scheme "${url.protocol}" — only http and https are fetched`);
  }
  if (url.username || url.password) {
    // Credentials in a URL are both a smell and a way to make a target look
    // like a different host in a log line.
    throw new BlockedTargetError(url.href, 'the URL carries embedded credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (policy.allowedPrivateHosts.includes(hostname)) return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new BlockedTargetError(url.href, `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (addresses.length === 0) throw new BlockedTargetError(url.href, 'DNS returned no addresses');

  for (const { address } of addresses) {
    const reason = classifyAddress(address);
    // One bad address refuses the whole name — see the docblock.
    if (reason) throw new BlockedTargetError(url.href, `${hostname} resolves to ${reason}`);
  }
}

/** Reads a response body with a hard byte cap, without buffering past it. */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
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
      await assertConnectable(current, this.policy);

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
      try {
        this.requestCount++;
        const res = await fetch(current.href, {
          method: init.method ?? 'GET',
          redirect: 'manual',
          signal: controller.signal,
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
      }
    }
  }
}
