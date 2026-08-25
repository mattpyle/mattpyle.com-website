import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createAuditServer,
  DEEP_TOOL_NAME,
  GET_AUDIT_OUTPUT_SHAPE,
  GET_AUDIT_TOOL_NAME,
  TOOL_NAME,
} from '../src/lib/mcp-audit-server.mjs';

// The deep tier's two tools, driven by a real MCP client over an in-memory transport pair, with a
// fake Temporal in place of the real one.
//
// The questions here are protocol questions, and the reason `createAuditServer` takes the deep
// engine as an argument is that none of them need Temporal Cloud: is the async shape actually
// async, does a caller learn the audit is unfinished, does a failing read come back as a tool error
// a client can see rather than as a transport failure, and does the fast tier keep working when
// the deep half is broken. What a real deep audit finds is Steward's suite's job.

function connect({ startAudit, readView, deep = true } = {}) {
  const started = [];
  const reads = [];
  const server = createAuditServer({
    runAudit: async (url) => ({
      schemaVersion: 2,
      tool: { name: 'steward audit-url', version: '0.2.0' },
      target: { input: url, origin: 'https://example.com' },
      startedAt: '2026-08-15T15:00:00.000Z',
      finishedAt: '2026-08-15T15:00:04.000Z',
      durationMs: 4000,
      requests: 11,
      categories: [],
      checks: [],
      notes: [],
    }),
    renderSummary: (audit) => `# Audit of ${audit.target.origin}`,
    normaliseTarget: (input) => {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
      return { origin: url.origin, url };
    },
    version: '9.9.9',
    userAgent: 'test-audit/9.9.9 (+https://example.test/steward)',
    ...(deep
      ? {
          deep: {
            startAudit:
              startAudit ??
              (async (origin, url) => {
                started.push({ origin, url });
                return { workflowId: 'steward-audit-example.com-deep-1a2b3c4d' };
              }),
            readView:
              readView ??
              (async (workflowId, view) => {
                reads.push({ workflowId, view });
                return `{"workflowId":"${workflowId}","view":"${view}"}\n`;
              }),
          },
        }
      : {}),
  });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return Promise.all([client.connect(clientTransport), server.connect(serverTransport)]).then(
    () => ({ client, started, reads, close: () => Promise.all([client.close(), server.close()]) }),
  );
}

test('with a connection, three tools are listed: the fast one and the deep pair', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [TOOL_NAME, DEEP_TOOL_NAME, GET_AUDIT_TOOL_NAME]);
});

test('deep_audit is annotated as a write, and get_audit as an idempotent read', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  // It starts a durable run against a third party's origin and spends real browser time doing it.
  // Two calls are two audits, so it is not idempotent either.
  assert.equal(byName[DEEP_TOOL_NAME].annotations?.readOnlyHint, false);
  assert.equal(byName[DEEP_TOOL_NAME].annotations?.idempotentHint, false);
  assert.equal(byName[DEEP_TOOL_NAME].annotations?.openWorldHint, true);

  // A read of a run's own state, which reaches nothing outside this system.
  assert.equal(byName[GET_AUDIT_TOOL_NAME].annotations?.readOnlyHint, true);
  assert.equal(byName[GET_AUDIT_TOOL_NAME].annotations?.idempotentHint, true);
  assert.equal(byName[GET_AUDIT_TOOL_NAME].annotations?.openWorldHint, false);
});

test('deep_audit returns a handle and says in words that there are no findings in it', async (t) => {
  const { client, started, close } = await connect();
  t.after(close);

  const result = await client.callTool({
    name: DEEP_TOOL_NAME,
    arguments: { url: 'example.com' },
  });

  // The origin is normalised before the workflow is started, and the caller's exact input rides
  // along — the workflow input records what was typed, the ID records what was audited.
  assert.deepEqual(started, [{ origin: 'https://example.com', url: 'example.com' }]);
  assert.equal(result.structuredContent.workflowId, 'steward-audit-example.com-deep-1a2b3c4d');
  assert.equal(result.structuredContent.tier, 'deep');
  assert.match(result.structuredContent.nextStep, /get_audit/);

  // The text half matters more than the structured half here. A model reading a successful tool
  // result as a finished audit will summarise an empty report as a clean site, which is the exact
  // failure the report-shape invariant exists for on the other end.
  const text = result.content.map((part) => part.text).join('\n');
  assert.match(text, /not finished/);
  assert.match(text, /no findings in this response/);
  assert.match(text, /steward-audit-example\.com-deep-1a2b3c4d/);
});

