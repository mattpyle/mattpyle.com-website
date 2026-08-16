import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTestEnv } from '../helpers/test-env.js';
import { Worker } from '@temporalio/worker';
import { scorecardAuditWorkflow, type ScorecardAuditInput } from '../../src/workflows/scorecard-audit.js';
import type { PageAuditOutcome, PublishableRun } from '../../src/lib/scorecard-aggregate.js';
import type { PublishedScorecard } from '../../src/activities/scorecard.js';

/**
 * Workflow-level tests (spec §9.4): every activity mocked, asserting the
 * open-pr / no-op decision and that `publishScorecardRun` is (not) called per
 * mode — not what the real tools find, which is `scorecard-aggregate.test.ts`'s
 * job.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
/**
 * One queue, since 2026-08-14. Every activity this workflow schedules moved to
 * `steward-audit` when `activities/scorecard.ts` stopped touching the
 * filesystem, so the two-worker arrangement this file used to need — a light
 * worker and a heavy one, because the proxies pointed at both — collapsed into
 * one. See `workflows/scorecard-audit.ts`.
 */
const QUEUE = 'steward-audit';

let env: TestWorkflowEnvironment;

before(async () => {
  env = await createTestEnv();
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
  resolveRunStamp?: () => Promise<{ iso: string; timestamp: string }>;
  auditLiveUrl?: (url: string) => Promise<PageAuditOutcome>;
  readPublishedScorecard?: () => Promise<PublishedScorecard | undefined>;
  publishScorecardRun?: (input: unknown) => Promise<{ branch: string; prUrl: string; id: string }>;
  archiveScorecardRun?: (record: unknown) => Promise<{ archivePath: string }>;
}

/** What the alerting leg was asked to send, in order. */
interface SentSignal {
  signal: string;
  ok: boolean;
  summary: string;
}

function mockActivities(overrides: MockOverrides = {}) {
  const calls: string[] = [];
  const archived: unknown[] = [];
  const signals: SentSignal[] = [];
  const activities = {
    resolveAuditUrls: overrides.resolveAuditUrls ?? (async () => ['https://www.mattpyle.com/']),
    resolveRunStamp:
      overrides.resolveRunStamp ??
      (async () => ({ iso: '2026-07-22', timestamp: '2026-07-22T09:00:00-07:00' })),
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
    // The alerting leg, recorded rather than sent. Both are mocked in every
    // case, including the ones that never call them, so a test asserting
    // silence fails on an unexpected *call* rather than on "activity not
    // registered", which is the same red for two very different reasons.
    reportRunHealth: async (input: { signal: string; shape: { ok: boolean; summary: string } }) => {
      calls.push(`reportRunHealth:${input.signal}`);
      signals.push({ signal: input.signal, ok: input.shape.ok, summary: input.shape.summary });
      return { signal: input.signal, ok: input.shape.ok, sent: true };
    },
    checkCredentialExpiry: async () => {
      calls.push('checkCredentialExpiry');
      return {
        signal: 'credential-expiry',
        ok: true,
        sent: true,
        summary: '2 tracked credential(s); the nearest is a test one.',
        dueCount: 0,
      };
    },
  };
  return { activities, calls, archived, signals };
}

async function withWorker<T>(activities: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const common = { connection: env.nativeConnection, workflowsPath, activities, bundlerOptions: {} };
  const worker = await Worker.create({ ...common, taskQueue: QUEUE });
  return await worker.runUntil(fn());
}

function baseInput(overrides: Partial<ScorecardAuditInput> = {}): ScorecardAuditInput {
  return {
    sitemapUrl: 'https://www.mattpyle.com/sitemap-index.xml',
    publishMode: 'pr',
    maxAgeDays: 7,
    triggeredBy: 'manual',
    timeZone: 'America/Vancouver',
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

test('commentary folds in the change delta decidePublish found, worded as a timeless fact', async () => {
  const published: PublishableRun = {
    iso: '2000-01-01',
    metrics: [
      { name: 'Accessibility', value: '100', maximum: '100', status: 'Pass', description: '' },
      { name: 'Performance', value: '98', maximum: '100', status: 'Pass', description: '' },
      { name: 'SEO', value: '100', maximum: '100', status: 'Pass', description: '' },
      { name: 'Agentic Browsing', value: '3', maximum: '3', status: 'Pass', description: '' },
    ],
  };
  const { activities } = mockActivities({ readPublishedScorecard: async () => published });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-6',
      taskQueue: QUEUE,
      args: [baseInput({ maxAgeDays: 100_000 })],
    }),
  );
  assert.equal(result.decision, 'open-pr');
  assert.match(result.record.commentary, /Agentic Browsing rose from 3\/3 to 4\/4/);
  assert.doesNotMatch(result.record.commentary, /\b(currently|latest|now|baseline|today)\b/i);
});

