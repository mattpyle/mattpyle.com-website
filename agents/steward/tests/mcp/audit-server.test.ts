import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestEnv } from '../helpers/test-env.js';
import { startMcpHttpServer, MCP_PATH, type McpHttpServer } from '../../src/mcp/http.js';
import { GET_AUDIT_OUTPUT_SHAPE } from '../../src/mcp/get-audit-output.js';
import type { AuditResult } from '../../src/lib/agent-audit/result.js';

/**
 * End-to-end over the real transport: a real MCP client speaking Streamable HTTP
 * to the real server, backed by a real Temporal test server running the real
 * workflow, with only the audit activity itself mocked.
 *
 * Everything below the mocked activity is genuinely exercised — the tool's
 * workflow start, the resource templates, the status/report/summary reads, and
 * the refusals. What the checks find is `agent-audit-*.test.ts`'s job.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE_AUDIT = 'steward-audit';

let env: TestWorkflowEnvironment;
let server: McpHttpServer;
let endpoint: URL;

const AUDIT: AuditResult = {
  schemaVersion: 2,
  tool: { name: 'steward audit-url', version: '0.2.0' },
  target: { input: 'example.com', origin: 'https://example.com' },
  startedAt: '2026-08-11T00:00:00.000Z',
  finishedAt: '2026-08-11T00:00:04.000Z',
  durationMs: 4000,
  requests: 12,
  categories: [
    { category: 'crawlability', passed: 1, applicable: 1, notApplicable: 0, errors: 0 },
    { category: 'discovery', passed: 0, applicable: 1, notApplicable: 0, errors: 0 },
    { category: 'content-access', passed: 0, applicable: 0, notApplicable: 0, errors: 0 },
    { category: 'rendered-experience', passed: 0, applicable: 0, notApplicable: 0, errors: 0 },
  ],
  checks: [
    {
      id: 'robots-txt',
      title: 'robots.txt is served and parseable',
      category: 'crawlability',
      severity: 'high',
      status: 'pass',
      observed: '200 from /robots.txt',
      evidence: [],
    },
    {
      id: 'llms-txt',
      title: 'llms.txt exists and is a plain-text index',
      category: 'discovery',
      severity: 'medium',
      status: 'fail',
      observed: '404 from /llms.txt',
      fix: 'Serve a plain-text index at /llms.txt.',
      evidence: [],
    },
  ],
  notes: [],
};

/**
 * The one target whose audit fails, so the failure path is exercised over the
 * same transport as the happy one. The message is the shape the real activity
 * produces when the address check refuses a target, which is what the status
 * resource has to carry through rather than flatten into "it ended FAILED".
 */
const REFUSED_HOST = 'refused.example';
const REFUSAL = 'refused to audit https://refused.example/: resolves to a private address';

/**
 * The deep tier's three activities, mocked at the same boundary the fast tier is
 * mocked at. The fan-out itself is real: the workflow schedules the fetch pass,
 * one page, and assembly exactly as it would in production, so what this suite
 * exercises over the transport is the shape a client actually meets.
 */
const activities = {
  auditSiteFast: async (url: string) => {
    if (url.includes(REFUSED_HOST)) throw ApplicationFailure.nonRetryable(REFUSAL, 'BlockedTarget');
    return AUDIT;
  },
  auditSiteFetchChecks: async (url: string) => {
    if (url.includes(REFUSED_HOST)) throw ApplicationFailure.nonRetryable(REFUSAL, 'BlockedTarget');
    return {
      result: AUDIT,
      sample: [{ url: 'https://example.com/', disallowedBy: null }],
      available: 1,
    };
  },
  auditRenderedPage: async (input: { url: string }) => ({
    url: input.url,
    scores: { 'agentic-browsing': 96, accessibility: 100, seo: 100, performance: 99, 'best-practices': 100 },
    lighthouseVersion: '13.4.0',
    lighthouseError: null,
    violations: [],
    axeError: null,
    timedOut: false,
    blocked: { listed: [], total: 0 },
  }),
  assembleDeepAudit: async () => ({ ...AUDIT, browserPages: 3 }),
};

let workers: Worker[] = [];

before(async () => {
  env = await createTestEnv();
  const common = { connection: env.nativeConnection, workflowsPath, activities, bundlerOptions: {} };
  workers = [await Worker.create({ ...common, taskQueue: QUEUE_AUDIT })];
  for (const worker of workers) void worker.run();
  // Port 0: the OS picks a free one, so the suite cannot collide with a real
  // `steward mcp-serve` on the default port.
  server = await startMcpHttpServer({ client: env.client, host: '127.0.0.1', port: 0 });
  endpoint = new URL(`http://127.0.0.1:${server.port}${MCP_PATH}`);
}, { timeout: 180_000 });

after(async () => {
  await server?.close();
  for (const worker of workers) worker.shutdown();
  await env?.teardown();
});