test('a target that is not a URL is refused before any workflow is started', async (t) => {
  const { client, started, close } = await connect();
  t.after(close);

  const result = await client.callTool({ name: DEEP_TOOL_NAME, arguments: { url: 'not a url' } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /is not a URL/);
  assert.deepEqual(started, [], 'a malformed target must cost no workflow start');
});

test('a private address is refused before any workflow is started', async (t) => {
  const { client, started, close } = await connect();
  t.after(close);

  const result = await client.callTool({
    name: DEEP_TOOL_NAME,
    arguments: { url: 'file:///etc/passwd' },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /http and https/);
  assert.deepEqual(started, []);
});

test('get_audit defaults to status and passes the view straight through', async (t) => {
  const { client, reads, close } = await connect();
  t.after(close);

  await client.callTool({ name: GET_AUDIT_TOOL_NAME, arguments: { workflowId: 'wf-1' } });
  await client.callTool({
    name: GET_AUDIT_TOOL_NAME,
    arguments: { workflowId: 'wf-1', view: 'report' },
  });
  await client.callTool({
    name: GET_AUDIT_TOOL_NAME,
    arguments: { workflowId: 'wf-1', view: 'summary' },
  });

  // Status is the default because it is the one view that is always readable — report and summary
  // are an error until the run ends.
  assert.deepEqual(reads, [
    { workflowId: 'wf-1', view: 'status' },
    { workflowId: 'wf-1', view: 'report' },
    { workflowId: 'wf-1', view: 'summary' },
  ]);
});

test('get_audit carries the JSON views as data, and the markdown one as text alone', async (t) => {
  const documents = {
    status: `${JSON.stringify({ workflowId: 'wf-1', done: false, queued: true }, null, 2)}\n`,
    report: `${JSON.stringify({ schemaVersion: 2, checks: REPORT.checks }, null, 2)}\n`,
    summary: '# Audit of https://example.com\n',
  };
  const { client, close } = await connect({ readView: async (_id, view) => documents[view] });
  t.after(close);

  for (const view of ['status', 'report']) {
    const result = await client.callTool({
      name: GET_AUDIT_TOOL_NAME,
      arguments: { workflowId: 'wf-1', view },
    });
    // Deep-equal to the parse of its own text block, because the structured half is that parse and
    // nothing else. Any reshaping here would be a second measurement able to disagree with the
    // first, which is the thing the one-readView rule exists to prevent.
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text), view);
  }

  // Markdown has no document to carry as data, so its structured half is the one-field envelope
  // and nothing else — the markdown in it is the same string as the text block, not a second
  // rendering of it.
  const summary = await client.callTool({
    name: GET_AUDIT_TOOL_NAME,
    arguments: { workflowId: 'wf-1', view: 'summary' },
  });
  assert.deepEqual(summary.structuredContent, { view: 'summary', markdown: documents.summary });
  assert.equal(summary.content[0].text, documents.summary);
});

// The four documents `get_audit` can hand back, written the way src/lib/mcp-temporal.mjs assembles
// them. Deliberately verbatim rather than generated: a fixture that is built from the same code the
// schema is checked against would agree with itself no matter what either one said.
const STATUS_MID_RUN = {
  workflowId: 'steward-audit-example.com-deep-1a2b3c4d',
  url: 'example.com',
  tier: 'deep',
  execution: 'RUNNING',
  phase: 'auditing',
  note: 'rendering https://example.com/about',
  done: false,
  succeeded: false,
  queued: false,
  startedAt: '2026-08-24T18:00:00.000Z',
  // The field the first outside client mis-parsed: an object, not a list.
  progress: {
    phase: 'rendering',
    steps: [
      { id: 'fetch', kind: 'fetch', label: 'HTTP checks', state: 'done' },
      { id: 'page:https://example.com/about', kind: 'page', label: '/about', state: 'running' },
      { id: 'assembly', kind: 'assembly', label: 'Assemble the report', state: 'pending' },
    ],
    checks: [{ id: 'robots-txt', title: 'robots.txt parses', status: 'pass' }],
  },
  pending: [
    {
      activityType: 'auditRenderedPage',
      activityId: '2',
      attempt: 2,
      state: 'started',
      lastFailure: 'Chrome did not start',
    },
  ],
};

const STATUS_DONE = {
  workflowId: 'steward-audit-example.com-deep-1a2b3c4d',
  url: 'example.com',
  tier: 'deep',
  execution: 'COMPLETED',
  phase: 'complete',
  note: '18 of 24 checks passed',
  done: true,
  succeeded: true,
  queued: false,
  startedAt: '2026-08-24T18:00:00.000Z',
  finishedAt: '2026-08-24T18:01:09.000Z',
  progress: { phase: 'complete', steps: [], checks: [] },
  integrity: { status: 'clean' },
};

const REPORT = {
  schemaVersion: 2,
  tool: { name: 'steward audit-url', version: '0.2.0', userAgent: 'steward-audit/0.2.0' },
  target: { input: 'example.com', origin: 'https://example.com' },
  startedAt: '2026-08-24T18:00:00.000Z',
  finishedAt: '2026-08-24T18:01:09.000Z',
  durationMs: 69574,
  requests: 15,
  browserPages: 3,
  integrity: { status: 'clean' },
  categories: [{ category: 'crawlability', passed: 1, applicable: 1, notApplicable: 0, errors: 0 }],
  decisionClasses: { provenBlocker: 0, bestPractice: 2, conditional: 1, emergingConvention: 3 },
  checks: [
    {
      id: 'robots-txt',
      title: 'robots.txt parses',
      category: 'crawlability',
      severity: 'high',
      decisionClass: 'provenBlocker',
      status: 'pass',
      observed: 'robots.txt parsed, 12 agents allowed at /',
    },
  ],
  notes: [],
};

