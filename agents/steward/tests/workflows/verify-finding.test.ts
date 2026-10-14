import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import { createTestEnv } from '../helpers/test-env.js';
import {
  verifyFindingStateQuery,
  verifyFindingWorkflow,
  type VerifyFindingInput,
} from '../../src/workflows/verify-finding.js';
import type { ReadVerifyBlockInput, WriteFindingVerificationInput } from '../../src/activities/findings.js';
import type { GenerateVerifyBlockInput } from '../../src/activities/fixer.js';
import type { RunFindingChecksInput } from '../../src/activities/verify-finding.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { verifyWorkflowId } from '../../src/lib/findings.js';
import { runChecks, type VerifyCheck } from '../../src/lib/verify-checks.js';
import { DEFECT_FINDING, DEFECT_HANDOFF, DEFECT_KEY, FIXING_FINDING, FIX_PR, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * `verifyFindingWorkflow` with its activities mocked: the pass, the fail, the
 * empty block, and the handoff that has no block yet. The check run is the real
 * `runChecks` over a fetch that serves one page, so a pass and a fail are
 * measured rather than declared.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE = 'steward-heavy';
const AT = '2026-10-13T04:12:33.527Z';
const FIXING = FIXING_FINDING;
const PAGE = '<p>Accessibility: 100/100, 1 axe violation (Fail)</p>';

const RIGHT: VerifyCheck = { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { contains: '1 axe violation (Fail)' } };
const WRONG: VerifyCheck = { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { contains: '3 axe violations (Fail)' } };

let env: TestWorkflowEnvironment;

before(async () => {
  env = await createTestEnv();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

interface Mocks {
  finding?: string;
  /** False for a fixer PR that is still open. */
  merged?: boolean;
  /** The block in the handoff, or `null` for a handoff that predates it. */
  block?: VerifyCheck[] | null;
  /** The finding's own block, which wins over the handoff's. Undefined for a finding with no `verify` key. */
  own?: VerifyCheck[];
  /** Leave `source` off the read result, as a history recorded before it existed does. */
  legacyRead?: boolean;
  /** What the generator writes when the handoff has none. */
  generated?: VerifyCheck[];
  runFindingChecks?: (input: RunFindingChecksInput) => Promise<never>;
}

function mockActivities(mocks: Mocks = {}) {
  const calls: string[] = [];
  const seen: {
    pr?: string;
    read?: ReadVerifyBlockInput;
    generate?: GenerateVerifyBlockInput;
    run?: RunFindingChecksInput;
    write?: WriteFindingVerificationInput;
  } = {};
  const block = mocks.block === undefined ? [RIGHT] : mocks.block;
  const activities = {
    readFinding: async (_repo: string, path: string) => {
      calls.push('readFinding');
      const text = mocks.finding ?? FIXING;
      return { path, text, sha: 'sha-1', data: parseFrontmatter(text).data };
    },
    readFixPr: async (prUrl: string) => {
      calls.push('readFixPr');
      seen.pr = prUrl;
      return { prUrl, merged: mocks.merged ?? true, mergedAt: mocks.merged === false ? null : '2026-10-13T03:40:00Z' };
    },
    readVerifyBlock: async (input: ReadVerifyBlockInput) => {
      calls.push('readVerifyBlock');
      seen.read = input;
      if (mocks.own) return { handoff: null, hasBlock: true, checks: mocks.own, source: 'finding' as const };
      const read = { handoff: DEFECT_HANDOFF, hasBlock: block !== null, checks: block ?? [] };
      if (mocks.legacyRead) return read;
      return { ...read, source: block === null ? ('generated' as const) : ('handoff' as const) };
    },
    generateVerifyBlock: async (input: GenerateVerifyBlockInput) => {
      calls.push('generateVerifyBlock');
      seen.generate = input;
      return {
        checks: mocks.generated ?? [RIGHT],
        commitSha: 'c-block',
        baseSha: 'c-base',
        claude: { model: 'claude-x', costUsd: 0.31, durationMs: 40_000, numTurns: 7 },
      };
    },
    runFindingChecks: async (input: RunFindingChecksInput) => {
      calls.push('runFindingChecks');
      seen.run = input;
      if (mocks.runFindingChecks) return mocks.runFindingChecks(input);
      const results = await runChecks(input.checks, {
        fetch: (async () => new Response(PAGE, { status: 200 })) as typeof fetch,
        openProbe: async () => {
          throw new Error('no browser in this suite');
        },
        userAgent: 'steward-test/1',
      });
      return { ranAt: '2026-10-13T04:12:40.000Z', passed: results.every((row) => row.pass), results };
    },
    writeFindingVerification: async (input: WriteFindingVerificationInput) => {
      calls.push('writeFindingVerification');
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
  });
  return await worker.runUntil(fn());
}

function input(overrides: Partial<VerifyFindingInput> = {}): VerifyFindingInput {
  return {
    site: 'mattpyle-com',
    key: DEFECT_KEY,
    repo: 'mattpyle/argus',
    findingPath: `sites/mattpyle-com/findings/${DEFECT_KEY}.md`,
    indexPath: 'sites/mattpyle-com/findings/INDEX.md',
    handoffPath: `sites/mattpyle-com/handoffs/${DEFECT_KEY}.md`,
    origin: ORIGIN,
    at: AT,
    ...overrides,
  };
}

let runs = 0;
function start(args: VerifyFindingInput) {
  return env.client.workflow.start(verifyFindingWorkflow, {
    // The stamp is the same in every test; the suffix keeps the IDs apart.
    workflowId: `${verifyWorkflowId(args.site, args.key, args.at)}-${runs++}`,
    taskQueue: QUEUE,
    args: [args],
  });
}

async function failure(run: Promise<unknown>): Promise<Error & { type?: string }> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof WorkflowFailedError, `expected a workflow failure, got ${String(err)}`);
    return err.cause as Error & { type?: string };
  }
  assert.fail('the workflow did not fail');
}

