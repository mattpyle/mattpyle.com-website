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

export async function startMcpHttpServer(options: {
  client: Client;
  host: string;
  port: number;
}): Promise<McpHttpServer> {
  const httpServer = http.createServer((req, res) => {
    void handle(req, res, options.client);
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
    { server: SERVER_NAME, version: SERVER_VERSION, host: options.host, port, path: MCP_PATH },
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

async function handle(req: http.IncomingMessage, res: http.ServerResponse, client: Client): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

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