test('get_audit declares an output schema, and it says progress is an object', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const { tools } = await client.listTools();
  const schema = tools.find((tool) => tool.name === GET_AUDIT_TOOL_NAME)?.outputSchema;

  // The whole point of the card: every tool on this endpoint publishes its output shape, so a
  // client never has to infer one from prose.
  assert.ok(schema, 'get_audit must publish an outputSchema');
  assert.equal(schema.type, 'object');

  // The field an outside client read as a list, and the reason this schema exists.
  const progress = schema.properties?.progress;
  assert.equal(progress?.type, 'object');
  assert.deepEqual(Object.keys(progress.properties ?? {}).sort(), ['checks', 'phase', 'steps']);
  assert.equal(progress.properties.steps.type, 'array');

  // And the summary view's envelope, the one view that has a shape of its own.
  assert.equal(schema.properties?.markdown?.type, 'string');
});

test('the declared schema accepts every document get_audit actually returns', async (t) => {
  const documents = {
    status: `${JSON.stringify(STATUS_MID_RUN, null, 2)}\n`,
    report: `${JSON.stringify(REPORT, null, 2)}\n`,
    summary: '# Audit of https://example.com\n\n18 of 24 checks passed.\n',
  };
  const { client, close } = await connect({ readView: async (_id, view) => documents[view] });
  t.after(close);

  // Parsed directly, so a mismatch names the field rather than surfacing as a generic tool error.
  for (const [label, document] of [
    ['status, mid-run', STATUS_MID_RUN],
    ['status, done', STATUS_DONE],
    ['report', REPORT],
    ['summary', { view: 'summary', markdown: documents.summary }],
  ]) {
    assert.doesNotThrow(() => GET_AUDIT_OUTPUT_SHAPE.parse(document), label);
  }

  // And through the server, which validates the structured half against this same schema before it
  // answers — so a call that comes back without isError is the declaration holding on the wire.
  for (const view of ['status', 'report', 'summary']) {
    const result = await client.callTool({
      name: GET_AUDIT_TOOL_NAME,
      arguments: { workflowId: 'wf-1', view },
    });
    assert.notEqual(result.isError, true, view);
    assert.ok(result.structuredContent, view);
  }

  // The status and report views stay the document itself, byte for byte with the text beside them.
  // Wrapping either one in an envelope to make the schema tidier would break that, and would break
  // every client already reading them.
  const status = await client.callTool({
    name: GET_AUDIT_TOOL_NAME,
    arguments: { workflowId: 'wf-1', view: 'status' },
  });
  assert.deepEqual(status.structuredContent, STATUS_MID_RUN);

  // The summary still reads as markdown to a person, in the text block and in the envelope.
  const summary = await client.callTool({
    name: GET_AUDIT_TOOL_NAME,
    arguments: { workflowId: 'wf-1', view: 'summary' },
  });
  assert.equal(summary.content[0].text, documents.summary);
  assert.equal(summary.structuredContent.markdown, documents.summary);
});

test('an unreachable Temporal is a tool error, never a dropped request', async (t) => {
  // The stage-3 card's degradation line. An agent can act on a JSON-RPC error that names the
  // cause; it can only guess at a gateway timeout with no body.
  const { client, close } = await connect({
    startAudit: async () => {
      throw new Error('The deep tier could not reach Temporal: Temporal Cloud did not answer within 8s.');
    },
    readView: async () => {
      throw new Error('The deep tier could not reach Temporal: Temporal Cloud did not answer within 8s.');
    },
  });
  t.after(close);

  for (const call of [
    { name: DEEP_TOOL_NAME, arguments: { url: 'example.com' } },
    { name: GET_AUDIT_TOOL_NAME, arguments: { workflowId: 'wf-1' } },
  ]) {
    const result = await client.callTool(call);
    assert.equal(result.isError, true, call.name);
    assert.match(result.content[0].text, /could not reach Temporal/, call.name);
  }

  // And the fast tier, in the same server, is untouched by any of it.
  const fast = await client.callTool({ name: TOOL_NAME, arguments: { url: 'example.com' } });
  assert.notEqual(fast.isError, true);
  assert.equal(fast.structuredContent.target.origin, 'https://example.com');
});

test('the instructions describe the deep tier only when it is there', async (t) => {
  const withDeep = await connect();
  t.after(withDeep.close);
  const withoutDeep = await connect({ deep: false });
  t.after(withoutDeep.close);

  const deepInstructions = withDeep.client.getInstructions() ?? '';
  const fastInstructions = withoutDeep.client.getInstructions() ?? '';

  assert.match(deepInstructions, /deep_audit/);
  assert.match(deepInstructions, /Powered by Temporal/);
  assert.doesNotMatch(fastInstructions, /deep_audit/);
  // The fast-only server has to say what it does *not* do, or a caller reads the missing category
  // as a clean one.
  assert.match(fastInstructions, /Lighthouse, axe\) are not part of this endpoint/);
});
