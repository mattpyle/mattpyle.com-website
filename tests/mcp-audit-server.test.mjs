import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAuditServer, originFor, SERVER_NAME, TOOL_NAME } from '../src/lib/mcp-audit-server.mjs';

// The MCP surface /mcp serves, driven by a real MCP client over an in-memory transport pair.
//
// A fake auditor rather than the real one, and that is the whole reason this module takes the audit
// as an argument: the questions here are protocol questions — is there exactly one tool, does the
// report come back in the call, does a bad URL come back as a tool error — and none of them need a
// site to audit. The real engine is Steward's, tested in its own suite.

/** A minimal document with the shape the tool's output schema declares. */
function auditFor(url) {
  return {
    schemaVersion: 2,
    tool: { name: 'steward audit-url', version: '0.2.0' },
    target: { input: url, origin: new URL(url.includes('://') ? url : `https://${url}`).origin },
    startedAt: '2026-08-12T15:00:00.000Z',
    finishedAt: '2026-08-12T15:00:04.000Z',
    durationMs: 4000,
    requests: 11,
    categories: [{ category: 'crawlability', passed: 3, failed: 1, notApplicable: 0, errored: 0 }],
    checks: [
      {
        id: 'llms-txt',
        title: 'llms.txt exists and follows the spec',
        category: 'discovery',
        severity: 'medium',
        status: 'fail',
        observed: '404 — no llms.txt',
        evidence: [{ url: `${url}/llms.txt`, status: 404 }],
        fix: 'Publish /llms.txt.',
      },
    ],
    notes: ['Run with --fast.'],
  };
}

/** A connected client and the calls the fake auditor received. */
async function connect({ runAudit } = {}) {
  const audited = [];
  // What the tool passed the auditor beside the URL: the caller's `fresh` and the origin the
  // shared result is keyed on. `audited` stays as it was so the older tests read unchanged.
  const asked = [];
  const server = createAuditServer({
    runAudit: runAudit ?? (async (url, options) => {
      audited.push(url);
      asked.push({ url, ...options });
      return auditFor(url);
    }),
    renderSummary: (audit) => `# Audit of ${audit.target.origin}\n\n1 failure.`,
    // The same normalisation Steward's `normaliseTarget` does: a bare hostname gets https, and the
    // parsed URL rides along so the scheme can be judged on something other than the origin.
    normaliseTarget: (input) => {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
      return { origin: url.origin, url };
    },
    // Injected the same way the audit itself is, and for the same reason: they belong to the
    // auditor in the Steward workspace, which this file does not import. src/pages/mcp.ts passes
    // the real ones. The values here are deliberately not the real ones, so a test that asserts on
    // them is asserting that the server used what it was given.
    version: '9.9.9',
    userAgent: 'test-audit/9.9.9 (+https://example.test/steward)',
  });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    server,
    audited,
    asked,
    close: () => Promise.all([client.close(), server.close()]),
  };
}

test('the server announces itself and its instructions on initialize', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  // The version and the User-Agent both come from the auditor, through the transport. A client asks
  // "what am I connected to" and a site owner asks "what arrived in my log", and one number answers
  // both — see AUDIT_VERSION in the Steward workspace's safe-fetch.ts.
  assert.equal(client.getServerVersion()?.version, '9.9.9');
  assert.match(client.getInstructions() ?? '', /agent-readiness/);
  assert.match(
    client.getInstructions() ?? '',
    /`test-audit\/9\.9\.9 \(\+https:\/\/example\.test\/steward\)`/
  );
});

test('without a Temporal connection, audit_site is the only tool', async (t) => {
  // The deep tools are registered only when the transport hands this module a connection to use.
  // A deployment without one — a local dev run, a preview — advertises the fast tool alone, rather
  // than two tools of which one always errors. That is the endpoint's degradation story stated
  // structurally instead of in a catch block.
  const { client, close } = await connect();
  t.after(close);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [TOOL_NAME]);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties ?? {}), ['url', 'fresh']);
  assert.deepEqual(
    tools[0].inputSchema.required ?? [],
    ['url'],
    'fresh is optional: a caller that has never heard of shared results still gets an audit',
  );
  assert.match(
    tools[0].description,
    /shared/,
    'a caller has to be told the result may be another caller-s, before it reads a timestamp',
  );
  assert.equal(tools[0].annotations?.readOnlyHint, true);
  assert.equal(tools[0].annotations?.openWorldHint, true);
});

test('the report comes back in the same call, as both JSON and markdown', async (t) => {
  // The design-input rule from the stage-2 card: every document a caller needs is reachable through
  // a tool, because chat clients call tools and cannot read resources. A synchronous call satisfies
  // it by construction — there is nothing left to fetch.
  const { client, audited, close } = await connect();
  t.after(close);

  const result = await client.callTool({ name: TOOL_NAME, arguments: { url: 'https://example.com' } });

  assert.deepEqual(audited, ['https://example.com']);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.schemaVersion, 2);
  assert.equal(result.structuredContent.checks[0].id, 'llms-txt');
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /# Audit of https:\/\/example\.com/);
});