test('pass: read, read the block, run, write. The finding is resolved with the measured value', async () => {
  const { activities, calls, seen } = mockActivities();
  const result = await withWorker(activities, async () => {
    const handle = await start(input());
    const done = await handle.result();
    assert.equal((await handle.query(verifyFindingStateQuery)).step, 'done');
    return done;
  });

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'runFindingChecks', 'writeFindingVerification']);
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.generated, false);
  assert.deepEqual(result.block, [RIGHT]);
  assert.deepEqual(result.checks, [
    {
      n: 1,
      url: `${ORIGIN}/scorecard/`,
      kind: 'text',
      pass: true,
      expected: 'contains "1 axe violation (Fail)"',
      measured: '1 occurrences',
    },
  ]);
  assert.equal(result.findingCommitSha, 'c-index');
  assert.equal(result.ranAt, '2026-10-13T04:12:40.000Z');

  assert.equal(seen.pr, FIX_PR);
  assert.deepEqual(seen.read, {
    repo: 'mattpyle/argus',
    findingPath: input().findingPath,
    findingText: FIXING,
    handoffPath: input().handoffPath,
    origin: ORIGIN,
  });
  assert.equal(result.source, 'handoff');
  assert.deepEqual(seen.run, { key: DEFECT_KEY, checks: [RIGHT] });
  assert.deepEqual(seen.write!.verification, {
    status: 'resolved',
    at: '2026-10-13T04:12:40.000Z',
    workflowId: `verify/mattpyle-com/${DEFECT_KEY}/2026-10-13T041233Z`,
    source: 'handoff',
    rows: result.checks,
  });
});

test('fail: a check that does not hold reopens the finding with both values', async () => {
  const { activities, calls, seen } = mockActivities({ block: [RIGHT, WRONG] });
  const result = await withWorker(activities, async () => (await start(input())).result());

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'runFindingChecks', 'writeFindingVerification']);
  assert.equal(result.outcome, 'reopened');
  assert.deepEqual(result.checks.map((row) => row.pass), [true, false]);
  assert.equal(result.checks[1].expected, 'contains "3 axe violations (Fail)"');
  assert.equal(result.checks[1].measured, '0 occurrences');
  assert.equal(seen.write!.verification.status, 'reopened');
  assert.deepEqual(seen.write!.verification.rows, result.checks);
});

test('unverifiable: an empty block runs nothing and writes nothing', async () => {
  const { activities, calls } = mockActivities({ block: [] });
  const result = await withWorker(activities, async () => (await start(input())).result());

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock']);
  assert.equal(result.outcome, 'unverifiable');
  assert.deepEqual(result.checks, []);
  assert.equal(result.findingCommitSha, null);
  assert.equal(result.ranAt, null);
});

test('generate-then-run: a handoff with no block gets one from the generator, and the generated block is what runs', async () => {
  const { activities, calls, seen } = mockActivities({ block: null, generated: [RIGHT] });
  const result = await withWorker(activities, async () => (await start(input())).result());

  assert.deepEqual(calls, [
    'readFinding',
    'readFixPr',
    'readVerifyBlock',
    'generateVerifyBlock',
    'runFindingChecks',
    'writeFindingVerification',
  ]);
  assert.deepEqual(seen.generate, {
    repo: 'mattpyle/argus',
    key: DEFECT_KEY,
    findingText: FIXING,
    handoffPath: input().handoffPath,
    origin: ORIGIN,
  });
  assert.deepEqual(seen.run!.checks, [RIGHT]);
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.generated, true);
  assert.equal(result.source, 'generated');
  assert.equal(seen.write!.verification.source, 'generated');
  assert.equal(result.handoffCommitSha, 'c-block');
  assert.equal(result.generateCostUsd, 0.31);
});

