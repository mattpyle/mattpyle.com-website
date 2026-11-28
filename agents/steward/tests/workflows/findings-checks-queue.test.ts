import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { findingStateQuery, findingWorkflow, verdictSignal, type FindingState, type FindingWorkflowInput } from '../../src/workflows/finding.js';
import type { RunFindingChecksInput } from '../../src/activities/verify-finding.js';
import type { FindingVerdict, VerificationRow } from '../../src/lib/findings.js';
import type { VerifyCheck } from '../../src/lib/verify-checks.js';
import { QUEUE_FINDINGS, QUEUE_FINDINGS_CHECKS } from '../../src/config.js';
import { hostedRegistry } from '../../src/hosted-registry.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';
import { settings } from '../helpers/verdict-measure.js';

/**
 * A verdict write is not held behind browser checks (STW-716).
 *
 * Two workers, as the hosted container runs them: `steward-findings` and
 * `steward-findings-checks`, each with the cap `hostedRegistry()` gives it.
 * Every activity is mocked. Two approved runs reach their verdict measurement
 * and `runFindingChecks` blocks, so both of the checks queue's slots are held.
 * A third run's verdict write then completes, and its own check waits for a
 * slot: the cap holds.
 *
 * Before the move both checks ran on `steward-findings` with its cap of two,
 * and the third verdict write waited for one of them to finish.
 *
 * A server per test. No test here waits on a timer: the runs are read through
 * the plain client, and every check is released before the runs close.
 */

const SITE = 'mattpyle-com';
const CHECK: VerifyCheck = { url: `${ORIGIN}/llms.txt`, kind: 'status', expect: 200 } as VerifyCheck;
const ROW: VerificationRow = { n: 1, url: CHECK.url, kind: 'status', pass: false, expected: '200', measured: '404' };
const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'cli', at: '2026-11-27T20:00:00Z' };

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

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

async function until(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const step = async (handle: WorkflowHandle) => ((await handle.query(findingStateQuery)) as FindingState).step;

test('a verdict write completes while two browser checks hold the checks queue', async () => {
  const cap = (queue: string) => {
    const entry = hostedRegistry().find((each) => each.taskQueue === queue);
    assert.ok(entry, `no registry entry for ${queue}`);
    return entry.maxConcurrentActivityTaskExecutions;
  };
  assert.equal(cap(QUEUE_FINDINGS_CHECKS), 2);

  const verdictWrites: string[] = [];
  const checksStarted: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const none = { findingCommitSha: null, indexCommitSha: null, commitSha: null };

  const findingsActivities = {
    writeFindingVerdict: async (arg: { key: string }) => (verdictWrites.push(arg.key), none),
    readFindingSettings: async () => settings({ autoFix: false }),
    readFinding: async () => ({ text: DEFECT_FINDING, sha: 'f1' }),
    readVerifyBlock: async () => ({ handoff: null, hasBlock: true, checks: [CHECK], source: 'finding' as const }),
    writeFindingVerdictMeasure: async () => ({ commitSha: 'm1' }),
  };
  const checksActivities = {
    // A browser check that holds its slot until the test releases it.
    runFindingChecks: async (arg: RunFindingChecksInput) => {
      checksStarted.push(arg.key);
      await gate;
      return { results: [ROW], passed: false, ranAt: '2026-11-27T20:01:00.000Z' };
    },
  };

  const findings = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: findingsActivities,
    taskQueue: QUEUE_FINDINGS,
    maxConcurrentActivityTaskExecutions: cap(QUEUE_FINDINGS),
  });
  const checks = await Worker.create({
    connection: env.nativeConnection,
    activities: checksActivities,
    taskQueue: QUEUE_FINDINGS_CHECKS,
    maxConcurrentActivityTaskExecutions: cap(QUEUE_FINDINGS_CHECKS),
  });

  const keys = [`${DEFECT_KEY}-a`, `${DEFECT_KEY}-b`, `${DEFECT_KEY}-c`];
  const start = async (key: string) => {
    const handle = await client.workflow.start(findingWorkflow, { workflowId: `finding/${SITE}/${key}`, taskQueue: QUEUE_FINDINGS, args: [input(key)] });
    await handle.signal(verdictSignal, APPROVE);
    return handle;
  };

  const out = await checks.runUntil(
    findings.runUntil(
      bounded(
        (async () => {
          const handles: WorkflowHandle[] = [];
          try {
            handles.push(await start(keys[0]!), await start(keys[1]!));
            await until('two checks holding both slots', () => checksStarted.length === 2);

            handles.push(await start(keys[2]!));
            await until('the third verdict write', () => verdictWrites.includes(keys[2]!));
            // The third run's own check is scheduled, and waits: the cap is two.
            await until('the third run at its measurement', async () => (await handles[2]!.describe()).raw.pendingActivities?.length === 1);
            const held = { checksStarted: [...checksStarted], verdictWrites: [...verdictWrites] };

            release();
            for (const handle of handles) await until(`${handle.workflowId} past its measurement`, async () => (await step(handle)) === 'waiting-fix');
            for (const handle of handles) await handle.terminate('test over');
            return held;
          } finally {
            release();
          }
        })(),
      ),
    ),
  );

  assert.deepEqual(out.checksStarted.sort(), keys.slice(0, 2).sort(), 'two checks held both slots, and the third waited');
  assert.deepEqual(out.verdictWrites.sort(), [...keys].sort(), 'the third verdict was written while both slots were held');
  assert.equal(checksStarted.length, 3, 'the third check ran once a slot was free');
});
