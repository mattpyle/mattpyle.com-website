import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import {
  verifyFindingStateQuery,
  verifyFindingWorkflow,
  type VerifyFindingInput,
} from '../../src/workflows/verify-finding.js';
import {
  readVerifyBlock,
  type ProductionRead,
  type ReadProductionDeployInput,
  type ReadVerifyBlockInput,
  type WriteFindingVerificationInput,
} from '../../src/activities/findings.js';
import type { RunFindingChecksInput } from '../../src/activities/verify-finding.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { verifyWorkflowId } from '../../src/lib/findings.js';
import { runChecks, type VerifyCheck } from '../../src/lib/verify-checks.js';
import { DEFECT_KEY, FIXING_FINDING, FIX_PR, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * `verifyFindingWorkflow` with its activities mocked, on `steward-findings`
 * as on the hosted worker: the pass, the fail, and the empty block and the
 * finding with no block, which the deploy confirms (design decision 30). `readVerifyBlock` is the real activity over the
 * finding's text, so the finding is the only source a test can give the
 * checks. The check run is the real `runChecks` over a fetch that serves one
 * page, so a pass and a fail are measured rather than declared.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE = 'steward-findings';
const AT = '2026-10-13T04:12:33.527Z';
const PAGE = '<p>Accessibility: 100/100, 1 axe violation (Fail)</p>';

const RIGHT: VerifyCheck = { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { contains: '1 axe violation (Fail)' } };
const WRONG: VerifyCheck = { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { contains: '3 axe violations (Fail)' } };

/** The fixing finding with a `verify` key in its frontmatter, as Argus writes it. JSON is YAML. */
function withBlock(checks: VerifyCheck[]): string {
  return FIXING_FINDING.replace('references: []', `references: []\nverify: ${JSON.stringify(checks)}`);
}

let env: TestWorkflowEnvironment;

before(async () => {
  env = await createTestEnv();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

interface Mocks {
  /** The finding file. Defaults to the fixing finding with `[RIGHT]` as its block. */
  finding?: string;
  /** False for a fixer PR that is still open. */
  merged?: boolean;
  runFindingChecks?: (input: RunFindingChecksInput) => Promise<never>;
  /** What the blockless verify's production read answers. Defaults to a live commit that contains the merge. */
  production?: Partial<ProductionRead>;
}

function mockActivities(mocks: Mocks = {}) {
  const calls: string[] = [];
  const seen: {
    pr?: string;
    read?: ReadVerifyBlockInput;
    production?: ReadProductionDeployInput;
    run?: RunFindingChecksInput;
    write?: WriteFindingVerificationInput;
  } = {};
  const activities = {
    readFinding: async (_repo: string, path: string) => {
      calls.push('readFinding');
      const text = mocks.finding ?? withBlock([RIGHT]);
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
      return readVerifyBlock(input);
    },
    readProductionDeploy: async (input: ReadProductionDeployInput): Promise<ProductionRead> => {
      calls.push('readProductionDeploy');
      seen.production = input;
      return {
        prUrl: input.prUrl,
        mergeSha: 'm312',
        liveSha: 'live1',
        deploymentId: 7,
        contains: true,
        why: '',
        readAt: '2026-10-13T04:12:38.000Z',
        ...mocks.production,
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
  return await worker.runUntil(bounded(fn()));
}

function input(overrides: Partial<VerifyFindingInput> = {}): VerifyFindingInput {
  return {
    site: 'mattpyle-com',
    key: DEFECT_KEY,
    repo: 'mattpyle/argus',
    findingPath: `sites/mattpyle-com/findings/${DEFECT_KEY}.md`,
    indexPath: 'sites/mattpyle-com/findings/INDEX.md',
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

test("pass: the finding's block runs on the findings queue, and the finding is resolved with the measured value", async () => {
  const { activities, calls, seen } = mockActivities();
  const result = await withWorker(activities, async () => {
    const handle = await start(input());
    const done = await handle.result();
    assert.equal((await handle.query(verifyFindingStateQuery)).step, 'done');
    return done;
  });

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'runFindingChecks', 'writeFindingVerification']);
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.source, 'finding');
  assert.equal(result.hasBlock, true);
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
    findingText: withBlock([RIGHT]),
    origin: ORIGIN,
  });
  assert.deepEqual(seen.run, { key: DEFECT_KEY, checks: [RIGHT] });
  assert.deepEqual(seen.write!.verification, {
    status: 'resolved',
    at: '2026-10-13T04:12:40.000Z',
    workflowId: `verify/mattpyle-com/${DEFECT_KEY}/2026-10-13T041233Z`,
    source: 'finding',
    rows: result.checks,
  });
});

test('fail: a check that does not hold reopens the finding with both values', async () => {
  const { activities, calls, seen } = mockActivities({ finding: withBlock([RIGHT, WRONG]) });
  const result = await withWorker(activities, async () => (await start(input())).result());

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'runFindingChecks', 'writeFindingVerification']);
  assert.equal(result.outcome, 'reopened');
  assert.deepEqual(result.checks.map((row) => row.pass), [true, false]);
  assert.equal(result.checks[1].expected, 'contains "3 axe violations (Fail)"');
  assert.equal(result.checks[1].measured, '0 occurrences');
  assert.equal(seen.write!.verification.status, 'reopened');
  assert.equal(seen.write!.verification.source, 'finding');
  assert.deepEqual(seen.write!.verification.rows, result.checks);
});

test('confirmed: a finding with no verify key is resolved by its deploy, with no rows and the three commits named', async () => {
  const { activities, calls, seen } = mockActivities({ finding: FIXING_FINDING });
  // An input recorded before decision 29 still names the handoff; nothing reads it.
  const result = await withWorker(activities, async () =>
    (await start(input({ handoffPath: `sites/mattpyle-com/handoffs/${DEFECT_KEY}.md` }))).result(),
  );

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'readProductionDeploy', 'writeFindingVerification']);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.hasBlock, false);
  assert.deepEqual(result.checks, []);
  assert.equal(result.findingCommitSha, 'c-index');
  assert.equal(result.ranAt, '2026-10-13T04:12:38.000Z');
  assert.deepEqual(result.deploy, { prUrl: FIX_PR, mergeSha: 'm312', liveSha: 'live1', deploymentId: 7 });
  assert.deepEqual(seen.production, { prUrl: FIX_PR, environment: 'Production' });
  assert.ok(!('handoffPath' in seen.read!), 'the block read is given no handoff path');
  assert.deepEqual(seen.write!.verification, {
    status: 'resolved',
    at: '2026-10-13T04:12:38.000Z',
    workflowId: `verify/mattpyle-com/${DEFECT_KEY}/2026-10-13T041233Z`,
    source: 'finding',
    rows: [],
    deploy: { prUrl: FIX_PR, mergeSha: 'm312', liveSha: 'live1' },
  });
});