test('the structured content survives the declared output schema', async (t) => {
  // The schema is a second copy of Steward's `result.ts` by definition, so the interesting failure
  // is drift: a strict copy would turn a good audit into an Output validation error and the caller
  // would get nothing. An extra field the schema never announced must pass through.
  const { client, close } = await connect({
    runAudit: async (url) => ({ ...auditFor(url), somethingNewInSchemaVersion3: true }),
  });
  t.after(close);

  const result = await client.callTool({ name: TOOL_NAME, arguments: { url: 'example.com' } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.somethingNewInSchemaVersion3, true);
});

test('decision classes reach the caller as data, and a report without them still validates', async (t) => {
  // The fixture above is a document from before decision classes existed, and every other test in
  // this file already proves it validates. This one is the other half: a current document carries
  // a class on each check and the per-class counts beside the categories, and both have to arrive
  // as structured data rather than only in the prose.
  const { client, close } = await connect({
    runAudit: async (url) => {
      const audit = auditFor(url);
      audit.checks[0].decisionClass = 'emergingConvention';
      audit.decisionClasses = { provenBlocker: 0, bestPractice: 0, conditional: 0, emergingConvention: 1 };
      return audit;
    },
  });
  t.after(close);

  const result = await client.callTool({ name: TOOL_NAME, arguments: { url: 'example.com' } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.checks[0].decisionClass, 'emergingConvention');
  assert.deepEqual(result.structuredContent.decisionClasses, {
    provenBlocker: 0,
    bestPractice: 0,
    conditional: 0,
    emergingConvention: 1,
  });
});

test('a target that is not a URL is a tool error, not an empty report', async (t) => {
  // An agent handed a 200 and an empty finding list summarises it as a clean site. Refusing loudly
  // is the only answer that cannot be misread.
  const { client, audited, close } = await connect();
  t.after(close);

  const result = await client.callTool({ name: TOOL_NAME, arguments: { url: 'not a url' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /is not a URL/);
  assert.deepEqual(audited, [], 'a target refused up front must not reach the auditor');
});

test('a non-http scheme is refused before anything is fetched', () => {
  // Judged on the parsed URL's protocol, not on its origin: a non-special scheme has the opaque
  // origin "null", so reading the scheme off the origin turned this refusal into `Invalid URL`.
  const normalise = (input) => {
    const url = new URL(input);
    return { origin: url.origin, url };
  };
  assert.throws(() => originFor('file:///etc/passwd', normalise), /Only http and https/);
  assert.throws(() => originFor('ftp://example.com', normalise), /Only http and https/);
  assert.equal(originFor('https://example.com/a/path', normalise), 'https://example.com');
});

test('an audit that throws reaches the caller as a tool error', async (t) => {
  // The fetch layer refusing a private address is the live case: it throws BlockedTargetError, and
  // a caller who pointed the auditor at 169.254.169.254 has to be told so.
  const { client, close } = await connect({
    runAudit: async () => {
      throw new Error('refused http://169.254.169.254/: link-local address');
    },
  });
  t.after(close);

  const result = await client.callTool({ name: TOOL_NAME, arguments: { url: 'http://169.254.169.254' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /link-local/);
});

test('the tool passes the auditor the origin it validated, and fresh defaults to false', async (t) => {
  const { client, asked, close } = await connect();
  t.after(close);

  await client.callTool({ name: TOOL_NAME, arguments: { url: 'example.com/a/path' } });
  assert.deepEqual(asked, [{ url: 'example.com/a/path', fresh: false, origin: 'https://example.com' }]);
});

test('fresh rides through to the auditor, and the origin is the key either spelling produces', async (t) => {
  const { client, asked, close } = await connect();
  t.after(close);

  await client.callTool({ name: TOOL_NAME, arguments: { url: 'https://example.com', fresh: true } });
  await client.callTool({ name: TOOL_NAME, arguments: { url: 'example.com', fresh: false } });

  assert.deepEqual(asked.map((call) => call.fresh), [true, false]);
  assert.deepEqual(
    asked.map((call) => call.origin),
    ['https://example.com', 'https://example.com'],
    'two spellings of one site must not become two audits',
  );
});

test('a non-boolean fresh is refused by the schema before anything is audited', async (t) => {
  const { client, asked, close } = await connect();
  t.after(close);

  const result = await client.callTool({
    name: TOOL_NAME,
    arguments: { url: 'https://example.com', fresh: 'yes' },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(asked, [], 'a refused call must not reach the auditor');
});
