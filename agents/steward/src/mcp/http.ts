import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Client } from '@temporalio/client';
import { createAuditMcpServer, SERVER_NAME, SERVER_VERSION } from './audit-server.js';
import { log } from '../lib/logger.js';

/**
 * The MCP server over Streamable HTTP — the transport a tunnel can carry.
 *
 * **Stateless: one `McpServer` and one transport per request.** A session-based
 * server holds per-connection state in the memory of the process that served the
 * initialize call, which is exactly the state a tunnel reconnect, an ngrok
 * restart, or a client retry throws away. Nothing here needs a session: the tool
 * hands back a workflow ID and every resource read is answered from Temporal, so
 * the durable state lives in Temporal rather than in this process. That is the
 * whole point of putting a workflow behind it.
 *
 * `enableJsonResponse` for the same reason: a plain JSON body per request
 * survives a proxy that does not stream, and nothing here pushes.
 */

export interface McpHttpServer {
  port: number;
  close(): Promise<void>;
}

/** The one path. Named here because the operator has to type it into a client. */
export const MCP_PATH = '/mcp';

/**
 * The Host headers a loopback listener answers to.
 *
 * This is the DNS-rebinding defence. A page in the operator's own browser can
 * POST to `http://127.0.0.1:8765/mcp` — no-cors, no preflight, so CORS never
 * gets a say — or resolve a name it controls to a loopback address and reach the
 * same port with same-origin credentials. What separates the two cases is the
 * Host header: a browser sends whatever hostname the page used, and a name the
 * attacker owns is not one of these. Matching is on hostname alone, so the port
 * is free to change.
 *
 * IPv6 keeps its brackets, because that is what `new URL().hostname` returns.
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Why this is hand-rolled rather than the SDK's `enableDnsRebindingProtection`.
 *
 * That option is real, but in `@modelcontextprotocol/sdk` 1.30.0 it lives on the
 * deprecated SSE transport only. The Streamable HTTP transport dropped it, and
 * the replacement the SDK ships is Express middleware
 * (`server/middleware/hostHeaderValidation.js`) that answers through
 * `res.status().json()` — Express methods a `node:http` `ServerResponse` does
 * not have, and the module is outside the package's export map besides. The
 * semantics below are that middleware's: port-agnostic hostname compare, 403,
 * and a JSON-RPC error body.
 */
function hostIsAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return allowed.includes(hostname);
}

export async function startMcpHttpServer(options: {
  client: Client;
  host: string;
  port: number;
  /**
   * Hostnames allowed on top of the loopback set. The tunnel case: cloudflared
   * forwards the public request's Host, so a strict loopback list refuses every
   * request the one proven use of this server makes. Operator-supplied, per
   * session, and never a default.
   */
  allowedHosts?: string[];
}): Promise<McpHttpServer> {
  const allowedHosts = [...LOOPBACK_HOSTS, ...(options.allowedHosts ?? [])];
  const httpServer = http.createServer((req, res) => {
    void handle(req, res, options.client, allowedHosts);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  log.info(
    { server: SERVER_NAME, version: SERVER_VERSION, host: options.host, port, path: MCP_PATH, allowedHosts },
    'MCP server listening',
  );

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  client: Client,
  allowedHosts: string[],
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Before the routing, and for every path including /healthz: one rule, so a
  // second endpoint added later cannot be the one that forgot to check.
  if (!hostIsAllowed(req.headers.host, allowedHosts)) {
    log.warn({ host: req.headers.host, path: url.pathname }, 'MCP request refused: Host not allowed');
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Invalid Host: ${req.headers.host ?? '(missing)'}` },
        id: null,
      })}\n`,
    );
    return;
  }

  // A liveness probe that is not the MCP endpoint, so "is the tunnel up" can be
  // answered with a browser or a curl without speaking JSON-RPC at it.
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION })}\n`);
    return;
  }

  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify({ error: `not found — the MCP endpoint is ${MCP_PATH}` })}\n`);
    return;
  }

  const server = createAuditMcpServer(client);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // Both are closed when the response ends, whatever ended it. A per-request
  // server that is never closed leaks a listener per call, which on a long demo
  // is the difference between a tunnel that stays up and one that does not.
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    log.error({ err, path: url.pathname }, 'MCP request failed');
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(`${JSON.stringify({ error: 'internal error' })}\n`);
    }
  }
}
