import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { scorecardAuditWorkflow, type ScorecardAuditInput } from '../../src/workflows/scorecard-audit.js';
import type { PageAuditOutcome, PublishableRun } from '../../src/lib/scorecard-aggregate.js';

/**
 * Workflow-level tests (spec §9.4): every activity mocked, asserting the
 * open-pr / no-op decision and that `publishScorecardRun` is (not) called per
 * mode — not what the real tools find, which is `scorecard-aggregate.test.ts`'s
 * job.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE = 'steward-light';
const QUEUE_HEAVY = 'steward-heavy';

let env: TestWorkflowEnvironment;

before(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

const GREEN_PAGE: PageAuditOutcome = {
  url: 'https://www.mattpyle.com/',
  ok: true,
  scores: { performance: 98, accessibility: 100, seo: 100 },
  agenticChecks: [
    { id: 'agent-accessibility-tree', title: 'Accessibility tree is well-formed', applicable: true, passed: true },
    { id: 'webmcp-schema-validity', title: 'WebMCP schemas are valid', applicable: true, passed: true },
    { id: 'cumulative-layout-shift', title: 'Cumulative Layout Shift', applicable: true, passed: true },
    { id: 'llms-txt', title: 'llms.txt follows recommendations', applicable: true, passed: true },
  ],
  axeViolations: 0,
};

interface MockOverrides {
  resolveAuditUrls?: () => Promise<string[]>;
  auditLiveUrl?: (url: string) => Promise<PageAuditOutcome>;
  readPublishedScorecard?: () => Promise<PublishableRun | undefined>;
  publishScorecardRun?: (input: unknown) => Promise<{ branch: string; prUrl: string; id: string }>;
  archiveScorecardRun?: (record: unknown) => Promise<{ archivePath: string }>;
}

function mockActivities(overrides: MockOverrides = {}) {
  const calls: string[] = [];
  const archived: unknown[] = [];
  const activities = {
    resolveAuditUrls: overrides.resolveAuditUrls ?? (async () => ['https://www.mattpyle.com/']),
    auditLiveUrl:
      overrides.auditLiveUrl ??
      (async (url: string) => {
        calls.push(`auditLiveUrl:${url}`);
        return { ...GREEN_PAGE, url };
      }),
    readPublishedScorecard: overrides.readPublishedScorecard ?? (async () => undefined),
    publishScorecardRun:
      overrides.publishScorecardRun ??
      (async () => {
        calls.push('publishScorecardRun');
        return { branch: 'steward/scorecard-2026-07-22', prUrl: 'https://github.com/o/r/pull/9', id: '2026-07-22' };
      }),
    archiveScorecardRun:
      overrides.archiveScorecardRun ??
      (async (record: unknown) => {
        calls.push('archiveScorecardRun');
        archived.push(record);
        return { archivePath: 'agents/steward/reviews/_scorecard/2026-07-22.json' };
      }),
  };
  return { activities, calls, archived };
}

async function withWorker<T>(activities: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const common = { connection: env.nativeConnection, workflowsPath, activities, bundlerOptions: {} };
  const light = await Worker.create({ ...common, taskQueue: QUEUE });
  const heavy = await Worker.create({ ...common, taskQueue: QUEUE_HEAVY });
  return await light.runUntil(heavy.runUntil(fn()));
}

function baseInput(overrides: Partial<ScorecardAuditInput> = {}): ScorecardAuditInput {
  return {
    sitemapUrl: 'https://www.mattpyle.com/sitemap-index.xml',
    publishMode: 'pr',
    maxAgeDays: 7,
    triggeredBy: 'manual',
    ...overrides,
  };
}

test('no published run yet: opens a PR even though every page is green', async () => {
  const { activities, calls } = mockActivities({ readPublishedScorecard: async () => undefined });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-1',
      taskQueue: QUEUE,
      args: [baseInput()],
    }),
  );
  assert.equal(result.decision, 'open-pr');
  assert.equal(result.prUrl, 'https://github.com/o/r/pull/9');
  assert.ok(calls.includes('publishScorecardRun'));
  assert.ok(calls.includes('archiveScorecardRun'));
});

test('unchanged and fresh: no-op, publishScorecardRun is never called', async () => {
  // `TestWorkflowEnvironment.createTimeSkipping()` starts its simulated clock
  // at an arbitrary point, not real wall time — so "fresh" here is expressed
  // via a very large `maxAgeDays` rather than a hardcoded `iso` the test
  // cannot know in advance, matched against `workflow.now()`.
  const published: PublishableRun = {
    iso: '2000-01-01',
    metrics: [
      { name: 'Accessibility', value: '100', maximum: '100', status: 'Pass', description: '' },
      { name: 'Performance', value: '98', maximum: '100', status: 'Pass', description: '' },
      { name: 'SEO', value: '100', maximum: '100', status: 'Pass', description: '' },
      { name: 'Agentic Browsing', value: '4', maximum: '4', status: 'Pass', description: '' },
    ],
  };
  const { activities, calls } = mockActivities({ readPublishedScorecard: async () => published });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-2',
      taskQueue: QUEUE,
      args: [baseInput({ maxAgeDays: 100_000 })],
    }),
  );
  assert.equal(result.decision, 'no-op');
  assert.equal(result.prUrl, undefined);
  assert.ok(!calls.includes('publishScorecardRun'));
  assert.ok(calls.includes('archiveScorecardRun'));
});

test('dry-run mode never calls publishScorecardRun, even when the decision is open-pr', async () => {
  const { activities, calls } = mockActivities({ readPublishedScorecard: async () => undefined });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-3',
      taskQueue: QUEUE,
      args: [baseInput({ publishMode: 'dry-run' })],
    }),
  );
  assert.equal(result.decision, 'open-pr');
  assert.equal(result.prUrl, undefined);
  assert.ok(!calls.includes('publishScorecardRun'));
  assert.ok(calls.includes('archiveScorecardRun'));
});

test('a tool failure on one page blocks a green decision and is archived, not dropped', async () => {
  const { activities, archived } = mockActivities({
    resolveAuditUrls: async () => ['https://www.mattpyle.com/', 'https://www.mattpyle.com/broken/'],
    auditLiveUrl: async (url: string) =>
      url.includes('broken') ? { url, ok: false, error: 'Lighthouse timed out' } : { ...GREEN_PAGE, url },
    readPublishedScorecard: async () => undefined,
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-4',
      taskQueue: QUEUE,
      args: [baseInput()],
    }),
  );
  for (const m of result.record.metrics) assert.equal(m.status, 'Fail');
  const archivedRecord = archived[0] as { perPage: unknown[] };
  assert.equal(archivedRecord.perPage.length, 2);
});

test('an explicit --urls override skips resolveAuditUrls entirely', async () => {
  const { activities, calls } = mockActivities({
    resolveAuditUrls: async () => {
      throw new Error('resolveAuditUrls must not be called when urls is provided');
    },
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-5',
      taskQueue: QUEUE,
      args: [baseInput({ urls: ['https://www.mattpyle.com/about/'] })],
    }),
  );
  assert.equal(result.perPage.length, 1);
  assert.equal(result.perPage[0].url, 'https://www.mattpyle.com/about/');
  assert.ok(calls.includes('auditLiveUrl:https://www.mattpyle.com/about/'));
});