test('commentary states the plain pass fact, with no delta language, when nothing changed', async () => {
  const published: PublishableRun = {
    iso: '2000-01-01',
    metrics: [
      { name: 'Accessibility', value: '100', maximum: '100', status: 'Pass', description: '' },
      { name: 'Performance', value: '98', maximum: '100', status: 'Pass', description: '' },
      { name: 'SEO', value: '100', maximum: '100', status: 'Pass', description: '' },
      { name: 'Agentic Browsing', value: '4', maximum: '4', status: 'Pass', description: '' },
    ],
  };
  const { activities } = mockActivities({ readPublishedScorecard: async () => published });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-7',
      taskQueue: QUEUE,
      args: [baseInput({ maxAgeDays: 100_000 })],
    }),
  );
  assert.equal(result.decision, 'no-op');
  assert.match(result.record.commentary, /^All \d+ pages? passed all four public metrics\.$/);
});

// ---------------------------------------------------------------------------
// `--note`: run commentary supplied up front instead of hand-edited into the PR
// afterwards. It rides in the input like every other decision (design rule 3).
// ---------------------------------------------------------------------------

const PUBLISHED_GREEN: PublishableRun = {
  iso: '2000-01-01',
  metrics: [
    { name: 'Accessibility', value: '100', maximum: '100', status: 'Pass', description: '' },
    { name: 'Performance', value: '98', maximum: '100', status: 'Pass', description: '' },
    { name: 'SEO', value: '100', maximum: '100', status: 'Pass', description: '' },
    { name: 'Agentic Browsing', value: '4', maximum: '4', status: 'Pass', description: '' },
  ],
};

test('a note leads the commentary and the machine draft still follows it', async () => {
  // Prefix, not replace: the note says why the run happened, the draft says what
  // it measured, and losing the second to gain the first would be a worse entry
  // than the hand-edit this replaces.
  const { activities, archived } = mockActivities({ readPublishedScorecard: async () => PUBLISHED_GREEN });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-note-1',
      taskQueue: QUEUE,
      args: [baseInput({ maxAgeDays: 100_000, note: 'Re-run by hand after the font subset landed' })],
    }),
  );
  assert.match(
    result.record.commentary,
    /^Re-run by hand after the font subset landed\. All \d+ pages? passed all four public metrics\.$/,
  );
  // It reaches the archive as well as the return value — the archive is the only
  // place the run survives on a no-op night.
  const archivedRecord = archived[0] as { commentary: string };
  assert.match(archivedRecord.commentary, /^Re-run by hand after the font subset landed\./);
});

test('a note that punctuates itself is not punctuated twice', async () => {
  const { activities } = mockActivities({ readPublishedScorecard: async () => PUBLISHED_GREEN });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-note-2',
      taskQueue: QUEUE,
      args: [baseInput({ maxAgeDays: 100_000, note: 'Did the CLS regression come back?' })],
    }),
  );
  assert.match(result.record.commentary, /^Did the CLS regression come back\? All/);
});

test('no note leaves the commentary byte-identical to the machine draft', async () => {
  // The property that makes this a safe input-only change: an execution without
  // a note takes exactly the branch every execution before the field existed
  // took, so replaying an old history cannot diverge.
  const { activities } = mockActivities({ readPublishedScorecard: async () => PUBLISHED_GREEN });
  const run = (note: string | undefined, workflowId: string) =>
    withWorker(activities, () =>
      env.client.workflow.execute(scorecardAuditWorkflow, {
        workflowId,
        taskQueue: QUEUE,
        args: [baseInput({ maxAgeDays: 100_000, note })],
      }),
    );

  const absent = await run(undefined, 'sc-note-3');
  const blank = await run('   ', 'sc-note-4');
  assert.match(absent.record.commentary, /^All \d+ pages? passed all four public metrics\.$/);
  assert.equal(blank.record.commentary, absent.record.commentary);
});

