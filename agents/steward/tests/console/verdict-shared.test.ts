import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { consoleRequest } from '../helpers/console-request.js';
import { startConsoleServer } from '../../src/console/server.js';
import { sendFindingVerdict } from '../../src/lib/finding-verdict.js';
import { findingWorkflowId, type FindingVerdict } from '../../src/lib/findings.js';
import type { FindingsModel } from '../../src/console/findings-model.js';
import {
  STUB_COMMIT,
  receivedVerdictsQuery,
  verdictStubWorkflow,
} from '../fixtures/workflows/verdict-stub.js';

/**
 * The CLI verb and the console button send one `verdict` payload.
 *
 * Both senders run for real against one time-skipping server: the CLI as a
 * child process (`steward finding reject`, pointed at the test server by
 * `TEMPORAL_ADDRESS` with no API key), and the console as its own HTTP server
 * taking the form POST its page renders. The receiver is a stub that answers
 * the verdict gate's names and records each payload. The two payloads must be
 * equal in everything but `at`, the sender's clock.
 *
 * One test, one server, started in `beforeEach` (agents/steward/CLAUDE.md,
 * "The test suite"). The stub never closes and no result is awaited, so time
 * never skips.
 */

const exec = promisify(execFile);
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(STEWARD, 'src', 'cli.ts');
const workflowsPath = fileURLToPath(new URL('../fixtures/workflows/verdict-stub.ts', import.meta.url));
const QUEUE = 'console-verdict-test';
const SITE = 'stub-site';
const KEY = 'stub-finding--page';
const REASON = 'Not a defect: the page says so on purpose.';

const EMPTY_MODEL: FindingsModel = {
  generatedAt: new Date(0).toISOString(),
  repo: 'test/argus',
  sites: [],
  failedVerifies: [],
  cost: { treeCalls: 0, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 },
};

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

test('steward finding reject and the console reject button send the same verdict payload', { timeout: 90_000 }, async () => {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    workflowsPath,
    taskQueue: QUEUE,
    bundlerOptions: {},
  });

  await worker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(verdictStubWorkflow, {
          workflowId: findingWorkflowId(SITE, KEY),
          taskQueue: QUEUE,
          args: [{ site: SITE, key: KEY }],
        });

        // 1. The verb, as Matt runs it.
        const cli = await exec(
          process.execPath,
          ['--import', 'tsx', CLI, 'finding', 'reject', KEY, '--site', SITE, '--reason', REASON],
          {
            cwd: STEWARD,
            env: {
              ...process.env,
              TEMPORAL_ADDRESS: env.address,
              TEMPORAL_NAMESPACE: env.namespace ?? 'default',
              TEMPORAL_API_KEY: '',
            },
          },
        );
        assert.match(cli.stdout, /verdict: rejected \(source cli\)/);
        assert.match(cli.stdout, new RegExp(`commit: ${STUB_COMMIT}`));

        // 2. The button, through the console's own POST handler.
        const server = await startConsoleServer({
          port: 0,
          loadFindings: async () => EMPTY_MODEL,
          sendVerdict: (request) => sendFindingVerdict(request, { client }),
          page: { timeZone: 'America/Vancouver', webUi: 'http://localhost:8233', namespace: 'default' },
        });
        try {
          const res = await consoleRequest({
            port: server.port,
            path: '/findings/verdict',
            method: 'POST',
            origin: `http://127.0.0.1:${server.port}`,
            form: { token: server.token, site: SITE, key: KEY, verdict: 'rejected', reason: REASON },
          });
          assert.equal(res.status, 200, res.body);
          assert.match(res.body, /verdict: rejected \(source cli\)/);
          assert.match(res.body, new RegExp(`commit: <code>${STUB_COMMIT}</code>`));
        } finally {
          await server.close();
        }

        const received = await handle.query(receivedVerdictsQuery);
        assert.equal(received.length, 2);
        const withoutClock = ({ at, ...rest }: FindingVerdict) => {
          assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          return rest;
        };
        assert.deepEqual(withoutClock(received[0]), withoutClock(received[1]));
        assert.deepEqual(withoutClock(received[0]), { status: 'rejected', reason: REASON, source: 'cli' });
      })(),
    ),
  );
});
