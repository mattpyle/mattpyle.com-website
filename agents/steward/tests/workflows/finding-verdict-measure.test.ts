import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import {
  findingStateQuery,
  findingWorkflow,
  fixSignal,
  verdictSignal,
  type FindingState,
  type FindingWorkflowInput,
  type FindingWorkflowResult,
} from '../../src/workflows/finding.js';
import type { FixIssue } from '../../src/activities/findings.js';
import type { WriteFindingVerdictMeasureInput } from '../../src/activities/findings-verdict-measure.js';
import type { RunFindingChecksInput } from '../../src/activities/verify-finding.js';
import type { FindingVerdict, VerificationRow } from '../../src/lib/findings.js';
import type { VerifyCheck } from '../../src/lib/verify-checks.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * The measurement at the approved verdict (STW-589), on the real
 * `findingWorkflow` with every activity mocked. Each test scripts what
 * production answers and what the write does, then reads where the run went:
 * on to the fix as before, resolved with no fix, or held at `waiting-fix`.
 *
 * A server per test, for the reason `finding-lifecycle.test.ts` gives. No test
 * here waits on a timer: the run is read through the plain client.
 */

const FINDINGS = 'steward-findings';
const SITE = 'mattpyle-com';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const CHECK: VerifyCheck = { url: `${ORIGIN}/llms.txt`, kind: 'status', expect: 200 } as VerifyCheck;
const ROW = (pass: boolean): VerificationRow => ({ n: 1, url: CHECK.url, kind: 'status', pass, expected: '200', measured: pass ? '200' : '404' });

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

interface Scene {
  checks?: VerifyCheck[];
  /** What production answers; a throw is production not answering. */
  production?: () => Promise<VerificationRow[]>;
  /** What the write does; a throw is a refusal. */
  write?: (input: WriteFindingVerdictMeasureInput) => Promise<{ commitSha: string | null }>;
  autoFix?: boolean;
}

function mocks(scene: Scene) {
  const called: string[] = [];
  const writes: WriteFindingVerdictMeasureInput[] = [];
  const checksRan: RunFindingChecksInput[] = [];
  const note = (name: string) => called.push(name);
  const none = { findingCommitSha: null, indexCommitSha: null, commitSha: null };
  const activities = {
    writeFindingVerdict: async () => (note('writeFindingVerdict'), none),
    readFinding: async () => (note('readFinding'), { text: DEFECT_FINDING, sha: 'f1' }),
    readVerifyBlock: async () => (note('readVerifyBlock'), { handoff: null, hasBlock: true, checks: scene.checks ?? [CHECK], source: 'finding' as const }),
    runFindingChecks: async (input: RunFindingChecksInput) => {
      note('runFindingChecks');
      checksRan.push(input);
      const results = await (scene.production ?? (async () => [ROW(false)]))();
      return { results, passed: results.every((row) => row.pass), ranAt: '2026-11-11T09:00:00.000Z' };
    },
    writeFindingVerdictMeasure: async (input: WriteFindingVerdictMeasureInput) => {
      note('writeFindingVerdictMeasure');
      writes.push(input);
      return scene.write ? scene.write(input) : { commitSha: 'm1' };
    },
    readSiteAutoFix: async () => (note('readSiteAutoFix'), scene.autoFix ?? false),
    requestFixSlot: async () => (note('requestFixSlot'), { paths: [], dispatched: false }),
    openFixIssue: async (): Promise<FixIssue> => {
      note('openFixIssue');
      return { repo: SITE_REPO, number: 101, url: `https://github.com/${SITE_REPO}/issues/101`, reused: false };
    },
    // The PR never comes in these tests: the run sits in the PR wait.
    awaitFixPr: async () => {
      throw ApplicationFailure.retryable('no PR yet', 'NoPrYet');
    },
  };
  return { activities, called, writes, checksRan };
}

