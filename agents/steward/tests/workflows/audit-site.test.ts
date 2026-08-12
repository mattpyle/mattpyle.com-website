import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTestEnv } from '../helpers/test-env.js';
import { Worker } from '@temporalio/worker';
import {
  auditSiteWorkflow,
  getAuditState,
  type AuditSiteInput,
} from '../../src/workflows/audit-site.js';
import type { AuditResult } from '../../src/lib/agent-audit/result.js';

/**
 * Workflow-level tests: both activities mocked, asserting the routing (which
 * tier runs, on which queue), what the query serves before and after the run,
 * and that the budget reaches the activity in milliseconds.
 *
 * What the real checks find is `agent-audit-*.test.ts`'s job and is not
 * re-tested here.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE_LIGHT = 'steward-light';
const QUEUE_HEAVY = 'steward-heavy';

let env: TestWorkflowEnvironment;

before(async () => {
  env = await createTestEnv();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

function auditFixture(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    schemaVersion: 2,
    tool: { name: 'steward audit-url', version: '0.1.0' },
    target: { input: 'example.com', origin: 'https://example.com' },
    startedAt: '2026-08-11T00:00:00.000Z',
    finishedAt: '2026-08-11T00:00:04.000Z',
    durationMs: 4000,
    requests: 12,
    categories: [],
    checks: [
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
    ...overrides,
  };
}

interface MockOverrides {
  auditSiteFast?: (url: string, options: { budgetMs?: number }) => Promise<AuditResult>;
  auditSiteDeep?: (url: string, options: { budgetMs?: number }) => Promise<AuditResult>;
}

function mockActivities(overrides: MockOverrides = {}) {
  const calls: Array<{ activity: string; url: string; budgetMs?: number }> = [];
  const activities = {
    auditSiteFast:
      overrides.auditSiteFast ??
      (async (url: string, options: { budgetMs?: number } = {}) => {
        calls.push({ activity: 'auditSiteFast', url, budgetMs: options.budgetMs });
        return auditFixture();
      }),
    auditSiteDeep:
      overrides.auditSiteDeep ??
      (async (url: string, options: { budgetMs?: number } = {}) => {
        calls.push({ activity: 'auditSiteDeep', url, budgetMs: options.budgetMs });
        return auditFixture({ browserPages: 3 });
      }),
  };
  return { activities, calls };
}

async function withWorker<T>(activities: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const common = { connection: env.nativeConnection, workflowsPath, activities, bundlerOptions: {} };
  const light = await Worker.create({ ...common, taskQueue: QUEUE_LIGHT });
  const heavy = await Worker.create({ ...common, taskQueue: QUEUE_HEAVY });
  return await light.runUntil(heavy.runUntil(fn()));
}

function baseInput(overrides: Partial<AuditSiteInput> = {}): AuditSiteInput {
  return { url: 'example.com', tier: 'fast', budgetSeconds: 120, ...overrides };
}

test('the fast tier runs the light-queue activity and returns the canonical document', async () => {
  const { activities, calls } = mockActivities();
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(auditSiteWorkflow, {
      workflowId: 'audit-fast-1',
      taskQueue: QUEUE_LIGHT,
      args: [baseInput()],
    }),
  );
  assert.deepEqual(
    calls.map((c) => c.activity),
    ['auditSiteFast'],
  );
  assert.equal(result.target.origin, 'https://example.com');
  assert.equal(result.schemaVersion, 2);
});

test('the deep tier runs the heavy-queue activity instead — the tier picks the activity', async () => {
  const { activities, calls } = mockActivities();
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(auditSiteWorkflow, {
      workflowId: 'audit-deep-1',
      taskQueue: QUEUE_LIGHT,
      args: [baseInput({ tier: 'deep', budgetSeconds: 420 })],
    }),
  );
  assert.deepEqual(
    calls.map((c) => c.activity),
    ['auditSiteDeep'],
  );
  assert.equal(result.browserPages, 3);
});

test("the input's budget reaches the activity, in milliseconds", async () => {
  const { activities, calls } = mockActivities();
  await withWorker(activities, () =>
    env.client.workflow.execute(auditSiteWorkflow, {
      workflowId: 'audit-budget-1',
      taskQueue: QUEUE_LIGHT,
      args: [baseInput({ budgetSeconds: 45 })],
    }),
  );
  assert.equal(calls[0].budgetMs, 45_000);
});

test('the query serves progress while running and the whole document once complete', async () => {
  // The activity parks until the test releases it, so the query is asked while
  // the audit is genuinely mid-flight rather than in a race with its completion.
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { activities } = mockActivities({
    auditSiteFast: async () => {
      await parked;
      return auditFixture();
    },
  });

  await withWorker(activities, async () => {
    const handle = await env.client.workflow.start(auditSiteWorkflow, {
      workflowId: 'audit-query-1',
      taskQueue: QUEUE_LIGHT,
      args: [baseInput()],
    });

    const running = await handle.query(getAuditState);
    assert.equal(running.phase, 'auditing');
    assert.equal(running.tier, 'fast');
    assert.equal(running.url, 'example.com');
    assert.equal(running.result, undefined);
    assert.match(running.note, /example\.com/);

    release();
    await handle.result();

    // Asked after completion: a query on a closed execution is answered from
    // replayed history, which is what makes the report resource a poll rather
    // than a race against the workflow finishing.
    const done = await handle.query(getAuditState);
    assert.equal(done.phase, 'complete');
    assert.equal(done.result?.target.origin, 'https://example.com');
    assert.match(done.note, /1 failing check/);
  });
});
