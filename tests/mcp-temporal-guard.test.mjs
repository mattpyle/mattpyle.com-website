import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { WorkflowNotFoundError } from '@temporalio/client';
import { AUDIT_WORKFLOW_TYPE } from '@mattpyle/steward/agent-audit/deep-contract';
import { createAuditServer, GET_AUDIT_TOOL_NAME } from '../src/lib/mcp-audit-server.mjs';
import { createAuditReadersForTests } from '../src/lib/mcp-temporal.mjs';
import { respond } from '../src/lib/a2a-responder.mjs';
import { GET_TASK_METHOD } from '../src/lib/a2a-audit-skill.mjs';

// The shared read path refuses anything that is not an audit, the same way for `/mcp` and `/a2a`.
//
// A fake Temporal client stands in for the real one. With `forbidAll` it fails the test if a
// refused id reaches it, and it records every call so "refused before any query" is an assertion.

const digest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/data/a2a-digest.json', import.meta.url)), 'utf8'),
);

const AUDIT_ID = 'steward-audit-example.com-deep-1a2b3c4d';
const OTHER_RUN_ID = 'steward-other-run-2026-11-13T05:31:49Z';
const STRANGER_ID = 'finding/mattpyle-com/not-a-real-key';
const WRONG_TYPE_ID = 'steward-audit-looks-like-one-deep-00000000';
const MISSING_ID = 'steward-audit-missing-deep-00000000';

const REPORT = {
  schemaVersion: 3,
  tool: { name: 'steward-audit', version: '0.2.0' },
  target: { input: 'example.com', origin: 'https://example.com' },
  checks: [],
};

/**
 * A fake client. `runs` maps a workflow id to `{ type, status, state }`; an id not in the map is a
 * missing run. `calls` records each Temporal touch, in order.
 */
function fakeTemporal(runs, { forbidAll = false } = {}) {
  const calls = [];
  const touch = (what) => {
    calls.push(what);
    if (forbidAll) assert.fail(`a refused id reached Temporal: ${what}`);
  };
  const client = {
    workflow: {
      getHandle(id) {
        touch(`getHandle ${id}`);
        const run = runs[id];
        return {
          async describe() {
            calls.push(`describe ${id}`);
            if (!run) throw new WorkflowNotFoundError('not found', id, undefined);
            return {
              type: run.type,
              status: { name: run.status ?? 'COMPLETED' },
              startTime: new Date('2026-11-12T00:00:00Z'),
              closeTime: new Date('2026-11-12T00:01:00Z'),
              pendingActivities: [],
              raw: { pendingActivities: [] },
            };
          },
          async query(name) {
            calls.push(`query ${id} ${name}`);
            return run.state;
          },
        };
      },
      list() {
        calls.push('list');
        return (async function* () {})();
      },
    },
  };
  const clientFor = async () => {
    touch('getClient');
    return client;
  };
  return { client, calls, clientFor };
}

const auditState = { url: 'https://example.com', phase: 'done', note: 'complete', result: REPORT };
const RUNS = {
  [AUDIT_ID]: { type: AUDIT_WORKFLOW_TYPE, status: 'COMPLETED', state: auditState },
  [OTHER_RUN_ID]: { type: 'SomeOtherWorkflow', status: 'COMPLETED', state: { secret: 'x' } },
};
const WRONG_TYPE_RUNS = { [WRONG_TYPE_ID]: { type: 'SomeOtherWorkflow', state: { secret: 'x' } } };

const renderSummary = (audit) => `# Audit of ${audit.target.origin}`;

test('an id that is not an audit id never reaches Temporal', async () => {
  const { clientFor } = fakeTemporal(RUNS, { forbidAll: true });
  const readers = createAuditReadersForTests(clientFor);
  for (const id of [STRANGER_ID, OTHER_RUN_ID, '', 'steward-audit-', '../x']) {
    for (const view of ['status', 'report', 'summary']) {
      await assert.rejects(readers.readAuditView(id, view, renderSummary), /No audit with workflow ID/);
    }
    await assert.rejects(readers.readAuditSnapshot(id), /No audit with workflow ID/);
  }
});

test('an audit-shaped id on another workflow type is refused after describe, before any query', async () => {
  const fake = fakeTemporal(WRONG_TYPE_RUNS);
  const readers = createAuditReadersForTests(fake.clientFor);
  for (const view of ['status', 'report', 'summary']) {
    await assert.rejects(readers.readAuditView(WRONG_TYPE_ID, view, renderSummary), /No audit with workflow ID/);
  }
  await assert.rejects(readers.readAuditSnapshot(WRONG_TYPE_ID), /No audit with workflow ID/);
  assert.ok(fake.calls.some((call) => call.startsWith('describe')));
  assert.deepEqual(fake.calls.filter((call) => call.startsWith('query') || call === 'list'), []);
});