test('the run date comes from resolveRunStamp, not a hardcoded workflow clock read', async () => {
  const { activities } = mockActivities({
    readPublishedScorecard: async () => undefined,
    resolveRunStamp: async () => ({ iso: '2099-01-05', timestamp: '2099-01-05T03:00:00-08:00' }),
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-8',
      taskQueue: QUEUE,
      args: [baseInput()],
    }),
  );
  assert.equal(result.record.iso, '2099-01-05');
  assert.equal(result.record.timestamp, '2099-01-05T03:00:00-08:00');
});

test('--date pins the run\'s iso but leaves the real audit timestamp alone', async () => {
  const { activities } = mockActivities({
    readPublishedScorecard: async () => undefined,
    resolveRunStamp: async () => ({ iso: '2026-07-23', timestamp: '2026-07-23T10:00:00-07:00' }),
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-9',
      taskQueue: QUEUE,
      args: [baseInput({ date: '2026-07-22' })],
    }),
  );
  assert.equal(result.record.iso, '2026-07-22');
  assert.equal(result.record.timestamp, '2026-07-23T10:00:00-07:00');
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

// ---------------------------------------------------------------------------
// The audit-set guard, end to end through the workflow (spec §5.4). The
// comparison itself is unit-tested in `lib/scorecard-aggregate.test.ts`; what
// these assert is that the workflow *fails* on a bad set and never reaches the
// fan-out — the whole point being to lose seconds rather than 12 minutes of
// Chrome launches before finding out.
// ---------------------------------------------------------------------------

const PUBLISHED_18: PublishedScorecard = {
  iso: '2000-01-01',
  pageCount: 18,
  metrics: [
    { name: 'Accessibility', value: '100', maximum: '100', status: 'Pass', description: '' },
    { name: 'Performance', value: '98', maximum: '100', status: 'Pass', description: '' },
    { name: 'SEO', value: '100', maximum: '100', status: 'Pass', description: '' },
    { name: 'Agentic Browsing', value: '4', maximum: '4', status: 'Pass', description: '' },
  ],
};

function urlsOfLength(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://www.mattpyle.com/p${i}/`);
}

/**
 * A workflow failure surfaces as `WorkflowFailedError: Workflow execution
 * failed` with the real reason on `.cause` — asserting on the outer message
 * would pass for *any* failure, which is exactly the kind of test that goes
 * green while the guard is broken.
 */
async function assertWorkflowFails(run: () => Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await run();
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    assert.match(message, expected);
    return;
  }
  assert.fail(`expected the workflow to fail with ${expected}`);
}

test('a shrunken audit set fails the run before a single page is audited', async () => {
  const { activities, calls } = mockActivities({
    resolveAuditUrls: async () => urlsOfLength(3),
    readPublishedScorecard: async () => PUBLISHED_18,
  });
  await assertWorkflowFails(
    () =>
      withWorker(activities, () =>
        env.client.workflow.execute(scorecardAuditWorkflow, {
          workflowId: 'sc-guard-1',
          taskQueue: QUEUE,
          args: [baseInput({ maxAgeDays: 100_000 })],
        }),
      ),
    /shrank: 3 URL\(s\) vs 18/,
  );
  assert.equal(calls.filter((c) => c.startsWith('auditLiveUrl')).length, 0);
  assert.ok(!calls.includes('archiveScorecardRun'));
});

test('--allow-shrink lets the same shrunken set through', async () => {
  const { activities, calls } = mockActivities({
    resolveAuditUrls: async () => urlsOfLength(3),
    readPublishedScorecard: async () => PUBLISHED_18,
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-guard-2',
      taskQueue: QUEUE,
      args: [baseInput({ maxAgeDays: 100_000, allowShrink: true })],
    }),
  );
  assert.equal(result.perPage.length, 3);
  assert.equal(calls.filter((c) => c.startsWith('auditLiveUrl')).length, 3);
});

test('an empty audit set fails the run', async () => {
  const { activities } = mockActivities({
    resolveAuditUrls: async () => [],
    readPublishedScorecard: async () => PUBLISHED_18,
  });
  await assertWorkflowFails(
    () =>
      withWorker(activities, () =>
        env.client.workflow.execute(scorecardAuditWorkflow, {
          workflowId: 'sc-guard-3',
          taskQueue: QUEUE,
          args: [baseInput({ maxAgeDays: 100_000, allowShrink: true })],
        }),
      ),
    /resolved audit set is empty/,
  );
});