test("finding's block: its checks run, nothing is generated, and the write names the finding", async () => {
  const { activities, calls, seen } = mockActivities({ own: [RIGHT, RIGHT], block: [WRONG] });
  const result = await withWorker(activities, async () => (await start(input())).result());

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'runFindingChecks', 'writeFindingVerification']);
  assert.deepEqual(seen.run!.checks, [RIGHT, RIGHT]);
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.source, 'finding');
  assert.equal(result.generated, false);
  assert.equal(seen.write!.verification.source, 'finding');
});

test("finding's empty block: unverifiable, and nothing is generated even though the handoff has no block", async () => {
  const { activities, calls } = mockActivities({ own: [], block: null });
  const result = await withWorker(activities, async () => (await start(input())).result());

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock']);
  assert.equal(result.outcome, 'unverifiable');
  assert.equal(result.source, 'finding');
  assert.equal(result.generated, false);
});

test('a read result recorded before source existed still branches on hasBlock', async () => {
  const kept = mockActivities({ block: [RIGHT], legacyRead: true });
  const fromHandoff = await withWorker(kept.activities, async () => (await start(input())).result());
  assert.equal(fromHandoff.source, 'handoff');
  assert.ok(!kept.calls.includes('generateVerifyBlock'));

  const bare = mockActivities({ block: null, legacyRead: true });
  const generated = await withWorker(bare.activities, async () => (await start(input())).result());
  assert.equal(generated.source, 'generated');
  assert.ok(bare.calls.includes('generateVerifyBlock'));
});

test('generate-then-unverifiable: a generated empty block ends the run with nothing written to the finding', async () => {
  const { activities, calls } = mockActivities({ block: null, generated: [] });
  const result = await withWorker(activities, async () => (await start(input())).result());

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'generateVerifyBlock']);
  assert.equal(result.outcome, 'unverifiable');
  assert.equal(result.generated, true);
  assert.equal(result.handoffCommitSha, 'c-block');
});

test('refuse: a finding that is not fixing fails before its handoff is read', async () => {
  for (const status of ['approved', 'resolved', 'reopened']) {
    const { activities, calls } = mockActivities({ finding: FIXING_FINDING.replace('status: fixing', `status: ${status}`) });
    const cause = await withWorker(activities, async () => failure((await start(input())).result()));
    assert.equal(cause.type, 'FindingNotVerifiable');
    assert.match(cause.message, new RegExp(`its status is ${status}, not fixing`));
    assert.deepEqual(calls, ['readFinding']);
  }
});

test('refuse: a fix that is not merged is not measured, so an open PR never reopens its finding', async () => {
  const { activities, calls } = mockActivities({ merged: false });
  const cause = await withWorker(activities, async () => failure((await start(input())).result()));
  assert.equal(cause.type, 'FixNotMerged');
  assert.match(cause.message, /pull\/312 is not merged/);
  assert.deepEqual(calls, ['readFinding', 'readFixPr']);

  const noLink = mockActivities({ finding: FIXING.replace(/links:[^]*?pull\/312/, 'links: {}') });
  const refused = await withWorker(noLink.activities, async () => failure((await start(input())).result()));
  assert.equal(refused.type, 'FindingNotVerifiable');
  assert.match(refused.message, /no links\.pr/);
  assert.deepEqual(noLink.calls, ['readFinding']);
});

test('a check whose own expression does not run fails the workflow on the first attempt, and nothing is written', async () => {
  let attempts = 0;
  const { activities, calls } = mockActivities({
    runFindingChecks: async () => {
      attempts++;
      throw ApplicationFailure.nonRetryable('the expression threw', 'VerifyCheckBroken');
    },
  });
  const cause = await withWorker(activities, async () => failure((await start(input())).result()));
  assert.equal(attempts, 1);
  assert.match(String((cause as { cause?: Error }).cause?.message ?? cause.message), /the expression threw/);
  assert.ok(!calls.includes('writeFindingVerification'));
});

test('production being down is retried, and a run that never measures writes nothing', async () => {
  let attempts = 0;
  const { activities, calls } = mockActivities({
    runFindingChecks: async () => {
      attempts++;
      throw new Error('https://www.mattpyle.com/scorecard/ answered 503');
    },
  });
  await withWorker(activities, async () => failure((await start(input())).result()));
  assert.equal(attempts, 3);
  assert.ok(!calls.includes('writeFindingVerification'), 'an outage does not reopen a finding');
});
