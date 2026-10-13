import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import { CancelledFailure } from '@temporalio/common';
import { createTestEnv } from '../helpers/test-env.js';
import { fixFindingStateQuery, fixFindingWorkflow, type FixFindingInput } from '../../src/workflows/fix-finding.js';
import type { WriteFindingFixInput } from '../../src/activities/findings.js';
import type { GenerateHandoffInput, OpenFixerPrInput, RunFixerInput, RunFixerResult } from '../../src/activities/fixer.js';
import { opensAsDraft } from '../../src/lib/fixer.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { DEFECT_FINDING, DEFECT_HANDOFF, DEFECT_KEY, OPPORTUNITY_FINDING } from '../helpers/finding-fixtures.js';

/**
 * `fixFindingWorkflow` with its five activities mocked: the pass, the refusals,
 * and what the workflow does with each of the four ways a run ends early. The
 * runner's own tests reach those four against a stub process
 * (`tests/lib/claude-runner.test.ts`); here they arrive as the results and
 * failures `runFixer` turns them into.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE = 'steward-heavy';
const PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/312';

let env: TestWorkflowEnvironment;

before(async () => {
  env = await createTestEnv();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

const RUN: RunFixerResult = {
  branch: `fix/finding-${DEFECT_KEY}`,
  base: 'master',
  commitSha: 'c-fix',
  filesChanged: ['agents/steward/src/workflows/scorecard-audit.ts'],
  checks: [{ n: 1, status: 'pass', command: 'npm test -w @mattpyle/steward' }],
  claude: {
    exitCode: 0,
    timedOut: false,
    finalMessage: 'Done. 🤖 Generated with Claude Code',
    model: 'claude-x',
    sessionId: 's1',
    numTurns: 40,
    costUsd: 1.2,
    permissionDenials: [],
  },
  npmCi: false,
  timingsMs: { worktree: 1, install: 2, claude: 3, checks: 5, push: 4, total: 15 },
};

interface Mocks {
  finding?: string;
  runFixer?: (input: RunFixerInput) => Promise<RunFixerResult>;
}

function mockActivities(mocks: Mocks = {}) {
  const calls: string[] = [];
  const seen: {
    generate?: GenerateHandoffInput;
    run?: RunFixerInput;
    pr?: OpenFixerPrInput;
    write?: WriteFindingFixInput;
  } = {};
  const activities = {
    readFinding: async (_repo: string, path: string) => {
      calls.push('readFinding');
      const text = mocks.finding ?? DEFECT_FINDING;
      return { path, text, sha: 'sha-1', data: parseFrontmatter(text).data };
    },
    generateHandoff: async (input: GenerateHandoffInput) => {
      calls.push('generateHandoff');
      seen.generate = input;
      return {
        handoff: DEFECT_HANDOFF,
        title: 'Name the failing reason in scorecard commentary',
        commitSha: 'c-handoff',
        base: 'master',
        baseSha: 'c-base',
        claude: { model: 'claude-x', costUsd: 0.05, durationMs: 20_000, numTurns: 9 },
      };
    },
    runFixer: async (input: RunFixerInput) => {
      calls.push('runFixer');
      seen.run = input;
      return mocks.runFixer ? mocks.runFixer(input) : RUN;
    },
    openFixerPr: async (input: OpenFixerPrInput) => {
      calls.push('openFixerPr');
      seen.pr = input;
      return { prUrl: PR, draft: opensAsDraft(input) };
    },
    writeFindingFix: async (input: WriteFindingFixInput) => {
      calls.push('writeFindingFix');
      seen.write = input;
      return { findingCommitSha: 'c-file', indexCommitSha: 'c-index', commitSha: 'c-index' };
    },
  };
  return { activities, calls, seen };
}

async function withWorker<T>(activities: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities,
    taskQueue: QUEUE,
    bundlerOptions: {},
    // A cancellation reaches an activity on a heartbeat's reply, and the worker
    // throttles heartbeats to 80% of the 30-second timeout by default.
    maxHeartbeatThrottleInterval: '100 milliseconds',
  });
  return await worker.runUntil(fn());
}

function input(key: string = DEFECT_KEY, overrides: Partial<FixFindingInput> = {}): FixFindingInput {
  return {
    site: 'mattpyle-com',
    key,
    repo: 'mattpyle/argus',
    findingPath: `sites/mattpyle-com/findings/${key}.md`,
    indexPath: 'sites/mattpyle-com/findings/INDEX.md',
    handoffPath: `sites/mattpyle-com/handoffs/${key}.md`,
    branch: `fix/finding-${key}`,
    stopAfter: 'pr',
    ...overrides,
  };
}

async function failure(run: Promise<unknown>): Promise<Error & { type?: string }> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof WorkflowFailedError, `expected a workflow failure, got ${String(err)}`);
    let cause = err.cause as (Error & { type?: string; cause?: Error }) | undefined;
    while (cause?.cause) cause = cause.cause as typeof cause;
    return cause ?? err;
  }
  assert.fail('the workflow completed');
}

test('pass: five activities in order, the PR from the finding, and fixing written back', async () => {
  const { activities, calls, seen } = mockActivities();
  const result = await withWorker(activities, async () => {
    const handle = await env.client.workflow.start(fixFindingWorkflow, {
      workflowId: `fix/mattpyle-com/${DEFECT_KEY}`,
      taskQueue: QUEUE,
      args: [input()],
    });
    const r = await handle.result();
    assert.deepEqual(await handle.query(fixFindingStateQuery), {
      site: 'mattpyle-com',
      key: DEFECT_KEY,
      step: 'done',
      prUrl: PR,
    });
    return r;
  });

  assert.deepEqual(calls, ['readFinding', 'generateHandoff', 'runFixer', 'openFixerPr', 'writeFindingFix']);
  // The finding the gate judged is the text the handoff and the PR are made from.
  assert.equal(seen.generate!.findingText, DEFECT_FINDING);
  assert.equal(seen.generate!.handoffPath, `sites/mattpyle-com/handoffs/${DEFECT_KEY}.md`);
  // The handoff rides inline, the branch carries the fixer's prefix, and the
  // fix is cut from the commit the handoff was written against.
  assert.deepEqual(seen.run, {
    key: DEFECT_KEY,
    handoff: DEFECT_HANDOFF,
    branch: `fix/finding-${DEFECT_KEY}`,
    baseSha: 'c-base',
  });
  assert.equal(seen.pr!.findingText, DEFECT_FINDING);
  assert.deepEqual(seen.pr!.checks, RUN.checks);
  assert.ok(!JSON.stringify(seen.pr).includes('Generated with Claude Code'), 'the final message never reaches the PR activity');
  assert.equal(seen.write!.prUrl, PR);
  assert.equal(seen.write!.findingPath, `sites/mattpyle-com/findings/${DEFECT_KEY}.md`);

  assert.equal(result.prUrl, PR);
  assert.equal(result.draft, false);
  assert.equal(result.commitSha, 'c-fix');
  assert.equal(result.handoffCommitSha, 'c-handoff');
  assert.equal(result.findingCommitSha, 'c-index');
  assert.equal(result.run.numTurns, 40);
  assert.equal(result.run.costUsd, 1.2);
  assert.deepEqual(result.run.checks, RUN.checks);
  assert.ok(!JSON.stringify(result).includes('Generated with Claude Code'), 'nor the workflow result');
});

for (const [name, finding, pattern] of [
  ['a finding that is not approved', DEFECT_FINDING.replace('status: approved', 'status: proposed'), /status is proposed, not approved/],
  ['a finding that is already fixing', DEFECT_FINDING.replace('status: approved', 'status: fixing'), /status is fixing/],
  ['an opportunity', OPPORTUNITY_FINDING, /kind is opportunity, not defect/],
  ['a defect with no cause', DEFECT_FINDING.replace('- Cause, from the source:', '- Where:'), /names no cause/],
] as const) {
  test(`refuse: ${name} ends before a model is called`, async () => {
    const { activities, calls } = mockActivities({ finding });
    const err = await withWorker(activities, () =>
      failure(
        env.client.workflow.execute(fixFindingWorkflow, {
          workflowId: `fix/mattpyle-com/refuse-${name.replace(/\W+/g, '-')}`,
          taskQueue: QUEUE,
          args: [input()],
        }),
      ),
    );
    assert.equal(err.type, 'FindingNotFixable');
    assert.match(err.message, pattern);
    assert.deepEqual(calls, ['readFinding']);
  });
}

test('refuse: an unknown stop point fails before the finding is read', async () => {
  const { activities, calls } = mockActivities();
  const err = await withWorker(activities, () =>
    failure(
      env.client.workflow.execute(fixFindingWorkflow, {
        workflowId: 'fix/mattpyle-com/unknown-stop',
        taskQueue: QUEUE,
        args: [input(DEFECT_KEY, { stopAfter: 'verify' as never })],
      }),
    ),
  );
  assert.equal(err.type, 'UnknownStopPoint');
  assert.deepEqual(calls, []);
});

test('the kill at 30 minutes, with changes: a draft PR, and the finding is still marked fixing', async () => {
  const { activities, calls, seen } = mockActivities({
    runFixer: async () => ({ ...RUN, checks: [], claude: { ...RUN.claude, exitCode: -1, timedOut: true, finalMessage: null, numTurns: null } }),
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(fixFindingWorkflow, {
      workflowId: 'fix/mattpyle-com/timed-out',
      taskQueue: QUEUE,
      args: [input()],
    }),
  );
  assert.equal(seen.pr!.timedOut, true);
  assert.equal(result.draft, true);
  assert.equal(result.run.timedOut, true);
  assert.deepEqual(calls.slice(-2), ['openFixerPr', 'writeFindingFix']);
});

test('a non-zero exit with changes present: a draft PR marked incomplete', async () => {
  const { activities, seen } = mockActivities({
    runFixer: async () => ({ ...RUN, checks: [], claude: { ...RUN.claude, exitCode: 1 } }),
  });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(fixFindingWorkflow, {
      workflowId: 'fix/mattpyle-com/exit-1',
      taskQueue: QUEUE,
      args: [input()],
    }),
  );
  assert.equal(seen.pr!.exitCode, 1);
  assert.equal(result.draft, true);
  assert.equal(result.run.exitCode, 1);
  assert.equal(seen.write!.prUrl, PR);
});

test('a failed check on a finished run: a draft PR, and the finding is still marked fixing', async () => {
  const checks = [{ n: 1, status: 'fail' as const, command: 'npm test -w @mattpyle/steward' }];
  const { activities, calls, seen } = mockActivities({ runFixer: async () => ({ ...RUN, checks }) });
  const result = await withWorker(activities, () =>
    env.client.workflow.execute(fixFindingWorkflow, {
      workflowId: 'fix/mattpyle-com/check-failed',
      taskQueue: QUEUE,
      args: [input()],
    }),
  );
  assert.deepEqual(seen.pr!.checks, checks);
  assert.equal(seen.pr!.exitCode, 0);
  assert.equal(result.draft, true);
  assert.deepEqual(calls.slice(-2), ['openFixerPr', 'writeFindingFix']);
});

test('a stalled run fails the workflow on the first attempt: no PR, nothing written back', async () => {
  let attempts = 0;
  const { activities, calls } = mockActivities({
    runFixer: async () => {
      attempts++;
      throw ApplicationFailure.nonRetryable('Claude Code said nothing for 12 minutes and was stopped.', 'FixerStalled');
    },
  });
  const err = await withWorker(activities, () =>
    failure(
      env.client.workflow.execute(fixFindingWorkflow, {
        workflowId: 'fix/mattpyle-com/stalled',
        taskQueue: QUEUE,
        args: [input()],
      }),
    ),
  );
  assert.equal(err.type, 'FixerStalled');
  assert.equal(attempts, 1);
  assert.deepEqual(calls, ['readFinding', 'generateHandoff', 'runFixer']);
});

test('a failed run is not retried: a second attempt would spend a second model turn', async () => {
  let attempts = 0;
  const { activities } = mockActivities({
    runFixer: async () => {
      attempts++;
      throw new Error('npm ci failed (exit 1)');
    },
  });
  await withWorker(activities, () =>
    failure(
      env.client.workflow.execute(fixFindingWorkflow, {
        workflowId: 'fix/mattpyle-com/no-retry',
        taskQueue: QUEUE,
        args: [input()],
      }),
    ),
  );
  assert.equal(attempts, 1);
});

test('cancellation mid-turn: the activity is told, the workflow waits for it, and nothing is published', async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let sawCancel = false;
  let cleanedUp = false;
  const { activities, calls } = mockActivities({
    runFixer: async () => {
      const ctx = Context.current();
      const pump = setInterval(() => ctx.heartbeat('claude -p: Bash npm run build'), 50);
      started();
      try {
        // The model's turn: it ends only when the cancellation arrives.
        await ctx.cancelled;
      } catch (err) {
        sawCancel = err instanceof CancelledFailure;
        // The kill takes a moment; the workflow must not report cancelled before it.
        await new Promise((r) => setTimeout(r, 300));
        cleanedUp = true;
        throw err;
      } finally {
        clearInterval(pump);
      }
      return RUN;
    },
  });

  await withWorker(activities, async () => {
    const handle = await env.client.workflow.start(fixFindingWorkflow, {
      workflowId: 'fix/mattpyle-com/cancelled',
      taskQueue: QUEUE,
      args: [input()],
    });
    await running;
    assert.equal((await handle.query(fixFindingStateQuery)).step, 'fixing');
    await handle.cancel();
    await assert.rejects(handle.result(), (err: unknown) => {
      assert.ok(err instanceof WorkflowFailedError);
      assert.ok(err.cause instanceof CancelledFailure, `expected a cancellation, got ${String(err.cause)}`);
      return true;
    });
    assert.equal(cleanedUp, true, 'the workflow closed only after the activity finished its cleanup');
  });
  assert.equal(sawCancel, true);
  assert.deepEqual(calls, ['readFinding', 'generateHandoff', 'runFixer']);
});