/**
 * The text of a resource's one content block. Resource contents are text *or*
 * binary in the protocol's types, and every resource this server serves is text
 * — asserting that here is the narrowing.
 */
function textOf(read: { contents: Array<Record<string, unknown>> }): string {
  const [content] = read.contents;
  assert.equal(typeof content.text, 'string', 'resource content was not text');
  return content.text as string;
}

async function connect(): Promise<McpClient> {
  const client = new McpClient({ name: 'steward-audit-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  return client;
}

/** Reads the status resource until the audit is done, or gives up. */
async function pollUntilDone(client: McpClient, statusUri: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const read = await client.readResource({ uri: statusUri });
    const status = JSON.parse(textOf(read)) as Record<string, unknown>;
    if (status.done === true) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`audit never reported done: ${statusUri}`);
}

test('both tools and all three resource templates are advertised', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['audit_site', 'get_audit'],
    );
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.deepEqual(
      resourceTemplates.map((r) => r.uriTemplate).sort(),
      [
        'steward://audit/{workflowId}/report',
        'steward://audit/{workflowId}/status',
        'steward://audit/{workflowId}/summary',
      ],
    );
  } finally {
    await client.close();
  }
});

test('audit_site returns a workflow ID immediately, then the resources serve the report', async () => {
  const client = await connect();
  try {
    const started = Date.now();
    const call = await client.callTool({ name: 'audit_site', arguments: { url: 'example.com', fast: true } });
    const handedBack = Date.now() - started;

    const out = call.structuredContent as Record<string, string>;
    assert.match(out.workflowId, /^steward-audit-example\.com-fast-/);
    assert.equal(out.origin, 'https://example.com');
    assert.equal(out.tier, 'fast');
    assert.equal(out.statusUri, `steward://audit/${out.workflowId}/status`);
    // The point of the whole shape: the call returns a handle rather than the
    // result. Ten seconds is the card's own bar and this is nowhere near it.
    assert.ok(handedBack < 10_000, `tool took ${handedBack}ms to hand back a handle`);

    const status = await pollUntilDone(client, out.statusUri);
    assert.equal(status.phase, 'complete');
    assert.equal(status.execution, 'COMPLETED');
    assert.equal(status.url, 'example.com');

    const report = await client.readResource({ uri: out.reportUri });
    assert.equal(report.contents[0].mimeType, 'application/json');
    const document = JSON.parse(textOf(report)) as AuditResult;
    assert.equal(document.schemaVersion, 2);
    assert.equal(document.target.origin, 'https://example.com');
    assert.equal(document.checks.length, 2);

    const summary = await client.readResource({ uri: out.summaryUri });
    assert.equal(summary.contents[0].mimeType, 'text/markdown');
    // Derived from the same document, not measured again.
    assert.match(textOf(summary), /llms\.txt/);
  } finally {
    await client.close();
  }
});

test('the deep tier is the default — fast is opt-in', async () => {
  const client = await connect();
  try {
    const call = await client.callTool({ name: 'audit_site', arguments: { url: 'https://example.com/some/page' } });
    const out = call.structuredContent as Record<string, string>;
    assert.equal(out.tier, 'deep');
    // The unit audited is a site: the path the caller typed is dropped.
    assert.equal(out.origin, 'https://example.com');

    const status = await pollUntilDone(client, out.statusUri);
    assert.equal(status.tier, 'deep');
    const report = await client.readResource({ uri: out.reportUri });
    assert.equal((JSON.parse(textOf(report)) as AuditResult).browserPages, 3);
  } finally {
    await client.close();
  }
});

test('a target that is not a URL is refused by the tool, not by a started workflow', async () => {
  const client = await connect();
  try {
    const call = await client.callTool({ name: 'audit_site', arguments: { url: 'not a url' } });
    assert.equal(call.isError, true);
    assert.match(String((call.content as Array<{ text: string }>)[0].text), /is not a URL/);
  } finally {
    await client.close();
  }
});

test('a failed audit ends the polling loop and says what stopped it', async () => {
  const client = await connect();
  try {
    const call = await client.callTool({
      name: 'audit_site',
      arguments: { url: REFUSED_HOST, fast: true },
    });
    const out = call.structuredContent as Record<string, string>;

    // The whole point: the caller is told to poll until `done`, and a run that
    // failed is a run that is over. A `done` meaning COMPLETED alone would spin
    // here until the poll budget ran out.
    const status = await pollUntilDone(client, out.statusUri);
    assert.equal(status.done, true);
    assert.equal(status.succeeded, false);
    assert.equal(status.execution, 'FAILED');
    // The activity's own words, not "the audit ended FAILED": a refused target,
    // a heartbeat timeout and a crashed browser have to be distinguishable here.
    assert.equal(status.error, REFUSAL);

    await assert.rejects(() => client.readResource({ uri: out.reportUri }), new RegExp(REFUSAL));
  } finally {
    await client.close();
  }
});