test('a grown audit set passes the guard untouched', async () => {
  const { activities, calls } = mockActivities({
    resolveAuditUrls: async () => urlsOfLength(19),
    readPublishedScorecard: async () => PUBLISHED_18,
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-guard-4',
      taskQueue: QUEUE,
      args: [baseInput({ maxAgeDays: 100_000 })],
    }),
  );
  assert.equal(result.perPage.length, 19);
  assert.equal(calls.filter((c) => c.startsWith('auditLiveUrl')).length, 19);
});

test('--urls skips the shrink check, so a deliberate one-page run is allowed', async () => {
  const { activities } = mockActivities({ readPublishedScorecard: async () => PUBLISHED_18 });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-guard-5',
      taskQueue: QUEUE,
      args: [baseInput({ maxAgeDays: 100_000, urls: ['https://www.mattpyle.com/about/'] })],
    }),
  );
  assert.equal(result.perPage.length, 1);
});

test('the audited set is sorted, whatever order the sitemap returned it in', async () => {
  const { activities } = mockActivities({
    resolveAuditUrls: async () => [
      'https://www.mattpyle.com/writing/',
      'https://www.mattpyle.com/about/',
      'https://www.mattpyle.com/',
    ],
    readPublishedScorecard: async () => undefined,
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-guard-6',
      taskQueue: QUEUE,
      args: [baseInput()],
    }),
  );
  assert.deepEqual(
    result.perPage.map((p) => p.url),
    ['https://www.mattpyle.com/', 'https://www.mattpyle.com/about/', 'https://www.mattpyle.com/writing/'],
  );
});

// ---------------------------------------------------------------------------
// Spec §6's third publish trigger, end to end: a new page joins the site and
// scores as well as every other one, so no metric moves. This is the exact
// case that left `/scorecard` stating "18 tested pages" while the site had 19.
// ---------------------------------------------------------------------------

const PUBLISHED_GREEN_METRICS = [
  { name: 'Accessibility', value: '100', maximum: '100', status: 'Pass' as const, description: '' },
  { name: 'Performance', value: '98', maximum: '100', status: 'Pass' as const, description: '' },
  { name: 'SEO', value: '100', maximum: '100', status: 'Pass' as const, description: '' },
  { name: 'Agentic Browsing', value: '4', maximum: '4', status: 'Pass' as const, description: '' },
];

test('a new page opens a PR even though no metric moved', async () => {
  const published: PublishedScorecard = {
    iso: '2000-01-01',
    scope: '18 live pages',
    tools: ['Lighthouse 13.4', 'axe-core 4.12'],
    pageCount: 18,
    metrics: PUBLISHED_GREEN_METRICS,
  };
  const { activities, calls } = mockActivities({
    resolveAuditUrls: async () => urlsOfLength(19),
    readPublishedScorecard: async () => published,
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-scope-1',
      taskQueue: QUEUE,
      // A very large maxAgeDays proves staleness played no part: the only
      // reason this publishes is the coverage change.
      args: [baseInput({ maxAgeDays: 100_000 })],
    }),
  );

  assert.equal(result.decision, 'open-pr');
  assert.equal(result.reason, 'Coverage 18→19 pages');
  assert.ok(calls.includes('publishScorecardRun'));
  assert.equal(result.record.scope, '19 live pages');
  assert.match(result.record.commentary, /Coverage rose from 18 to 19 pages/);
  // Rule 7: the commentary must still read correctly forever.
  assert.doesNotMatch(result.record.commentary, /\b(currently|latest|now|today|at present)\b/i);
});

test('an unchanged page count with unchanged metrics still no-ops', async () => {
  const published: PublishedScorecard = {
    iso: '2000-01-01',
    scope: '19 live pages',
    tools: ['Lighthouse 13.4', 'axe-core 4.12'],
    pageCount: 19,
    metrics: PUBLISHED_GREEN_METRICS,
  };
  const { activities, calls } = mockActivities({
    resolveAuditUrls: async () => urlsOfLength(19),
    readPublishedScorecard: async () => published,
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-scope-2',
      taskQueue: QUEUE,
      args: [baseInput({ maxAgeDays: 100_000 })],
    }),
  );

  assert.equal(result.decision, 'no-op');
  assert.ok(!calls.includes('publishScorecardRun'));
});

/**
 * The alerting leg (audit-stack-alerting-and-monitoring card).
 *
 * These assert the *routing* — which signal a run sends, and whether it sends
 * one at all. What makes a shape good or bad is `run-health.test.ts`'s job, and
 * the two suites deliberately do not restate each other's rule.
 */

