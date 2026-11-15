/**
 * The `SiteClient` on the site's public MCP endpoint: the same `audit_site`, `deep_audit` and
 * `get_audit` tools any outside agent calls, over HTTPS, with no credential. The audits draw on the
 * endpoint's public per-caller rate limit, keyed on this worker's address.
 *
 * `siteFacts` is the one call that is not an MCP tool: a plain GET of the site's public content
 * index on the same origin, also with no credential.
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
  };
}