/** The text of a tool call's one content block. */
function toolText(call: Record<string, unknown>): string {
  const [block] = call.content as Array<{ type: string; text?: string }>;
  assert.equal(block.type, 'text', 'tool content was not text');
  assert.equal(typeof block.text, 'string');
  return block.text as string;
}

test('get_audit serves the same three documents as the resources, byte for byte', async () => {
  const client = await connect();
  try {
    const call = await client.callTool({ name: 'audit_site', arguments: { url: 'example.com', fast: true } });
    const out = call.structuredContent as Record<string, string>;
    await pollUntilDone(client, out.statusUri);

    // The rule this enforces: a tool-only client (claude.ai, Claude desktop,
    // Cowork) must be able to reach exactly what a resource-capable one reads.
    // Not "equivalent" — identical, because the two go through one renderer.
    for (const view of ['status', 'report', 'summary'] as const) {
      const viaTool = await client.callTool({
        name: 'get_audit',
        arguments: { workflowId: out.workflowId, view },
      });
      const viaResource = await client.readResource({ uri: `steward://audit/${out.workflowId}/${view}` });
      assert.equal(toolText(viaTool), textOf(viaResource), `${view} differs between tool and resource`);
    }
  } finally {
    await client.close();
  }
});

test('get_audit declares an output schema, and every view it returns satisfies it', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === 'get_audit')?.outputSchema as
      | { type?: string; properties?: Record<string, { type?: string; properties?: object }> }
      | undefined;

    // The card this closes: no tool on either MCP surface describes its output in prose alone.
    assert.ok(schema, 'get_audit must publish an outputSchema');
    assert.equal(schema.type, 'object');
    // The field an outside client read as a list, which is the reason the schema exists.
    const progress = schema.properties?.progress;
    assert.equal(progress?.type, 'object');
    assert.deepEqual(Object.keys(progress?.properties ?? {}).sort(), ['checks', 'phase', 'steps']);

    const call = await client.callTool({ name: 'audit_site', arguments: { url: 'example.com', fast: true } });
    const out = call.structuredContent as Record<string, string>;
    await pollUntilDone(client, out.statusUri);

    // Parsed against the declaration directly, so a mismatch names the field rather than arriving
    // as a generic tool error. The documents are the real workflow's, not fixtures.
    for (const view of ['status', 'report', 'summary'] as const) {
      const result = await client.callTool({
        name: 'get_audit',
        arguments: { workflowId: out.workflowId, view },
      });
      assert.notEqual(result.isError, true, view);
      GET_AUDIT_OUTPUT_SHAPE.parse(result.structuredContent);
    }

    // Status and report stay the document itself; only summary is wrapped, and its markdown is the
    // same string as the text block beside it.
    const status = await client.callTool({
      name: 'get_audit',
      arguments: { workflowId: out.workflowId, view: 'status' },
    });
    assert.deepEqual(status.structuredContent, JSON.parse(toolText(status)));
    const summary = await client.callTool({
      name: 'get_audit',
      arguments: { workflowId: out.workflowId, view: 'summary' },
    });
    assert.deepEqual(summary.structuredContent, { view: 'summary', markdown: toolText(summary) });
  } finally {
    await client.close();
  }
});

test('get_audit defaults to the status view — the one that is always readable', async () => {
  const client = await connect();
  try {
    const call = await client.callTool({ name: 'audit_site', arguments: { url: 'example.com', fast: true } });
    const out = call.structuredContent as Record<string, string>;

    const first = await client.callTool({ name: 'get_audit', arguments: { workflowId: out.workflowId } });
    const status = JSON.parse(toolText(first)) as Record<string, unknown>;
    assert.equal(status.workflowId, out.workflowId);
    assert.equal(typeof status.done, 'boolean');
  } finally {
    await client.close();
  }
});

test('get_audit refuses a report that does not exist rather than inventing an empty one', async () => {
  const client = await connect();
  try {
    const call = await client.callTool({
      name: 'audit_site',
      arguments: { url: REFUSED_HOST, fast: true },
    });
    const out = call.structuredContent as Record<string, string>;
    await pollUntilDone(client, out.statusUri);

    const report = await client.callTool({
      name: 'get_audit',
      arguments: { workflowId: out.workflowId, view: 'report' },
    });
    assert.equal(report.isError, true);
    assert.match(toolText(report), new RegExp(REFUSAL));

    const unknown = await client.callTool({
      name: 'get_audit',
      arguments: { workflowId: 'steward-audit-nope-fast-0000', view: 'status' },
    });
    assert.equal(unknown.isError, true);
    assert.match(toolText(unknown), /No audit with workflow ID/);
  } finally {
    await client.close();
  }
});

test('an unknown workflow ID reads as a clear error rather than an empty report', async () => {
  const client = await connect();
  try {
    await assert.rejects(
      () => client.readResource({ uri: 'steward://audit/steward-audit-nope-fast-0000/report' }),
      /No audit with workflow ID/,
    );
  } finally {
    await client.close();
  }
});
