import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTestEnv } from '../helpers/test-env.js';
import { ApplicationFailure } from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import {
  auditSiteWorkflow,
  getAuditState,
  type AuditSiteInput,
} from '../../src/workflows/audit-site.js';
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_TIMEOUT_MS,
  MIN_PAGE_BUDGET_MS,
  type RenderedPageOutcome,
} from '../../src/lib/agent-audit/deep-assemble.js';
import type { FetchChecksOutcome } from '../../src/lib/agent-audit/checks.js';
import type { AuditResult } from '../../src/lib/agent-audit/result.js';
import type {
  AssembleDeepAuditInput,
  RenderPageInput,
} from '../../src/activities/agent-audit.js';

/**
 * Workflow-level tests: every activity mocked, asserting the fan-out's shape —
 * which activities run, in what order, what the query says while they run, and
 * what a failing page does to the ones after it.
 *
 * What the real checks find is `agent-audit-*.test.ts`'s job and is not
 * re-tested here.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE_AUDIT = 'steward-audit';

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
    tool: { name: 'steward audit-url', version: '0.2.0' },
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

function pageFixture(url: string, overrides: Partial<RenderedPageOutcome> = {}): RenderedPageOutcome {
  return {
    url,
    scores: { 'agentic-browsing': 96, accessibility: 100, seo: 100, performance: 99, 'best-practices': 100 },
    lighthouseVersion: '13.4.0',
    lighthouseError: null,
    violations: [],
    axeError: null,
    timedOut: false,
    blocked: { listed: [], total: 0 },
    ...overrides,
  };
}

function fetchFixture(pages: string[], overrides: Partial<FetchChecksOutcome> = {}): FetchChecksOutcome {
  return {
    result: auditFixture(),
    sample: pages.map((url) => ({ url, disallowedBy: null })),
    available: pages.length,
    ...overrides,
  };
}

interface MockOverrides {
  auditSiteFast?: (url: string, options: { budgetMs?: number }) => Promise<AuditResult>;
  auditSiteFetchChecks?: (
    url: string,
    options: { budgetMs?: number; maxPages: number },
  ) => Promise<FetchChecksOutcome>;
  auditRenderedPage?: (input: RenderPageInput) => Promise<RenderedPageOutcome>;
}

const THREE_PAGES = [
  'https://example.com/',
  'https://example.com/a',
  'https://example.com/b',
];

function mockActivities(overrides: MockOverrides = {}) {
  const calls: Array<{ activity: string; url?: string; budgetMs?: number; timeoutMs?: number }> = [];
  let assembled: AssembleDeepAuditInput | undefined;
  const activities = {
    auditSiteFast: async (url: string, options: { budgetMs?: number } = {}) => {
      calls.push({ activity: 'auditSiteFast', url, budgetMs: options.budgetMs });
      return overrides.auditSiteFast ? overrides.auditSiteFast(url, options) : auditFixture();
    },
    auditSiteFetchChecks: async (
      url: string,
      options: { budgetMs?: number; maxPages: number },
    ) => {
      calls.push({ activity: 'auditSiteFetchChecks', url, budgetMs: options.budgetMs });
      return overrides.auditSiteFetchChecks
        ? overrides.auditSiteFetchChecks(url, options)
        : fetchFixture(THREE_PAGES);
    },
    auditRenderedPage: async (input: RenderPageInput) => {
      calls.push({ activity: 'auditRenderedPage', url: input.url, timeoutMs: input.timeoutMs });
      return overrides.auditRenderedPage
        ? overrides.auditRenderedPage(input)
        : pageFixture(input.url);
    },
    assembleDeepAudit: async (input: AssembleDeepAuditInput) => {
      calls.push({ activity: 'assembleDeepAudit' });
      assembled = input;
      return auditFixture({ browserPages: input.pages.length });
    },
  };
  return { activities, calls, assembled: () => assembled };
}

async function withWorker<T>(activities: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities,
    bundlerOptions: {},
    taskQueue: QUEUE_AUDIT,
  });
  return await worker.runUntil(fn());
}

function baseInput(overrides: Partial<AuditSiteInput> = {}): AuditSiteInput {
  return { url: 'example.com', tier: 'fast', budgetSeconds: 120, ...overrides };
}

let runId = 0;
function run(activities: Record<string, unknown>, input: AuditSiteInput) {
  return withWorker(activities, () =>
    env.client.workflow.execute(auditSiteWorkflow, {
      workflowId: `audit-test-${++runId}`,
      taskQueue: QUEUE_AUDIT,
      args: [input],
    }),
  );
}

test('the workflow drives the deep tier with the same constants the tier itself applies', () => {
  // The workflow cannot import `deep-assemble.ts` (it reads axe-core's version
  // off disk), so it holds its own copies. This is the thing that holds them
  // together — see the constants' docblock in the workflow.
  assert.equal(DEFAULT_MAX_PAGES, 3);
  assert.equal(DEFAULT_PAGE_TIMEOUT_MS, 90_000);
  assert.equal(MIN_PAGE_BUDGET_MS, 20_000);
});

test('the fast tier is still one activity, and returns the canonical document', async () => {
  const { activities, calls } = mockActivities();
  const result = await run(activities, baseInput());
  assert.deepEqual(
    calls.map((c) => c.activity),
    ['auditSiteFast'],
  );
  assert.equal(result.target.origin, 'https://example.com');
  assert.equal(result.schemaVersion, 2);
});

test("the input's budget reaches the fast activity, in milliseconds", async () => {
  const { activities, calls } = mockActivities();
  await run(activities, baseInput({ budgetSeconds: 45 }));
  assert.equal(calls[0].budgetMs, 45_000);
});

test('the deep tier fans out: the fetch pass, one activity per page, then assembly', async () => {
  const { activities, calls, assembled } = mockActivities();
  const result = await run(activities, baseInput({ tier: 'deep', budgetSeconds: 420 }));

  assert.deepEqual(
    calls.map((c) => c.activity),
    [
      'auditSiteFetchChecks',
      'auditRenderedPage',
      'auditRenderedPage',
      'auditRenderedPage',
      'assembleDeepAudit',
    ],
  );
  // Serial, in sample order — Lighthouse is not safe to run concurrently in one
  // worker process, so the fan-out buys durability rather than speed.
  assert.deepEqual(
    calls.filter((c) => c.activity === 'auditRenderedPage').map((c) => c.url),
    THREE_PAGES,
  );
  assert.equal(calls[0].budgetMs, 420_000);
  assert.equal(result.browserPages, 3);
  assert.equal(assembled()?.pages.length, 3);
  assert.deepEqual(assembled()?.skipped, []);
  assert.equal(assembled()?.available, 3);
});

test("each page's slice is bounded by the page timeout and by what is left of the budget", async () => {
  const { activities, calls } = mockActivities();
  await run(activities, baseInput({ tier: 'deep', budgetSeconds: 420 }));
  for (const call of calls.filter((c) => c.activity === 'auditRenderedPage')) {
    assert.ok(
      call.timeoutMs !== undefined && call.timeoutMs <= DEFAULT_PAGE_TIMEOUT_MS,
      `slice ${call.timeoutMs} exceeded the page timeout`,
    );
  }
});

test('a page robots.txt disallows costs no activity and is a skip, not a finding', async () => {
  const { activities, calls, assembled } = mockActivities({
    auditSiteFetchChecks: async () => ({
      result: auditFixture(),
      sample: [
        { url: 'https://example.com/', disallowedBy: null },
        { url: 'https://example.com/private', disallowedBy: 'robots.txt: "Disallow: /private"' },
      ],
      available: 2,
    }),
  });
  await run(activities, baseInput({ tier: 'deep', budgetSeconds: 420 }));

  assert.deepEqual(
    calls.filter((c) => c.activity === 'auditRenderedPage').map((c) => c.url),
    ['https://example.com/'],
  );
  assert.deepEqual(assembled()?.skipped, [
    {
      url: 'https://example.com/private',
      reason: 'robots.txt: "Disallow: /private"',
      robots: true,
    },
  ]);
});

test('a page the address guard refuses is skipped, and the pages after it still run', async () => {
  const { activities, calls, assembled } = mockActivities({
    auditRenderedPage: async (input) => {
      if (input.url === 'https://example.com/a') {
        throw ApplicationFailure.nonRetryable(
          `refused to render ${input.url}: resolves to a private address`,
          'BlockedTarget',
        );
      }
      return pageFixture(input.url);
    },
  });
  await run(activities, baseInput({ tier: 'deep', budgetSeconds: 420 }));

  // Every page was attempted: the refusal is a fact about one page.
  assert.deepEqual(
    calls.filter((c) => c.activity === 'auditRenderedPage').map((c) => c.url),
    THREE_PAGES,
  );
  assert.equal(assembled()?.pages.length, 2);
  assert.equal(assembled()?.skipped.length, 1);
  assert.equal(assembled()?.skipped[0].url, 'https://example.com/a');
  assert.equal(assembled()?.browserFailure, null);
});

test('a browser that will not start stops the fan-out rather than repeating itself', async () => {
  const { activities, calls, assembled } = mockActivities({
    auditRenderedPage: async () => {
      throw ApplicationFailure.create({
        message: 'chrome-launcher: no Chrome installation found',
        type: 'BrowserUnavailable',
      });
    },
  });
  await run(activities, baseInput({ tier: 'deep', budgetSeconds: 420 }));

  // One *page* attempted, not three — and that page retried once, which is the
  // retry rule in action: `BrowserUnavailable` is the infrastructure failure the
  // policy exists for, and it is the only thing this activity ever throws.
  const rendered = calls.filter((c) => c.activity === 'auditRenderedPage');
  assert.equal(rendered.length, 2, 'expected one page, attempted twice');
  assert.deepEqual(new Set(rendered.map((c) => c.url)), new Set([THREE_PAGES[0]]));
  // `assembleDeepAudit` still runs: a deep audit with no browser is a report
  // whose rendered-experience checks are `error`, not a failed workflow.
  assert.equal(calls[calls.length - 1].activity, 'assembleDeepAudit');
  assert.match(String(assembled()?.browserFailure), /no Chrome installation found/);
  assert.equal(assembled()?.pages.length, 0);
  // The remaining pages were never reached, so they are not in the skip list —
  // `browserFailure` is what the checks report about them instead.
  assert.deepEqual(assembled()?.skipped, []);
  assert.equal(assembled()?.progressNotes.length, 1);
});

test('a budget too small to buy a page skips every page and says so', async () => {
  const { activities, calls, assembled } = mockActivities();
  // Below `MIN_PAGE_BUDGET_MS`, so no page can be paid for at all. Asserted at
  // this end of the scale rather than mid-fan-out because the environment skips
  // time: with mocked activities the budget would otherwise never be spent, and
  // a test that depends on real elapsed time is a test that passes on a fast
  // machine and fails on a loaded one.
  await run(activities, baseInput({ tier: 'deep', budgetSeconds: 10 }));

  assert.deepEqual(
    calls.map((c) => c.activity),
    ['auditSiteFetchChecks', 'assembleDeepAudit'],
  );
  assert.equal(assembled()?.skipped.length, 3);
  for (const skip of assembled()?.skipped ?? []) {
    assert.match(skip.reason, /time budget had .*s left, less than the 20s a page needs/);
    assert.equal(skip.robots, false);
  }
});

test('the query serves per-step progress while running and the whole document once complete', async () => {
  // The first page parks until the test releases it, so the query is asked while
  // the fan-out is genuinely mid-flight rather than in a race with its completion.
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { activities } = mockActivities({
    auditRenderedPage: async (input) => {
      if (input.url === THREE_PAGES[0]) await parked;
      return pageFixture(input.url);
    },
  });

  await withWorker(activities, async () => {
    const handle = await env.client.workflow.start(auditSiteWorkflow, {
      workflowId: 'audit-query-progress',
      taskQueue: QUEUE_AUDIT,
      args: [baseInput({ tier: 'deep', budgetSeconds: 420 })],
    });

    // Poll until the workflow has reached the first page — the query is served
    // from workflow state, so it is readable the moment the state exists.
    let running = await handle.query(getAuditState);
    for (let i = 0; i < 100 && running.progress.phase !== 'rendering'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      running = await handle.query(getAuditState);
    }

    assert.equal(running.phase, 'auditing');
    assert.equal(running.progress.phase, 'rendering');
    assert.equal(running.result, undefined);

    // The fetch pass is done, and its verdicts are already readable per check —
    // which is the whole point of reporting checks separately from steps.
    const fetchStep = running.progress.steps.find((s) => s.kind === 'fetch');
    assert.equal(fetchStep?.state, 'done');
    assert.deepEqual(running.progress.checks, [
      { id: 'llms-txt', title: 'llms.txt exists and is a plain-text index', status: 'fail' },
    ]);

    const pageSteps = running.progress.steps.filter((s) => s.kind === 'page');
    assert.equal(pageSteps.length, 3);
    assert.equal(pageSteps[0].state, 'running');
    assert.deepEqual(
      pageSteps.slice(1).map((s) => s.state),
      ['pending', 'pending'],
    );

    release();
    await handle.result();

    // Asked after completion: a query on a closed execution is answered from
    // replayed history, which is what makes the report resource a poll rather
    // than a race against the workflow finishing.
    const done = await handle.query(getAuditState);
    assert.equal(done.phase, 'complete');
    assert.equal(done.progress.phase, 'complete');
    assert.deepEqual(
      done.progress.steps.map((s) => s.state),
      ['done', 'done', 'done', 'done', 'done'],
    );
    assert.equal(done.result?.target.origin, 'https://example.com');
    assert.match(done.note, /1 failing check/);
  });
});
