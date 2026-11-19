/**
 * The `SiteClient` on the site's public MCP endpoint: the same `audit_site`, `deep_audit` and
 * `get_audit` tools any outside agent calls, over HTTPS, with no credential. The audits draw on the
 * endpoint's public per-caller rate limit, keyed on this worker's address.
 *
 * `siteFacts` and `fixLog` are the two calls that are not MCP tools: each is a plain GET of a page
 * the site publishes on the same origin, also with no credential. `fixLog` reads at most
 * `FIX_LOG_MAX_BYTES` and gives up after ten seconds.
 *
 * The client says what it is: `clientInfo.name` is `audit-consultant`, which the site's activity
 * page shows, and the User-Agent names the agent and points at the site.
 *
 * Errors never carry the server's text onward. A JSON-RPC refusal becomes a reason code; a failed
 * connection becomes a generic error the activity's retry policy handles.
 */
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { SiteCall, SiteClient } from './activities.js';

export const CLIENT_NAME = 'audit-consultant';
export const CLIENT_VERSION = '0.1.0';
export const USER_AGENT = `${CLIENT_NAME}/${CLIENT_VERSION} (+https://www.mattpyle.com/steward)`;

/** The site's public content index, on the endpoint's own origin. The WebMCP tools read the same file. */
export const SITE_FACTS_PATH = '/webmcp/index.json';
const SITE_FACTS_TIMEOUT_MS = 10_000;

/** The site's published fix log as markdown, on the endpoint's own origin. */
export const FIX_LOG_PATH = '/fix-log.md';
const FIX_LOG_TIMEOUT_MS = 10_000;
/** The most bytes of the fix log this client reads. The page is about 20 KB with 78 entries. */
export const FIX_LOG_MAX_BYTES = 512 * 1024;

/** The body as text, or null once it passes `maxBytes`. */
async function textUpTo(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The endpoint's own code for a refusal by its rate limiter. */
const RATE_LIMITED_CODE = -32000;

/** `fetchImpl` is for tests; the worker uses the global fetch. */
export function mcpSiteClient(endpoint: URL, fetchImpl?: typeof fetch): SiteClient {
  if (endpoint.protocol !== 'https:') throw new Error('the MCP endpoint must be https:');

  async function call(name: string, args: Record<string, unknown>): Promise<SiteCall> {
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { 'User-Agent': USER_AGENT } },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) return { ok: false, reason: 'error' };
      return { ok: true, data: result.structuredContent ?? null };
    } catch (err) {
      if (err instanceof ProtocolError) {
        return { ok: false, reason: err.code === RATE_LIMITED_CODE ? 'rate_limited' : 'error' };
      }
      // A transport failure: retryable, and stated without the underlying message.
      throw new Error(`could not reach the MCP endpoint for ${name}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  return {
    fastAudit: (origin) => call('audit_site', { url: origin }),
    startDeepAudit: (origin) => call('deep_audit', { url: origin }),
    readDeepAudit: (workflowId, view) => call('get_audit', { workflowId, view }),
    async siteFacts() {
      let response: Response;
      try {
        response = await (fetchImpl ?? fetch)(new URL(SITE_FACTS_PATH, endpoint), {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(SITE_FACTS_TIMEOUT_MS),
        });
      } catch {
        // A transport failure: retryable, and stated without the underlying message.
        throw new Error('could not reach the site for its facts');
      }
      if (!response.ok) return { ok: false, reason: 'error' };
      try {
        return { ok: true, data: await response.json() };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },
    async fixLog() {
      try {
        const response = await (fetchImpl ?? fetch)(new URL(FIX_LOG_PATH, endpoint), {
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/markdown' },
          signal: AbortSignal.timeout(FIX_LOG_TIMEOUT_MS),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, reason: 'error' };
        }
        const text = await textUpTo(response, FIX_LOG_MAX_BYTES);
        return text === null ? { ok: false, reason: 'error' } : { ok: true, data: text };
      } catch {
        // A transport failure or a timeout: retryable, and stated without the underlying message.
        throw new Error('could not reach the site for its fix log');
      }
    },
  };
}