test('every refusal carries the message a missing audit carries', async () => {
  const readers = createAuditReadersForTests(fakeTemporal(WRONG_TYPE_RUNS).clientFor);
  const message = async (id) =>
    (await readers.readAuditView(id, 'status', renderSummary).catch((error) => error)).message.replaceAll(id, '<id>');
  const missing = await message(MISSING_ID);
  assert.match(missing, /No audit with workflow ID/);
  assert.equal(await message(WRONG_TYPE_ID), missing);
  assert.equal(await message(STRANGER_ID), missing);
});

test('a real audit reads as before in all three views and as a snapshot', async () => {
  const readers = createAuditReadersForTests(fakeTemporal(RUNS).clientFor);

  const status = JSON.parse(await readers.readAuditView(AUDIT_ID, 'status', renderSummary));
  assert.equal(status.workflowId, AUDIT_ID);
  assert.equal(status.done, true);
  assert.equal(status.succeeded, true);
  assert.deepEqual(JSON.parse(await readers.readAuditView(AUDIT_ID, 'report', renderSummary)), REPORT);
  assert.equal(await readers.readAuditView(AUDIT_ID, 'summary', renderSummary), '# Audit of https://example.com\n');

  const snapshot = await readers.readAuditSnapshot(AUDIT_ID);
  assert.equal(snapshot.status.succeeded, true);
  assert.deepEqual(snapshot.result, REPORT);
});

/* ---------------------------------------------- the whole response, through each route */

async function mcpCall(readers, workflowId) {
  const server = createAuditServer({
    runAudit: async () => REPORT,
    renderSummary,
    normaliseTarget: (input) => ({ origin: input, url: new URL(`https://${input}`) }),
    version: '9.9.9',
    userAgent: 'test-audit/9.9.9',
    deep: {
      startAudit: async () => ({ workflowId: AUDIT_ID }),
      readView: (id, view) => readers.readAuditView(id, view, renderSummary),
    },
  });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    return await client.callTool({ name: GET_AUDIT_TOOL_NAME, arguments: { workflowId, view: 'status' } });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

async function getTask(readers, id) {
  const result = await respond(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: GET_TASK_METHOD, params: { id } }),
    {
      digest,
      newId: () => 'fixed',
      now: () => '2026-11-12T00:00:00.000Z',
      audit: {
        originFor: (url) => url,
        checkLimit: async () => ({ allowed: true }),
        runFast: async () => REPORT,
        startDeep: async () => ({ workflowId: AUDIT_ID }),
        readTask: readers.readAuditSnapshot,
        renderSummary,
      },
    },
  );
  return JSON.stringify(result.payload);
}

test('through the /mcp tool handler, a wrong-type run answers exactly as a missing run does', async () => {
  const readers = createAuditReadersForTests(fakeTemporal({ ...WRONG_TYPE_RUNS, ...RUNS }).clientFor);
  const shape = async (id) => JSON.stringify(await mcpCall(readers, id)).replaceAll(id, '<id>');
  const missing = await shape(MISSING_ID);
  assert.match(missing, /"isError":true/);
  assert.equal(await shape(WRONG_TYPE_ID), missing);
  assert.equal(await shape(STRANGER_ID), missing);
  assert.equal(await shape(OTHER_RUN_ID), missing);
});

test('through A2A GetTask, a wrong-type run answers exactly as a missing run does', async () => {
  const readers = createAuditReadersForTests(fakeTemporal({ ...WRONG_TYPE_RUNS, ...RUNS }).clientFor);
  const shape = async (id) => (await getTask(readers, id)).replaceAll(id, '<id>');
  const missing = await shape(MISSING_ID);
  assert.match(missing, /"error"/);
  assert.equal(await shape(WRONG_TYPE_ID), missing);
  assert.equal(await shape(STRANGER_ID), missing);
  assert.equal(await shape(OTHER_RUN_ID), missing);
});

test('through A2A GetTask, a real audit still completes with its report', async () => {
  const readers = createAuditReadersForTests(fakeTemporal(RUNS).clientFor);
  const payload = JSON.parse(await getTask(readers, AUDIT_ID));
  assert.ok(payload.result, JSON.stringify(payload));
  assert.match(JSON.stringify(payload.result.status), /COMPLETED/i);
});