const input = (key: string): FindingWorkflowInput => ({
  site: SITE,
  key,
  repo: 'mattpyle/argus',
  findingPath: `sites/${SITE}/findings/${key}.md`,
  indexPath: `sites/${SITE}/findings/INDEX.md`,
  stopAfter: 'resolved',
  handoffPath: `sites/${SITE}/handoffs/${key}.md`,
  branch: `fix/finding-${key}`,
  origin: ORIGIN,
});

const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'cli', at: '2026-11-11T08:59:00Z' };

async function until(handle: WorkflowHandle, done: (state: FindingState) => boolean, what: string): Promise<FindingState> {
  for (let i = 0; i < 400; i++) {
    const state: FindingState = await handle.query(findingStateQuery);
    if (done(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the run did not reach ${what}`);
}

async function run<T>(scene: Scene, key: string, body: (handle: WorkflowHandle) => Promise<T>) {
  const m = mocks(scene);
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: m.activities,
    taskQueue: FINDINGS,
  });
  const out = await worker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(findingWorkflow, {
          workflowId: `finding/${SITE}/${key}`,
          taskQueue: FINDINGS,
          args: [input(key)],
        });
        await handle.signal(verdictSignal, APPROVE);
        return await body(handle);
      })(),
    ),
  );
  return { ...m, out };
}

test('a failing check is written as the before, and the fix goes on as before', async () => {
  const { called, writes, checksRan, out } = await run({}, `${DEFECT_KEY}-a`, async (handle) => {
    const parked = await until(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
    await handle.signal(fixSignal, { source: 'cli', at: '2026-11-11T09:05:00Z' });
    const fixing = await until(handle, (s) => s.step === 'fixing' && Boolean(s.issueUrl), 'the fix issue');
    await handle.terminate('test over');
    return { parked, fixing };
  });
  assert.equal(out.parked.verdictMeasure, 'check 1 of 1 fails on production');
  assert.equal(out.parked.fixAttempts, 0);
  assert.equal(out.parked.lastFixError, null);
  assert.equal(checksRan[0]?.previewOrigin, undefined, 'the checks ran on production, not a preview');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.measure.rows, [ROW(false)]);
  assert.equal(writes[0]?.verification, undefined, 'nothing is resolved');
  assert.equal(writes[0]?.measure.workflowId, `finding/${SITE}/${DEFECT_KEY}-a`);
  // Measured once, after the verdict write and before the auto-fix read and the slot.
  assert.deepEqual(called.slice(0, 6), [
    'writeFindingVerdict',
    'readFinding',
    'readVerifyBlock',
    'runFindingChecks',
    'writeFindingVerdictMeasure',
    'readSiteAutoFix',
  ]);
  assert.ok(called.includes('openFixIssue'), 'the fix started');
  assert.equal(called.filter((name) => name === 'runFindingChecks').length, 1);
});

test('every check passing resolves the finding at the verdict: no slot, no issue', async () => {
  const { called, writes, out } = await run(
    { production: async () => [ROW(true)], autoFix: true },
    `${DEFECT_KEY}-b`,
    async (handle) => (await handle.result()) as FindingWorkflowResult,
  );
  assert.equal(out.outcome, 'resolved');
  assert.equal(out.note, 'Resolved at the verdict: 1 of 1 checks pass on production, so no fix was opened.');
  assert.equal(out.fixAttempts, 0);
  assert.equal(out.prUrl, null);
  assert.equal(writes[0]?.verification?.status, 'resolved');
  assert.equal(writes[0]?.verification?.atVerdict, true);
  assert.deepEqual(writes[0]?.verification?.rows, [ROW(true)]);
  for (const name of ['readSiteAutoFix', 'requestFixSlot', 'openFixIssue']) assert.ok(!called.includes(name), `${name} was not called`);
});

test('a finding with no checks records why and goes on to its fix', async () => {
  const { called, writes, out } = await run({ checks: [], autoFix: true }, `${DEFECT_KEY}-c`, async (handle) => {
    const state = await until(handle, (s) => s.step === 'fixing' && Boolean(s.issueUrl), 'the fix issue');
    await handle.terminate('test over');
    return state;
  });
  assert.equal(out.verdictMeasure, 'unmeasured: the finding has no checks');
  assert.equal(writes[0]?.measure.rows, null);
  assert.equal(writes[0]?.measure.reason, 'the finding has no checks');
  assert.ok(!called.includes('runFindingChecks'));
  assert.ok(called.includes('openFixIssue'), 'the automatic attempt went on');
});

test('production not answering records why and goes on to the fix', async () => {
  const { writes, called, out } = await run(
    {
      production: async () => {
        throw ApplicationFailure.nonRetryable('https://www.mattpyle.com/llms.txt answered 503', 'VerifyCheckBroken');
      },
      autoFix: true,
    },
    `${DEFECT_KEY}-d`,
    async (handle) => {
      const state = await until(handle, (s) => s.step === 'fixing' && Boolean(s.issueUrl), 'the fix issue');
      await handle.terminate('test over');
      return state;
    },
  );
  assert.match(out.verdictMeasure ?? '', /^unmeasured: the checks did not run on production: .*answered 503$/);
  assert.equal(writes[0]?.measure.rows, null);
  assert.ok(called.includes('openFixIssue'));
});

test('a finding moved while it was measured opens no fix: the run holds at waiting-fix with the reason', async () => {
  const moved = 'sites/mattpyle-com/findings/x.md is rejected, not approved and unresolved, so the measurement at the verdict is not written.';
  const { called, out } = await run(
    {
      write: async () => {
        throw ApplicationFailure.nonRetryable(moved, 'FindingMoved');
      },
      autoFix: true,
    },
    `${DEFECT_KEY}-e`,
    async (handle) => {
      const state = await until(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
      // Settled: the automatic attempt would have started by now.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const after: FindingState = await handle.query(findingStateQuery);
      await handle.terminate('test over');
      return { state, after };
    },
  );
  assert.equal(out.after.step, 'waiting-fix');
  assert.equal(out.after.fixAttempts, 0, 'auto_fix did not start an attempt');
  assert.equal(out.after.lastFixError, moved);
  assert.equal(out.after.verdictMeasure, 'check 1 of 1 fails on production (not written: the finding moved)');
  assert.ok(!called.includes('requestFixSlot') && !called.includes('openFixIssue'));
});

test('a write that fails for another reason does not stop the fix', async () => {
  const { called, out } = await run(
    {
      write: async () => {
        throw ApplicationFailure.nonRetryable('Bad credentials', 'AuthError');
      },
      autoFix: true,
    },
    `${DEFECT_KEY}-f`,
    async (handle) => {
      const state = await until(handle, (s) => s.step === 'fixing' && Boolean(s.issueUrl), 'the fix issue');
      await handle.terminate('test over');
      return state;
    },
  );
  assert.equal(out.verdictMeasure, 'check 1 of 1 fails on production (not written: Bad credentials)');
  assert.ok(called.includes('openFixIssue'));
});

test('every check passing but the resolve write failing opens no fix: the run holds at waiting-fix with the reason', async () => {
  const { called, writes, out } = await run(
    {
      production: async () => [ROW(true)],
      write: async () => {
        throw ApplicationFailure.nonRetryable('Bad credentials', 'AuthError');
      },
      autoFix: true,
    },
    `${DEFECT_KEY}-g`,
    async (handle) => {
      await until(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
      // Settled: the automatic attempt would have started by now.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const after: FindingState = await handle.query(findingStateQuery);
      await handle.terminate('test over');
      return after;
    },
  );
  assert.equal(writes[0]?.verification?.status, 'resolved', 'it tried to resolve');
  assert.equal(out.step, 'waiting-fix');
  assert.equal(out.fixAttempts, 0, 'auto_fix did not start an attempt');
  assert.equal(out.lastFixError, 'Every check passed at the verdict, but the resolve was not written: Bad credentials');
  assert.equal(out.verdictMeasure, '1 of 1 checks pass on production (not written: Bad credentials)');
  assert.ok(!called.includes('requestFixSlot') && !called.includes('openFixIssue'));
});