test('a healthy scheduled run signals the nightly check and checks credentials first', async () => {
  const { activities, calls, signals } = mockActivities();
  await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-alert-1',
      taskQueue: QUEUE,
      args: [baseInput({ triggeredBy: 'schedule' })],
    }),
  );

  assert.deepEqual(signals.map((s) => [s.signal, s.ok]), [['nightly-scorecard', true]]);
  // Before the fan-out, so a run that later dies on an expired token has
  // already said which token it was.
  assert.equal(calls[0], 'checkCredentialExpiry');
});

test('a healthy manual run signals nothing — it must not hold the dead-man\'s switch down', async () => {
  const { activities, calls, signals } = mockActivities();
  await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-alert-2',
      taskQueue: QUEUE,
      args: [baseInput({ triggeredBy: 'manual' })],
    }),
  );

  assert.deepEqual(signals, []);
  assert.ok(!calls.includes('checkCredentialExpiry'));
});

test('a completed run with one failed page fails its check, naming the page', async () => {
  const { activities, signals } = mockActivities({
    auditLiveUrl: async (url: string) =>
      url.includes('broken') ? { url, ok: false, error: 'Lighthouse timed out' } : { ...GREEN_PAGE, url },
    // Trailing slash, like every other URL fixture in this file and like every
    // URL the live sitemap emits. A slash-less page URL is a 308 here, so a
    // fixture in that shape is a fixture of something the audit never sees.
    resolveAuditUrls: async () => ['https://www.mattpyle.com/', 'https://www.mattpyle.com/broken/'],
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-alert-3',
      taskQueue: QUEUE,
      args: [baseInput({ triggeredBy: 'schedule' })],
    }),
  );

  // The run still completed and still published: the alert reads the record,
  // it does not change how the run reports itself.
  assert.equal(result.decision, 'open-pr');
  assert.deepEqual(signals.map((s) => [s.signal, s.ok]), [['nightly-scorecard', false]]);
  assert.match(signals[0].summary, /1 of 2 page\(s\) could not be audited/);
  assert.match(signals[0].summary, /broken\/ \(Lighthouse timed out\)/);
});

test('a bad-shaped manual run fails run-shape rather than the nightly check', async () => {
  const { activities, signals } = mockActivities({
    auditLiveUrl: async (url: string) => ({ url, ok: false, error: 'Lighthouse timed out' }),
  });
  await withWorker(activities, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-alert-4',
      taskQueue: QUEUE,
      args: [baseInput({ triggeredBy: 'manual' })],
    }),
  );

  assert.deepEqual(signals.map((s) => [s.signal, s.ok]), [['run-shape', false]]);
});

test('a run that throws still signals, and still fails', async () => {
  const { activities, signals } = mockActivities({
    resolveAuditUrls: async () => urlsOfLength(3),
    readPublishedScorecard: async () => PUBLISHED_18,
  });
  await assertWorkflowFails(
    () =>
      withWorker(activities, () =>
        env.client.workflow.execute(scorecardAuditWorkflow, {
          workflowId: 'sc-alert-5',
          taskQueue: QUEUE,
          args: [baseInput({ maxAgeDays: 100_000, triggeredBy: 'schedule' })],
        }),
      ),
    /shrank: 3 URL\(s\) vs 18/,
  );

  assert.deepEqual(signals.map((s) => [s.signal, s.ok]), [['nightly-scorecard', false]]);
  assert.match(signals[0].summary, /shrank: 3 URL\(s\) vs 18/);
});

test('a monitoring service that cannot be reached does not fail the run', async () => {
  const { activities } = mockActivities();
  const withDeadAlerting = {
    ...activities,
    reportRunHealth: async () => {
      // What the real activity returns when every attempt failed: an outcome
      // saying so, never a throw. This test is the workflow's half of that
      // contract — it must not treat `sent: false` as a reason to fail.
      return { signal: 'nightly-scorecard', ok: true, sent: false, reason: 'ECONNREFUSED' };
    },
  };
  const result = await withWorker(withDeadAlerting, () =>
    env.client.workflow.execute(scorecardAuditWorkflow, {
      workflowId: 'sc-alert-6',
      taskQueue: QUEUE,
      args: [baseInput({ triggeredBy: 'schedule' })],
    }),
  );
  assert.equal(result.decision, 'open-pr');
});