test('confirmed: an empty block is the same answer, and --reason rides into the section', async () => {
  const { activities, calls, seen } = mockActivities({ finding: withBlock([]) });
  const result = await withWorker(activities, async () => (await start(input({ reason: 'Matt read the page.' }))).result());

  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'readProductionDeploy', 'writeFindingVerification']);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.hasBlock, true);
  assert.equal(seen.write!.verification.reason, 'Matt read the page.');
});

test('not contained: production without the fix fails the run as a check that could not measure, and writes nothing', async () => {
  const { activities, calls } = mockActivities({
    finding: FIXING_FINDING,
    production: { contains: false, liveSha: 'old', why: 'Production serves old, which does not contain m312 (behind).' },
  });
  const cause = await withWorker(activities, async () => failure((await start(input())).result()));
  assert.equal(cause.type, 'FixNotLive');
  assert.match(cause.message, /could not be confirmed by the deploy: Production serves old, which does not contain m312 \(behind\)\. The finding is unchanged\./);
  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'readProductionDeploy']);
});

test('a measured run carries --reason too', async () => {
  const { activities, seen } = mockActivities();
  const result = await withWorker(activities, async () => (await start(input({ reason: 'Checked by hand as well.' }))).result());
  assert.equal(result.outcome, 'resolved');
  assert.equal(seen.write!.verification.reason, 'Checked by hand as well.');
  assert.equal(seen.write!.verification.deploy, undefined);
});

test("a finding's block that fails validation fails the run on the first attempt, naming the finding", async () => {
  const offsite: VerifyCheck = { ...RIGHT, url: 'https://example.com/scorecard/' };
  const { activities, calls } = mockActivities({ finding: withBlock([offsite]) });
  const cause = await withWorker(activities, async () => failure((await start(input())).result()));
  const inner = ((cause as { cause?: Error & { type?: string } }).cause ?? cause) as Error & { type?: string };
  assert.equal(inner.type, 'VerifyBlockInvalid');
  assert.match(inner.message, new RegExp(`findings/${DEFECT_KEY}\\.md was refused`));
  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock']);
});

test('a read result recorded before source existed is read as the handoff', async () => {
  const { activities } = mockActivities();
  const legacy = {
    ...activities,
    readVerifyBlock: async () => ({ handoff: 'h', hasBlock: true, checks: [RIGHT] }),
  };
  const result = await withWorker(legacy, async () => (await start(input())).result());
  assert.equal(result.source, 'handoff');
  assert.equal(result.outcome, 'resolved');
});

test('refuse: a finding that is not fixing or reopened fails before its block is read', async () => {
  for (const status of ['approved', 'resolved', 'proposed']) {
    const { activities, calls } = mockActivities({ finding: withBlock([RIGHT]).replace('status: fixing', `status: ${status}`) });
    const cause = await withWorker(activities, async () => failure((await start(input())).result()));
    assert.equal(cause.type, 'FindingNotVerifiable');
    assert.match(cause.message, new RegExp(`its status is ${status}, not fixing or reopened`));
    assert.deepEqual(calls, ['readFinding']);
  }
});

test('a reopened finding whose PR is merged is verified again, and an unmerged one is not', async () => {
  const reopened = withBlock([RIGHT]).replace('status: fixing', 'status: reopened');
  const { activities, calls, seen } = mockActivities({ finding: reopened });
  const result = await withWorker(activities, async () => (await start(input())).result());
  assert.deepEqual(calls, ['readFinding', 'readFixPr', 'readVerifyBlock', 'runFindingChecks', 'writeFindingVerification']);
  assert.equal(result.outcome, 'resolved');
  assert.equal(seen.write!.verification.status, 'resolved');

  const open = mockActivities({ finding: reopened, merged: false });
  const cause = await withWorker(open.activities, async () => failure((await start(input())).result()));
  assert.equal(cause.type, 'FixNotMerged');
  assert.deepEqual(open.calls, ['readFinding', 'readFixPr']);
});

test('refuse: a fix that is not merged is not measured, so an open PR never reopens its finding', async () => {
  const { activities, calls } = mockActivities({ merged: false });
  const cause = await withWorker(activities, async () => failure((await start(input())).result()));
  assert.equal(cause.type, 'FixNotMerged');
  assert.match(cause.message, /pull\/312 is not merged/);
  assert.deepEqual(calls, ['readFinding', 'readFixPr']);

  const noLink = mockActivities({ finding: withBlock([RIGHT]).replace(/links:[^]*?pull\/312/, 'links: {}') });
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
