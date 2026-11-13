/**
 * The `SiteClient` on the site's public MCP endpoint: the same `audit_site`, `deep_audit` and
 * `get_audit` tools any outside agent calls, over HTTPS, with no credential. The audits draw on the
 * endpoint's public per-caller rate limit, keyed on this worker's address.
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
  };
}
