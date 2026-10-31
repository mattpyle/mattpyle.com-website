import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { fixFindingWorkflow, type FixFindingInput } from '../../src/workflows/fix-finding.js';
import type { AwaitPreviewDeployInput, PreviewDeploy, WriteFindingFixInput } from '../../src/activities/findings.js';
import {
  readFixChecks,
  type GenerateVerifyBlockInput,
  type GenerateVerifyBlockResult,
  type OpenFixerPrInput,
  type ReviewFixDiffInput,
  type ReviewFixDiffResult,
  type RunFixerInput,
  type RunFixerResult,
} from '../../src/activities/fixer.js';
import type { RunFindingChecksInput, RunFindingChecksResult } from '../../src/activities/verify-finding.js';
import { opensAsDraft } from '../../src/lib/fixer.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import type { VerifyCheck } from '../../src/lib/verify-checks.js';
import { DEFECT_FINDING, DEFECT_HANDOFF, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * The `verify` block's two tests inside `fixFindingWorkflow`, with every
 * activity mocked except `readFixChecks`, which is pure: the production test
 * before the fixer, the one regeneration, and the preview test after the PR.
 * Each branch of the handoff's Tasks 2 and 3 is one test here.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE = 'steward-heavy';
const PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/340';
const PREVIEW = 'https://mattpyle-com-website-abc123-mattpyles-projects.vercel.app';

let env: TestWorkflowEnvironment;

before(async () => {
  env = await createTestEnv();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

const CHECK_A: VerifyCheck = { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { count: 0, of: '100/100 (Fail)' } };
const CHECK_B: VerifyCheck = { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { contains: '1 axe violation' } };
const CHECK_C: VerifyCheck = { url: `${ORIGIN}/scorecard.json`, kind: 'status', expect: 200 };

const yamlCheck = (check: VerifyCheck) => [
  `  - url: ${check.url}`,
  `    kind: ${check.kind}`,
  `    expect: ${JSON.stringify(check.expect)}`,
];

/** The defect with its own `verify` key in the frontmatter. */
const findingWith = (checks: VerifyCheck[]) =>
  DEFECT_FINDING.replace('references: []', ['references: []', 'verify:', ...checks.flatMap(yamlCheck)].join('\n'));

/** The handoff with a non-empty block. */
const handoffWith = (checks: VerifyCheck[]) =>
  DEFECT_HANDOFF.replace('verify: []', ['verify:', ...checks.flatMap(yamlCheck)].join('\n'));

const RUN: RunFixerResult = {
  branch: `fix/finding-${DEFECT_KEY}`,
  base: 'master',
  commitSha: 'c-fix-head',
  filesChanged: ['agents/steward/src/workflows/scorecard-audit.ts'],
  checks: [{ n: 1, status: 'pass', command: 'npm test -w @mattpyle/steward' }],
  claude: {
    exitCode: 0,
    timedOut: false,
    finalMessage: 'Done.',
    model: 'claude-x',
    sessionId: 's1',
    numTurns: 40,
    costUsd: 1.2,
    permissionDenials: [],
  },
  npmCi: false,
  timingsMs: { worktree: 1, install: 2, claude: 3, checks: 5, push: 4, total: 15 },
};

/** Which checks pass, keyed by the check's `expect`, on each origin. */
type Outcomes = { production: (check: VerifyCheck) => boolean; preview: (check: VerifyCheck) => boolean };

const same = (a: VerifyCheck, b: VerifyCheck) => JSON.stringify(a.expect) === JSON.stringify(b.expect);

interface Mocks {
  finding?: string;
  handoff?: string;
  outcomes?: Partial<Outcomes>;
  /** Replaces the scripted check run. */
  runChecks?: (input: RunFindingChecksInput) => Promise<RunFindingChecksResult>;
  regenerate?: (input: GenerateVerifyBlockInput) => Promise<GenerateVerifyBlockResult>;
  preview?: (input: AwaitPreviewDeployInput) => Promise<PreviewDeploy>;
  review?: (input: ReviewFixDiffInput) => Promise<ReviewFixDiffResult>;
}

function mockActivities(mocks: Mocks = {}) {
  const calls: string[] = [];
  const seen: {
    checks: RunFindingChecksInput[];
    regenerate: GenerateVerifyBlockInput[];
    preview?: AwaitPreviewDeployInput;
    run?: RunFixerInput;
    review?: ReviewFixDiffInput;
    prs: OpenFixerPrInput[];
    write?: WriteFindingFixInput;
  } = { checks: [], regenerate: [], prs: [] };
  const outcomes: Outcomes = {
    production: () => false,
    preview: () => true,
    ...mocks.outcomes,
  };
  const handoff = mocks.handoff ?? handoffWith([CHECK_A]);
  const activities = {
    readFinding: async (_repo: string, path: string) => {
      calls.push('readFinding');
      const text = mocks.finding ?? DEFECT_FINDING;
      return { path, text, sha: 'sha-1', data: parseFrontmatter(text).data };
    },
    generateHandoff: async () => {
      calls.push('generateHandoff');
      return {
        handoff,
        title: 'Name the failing reason in scorecard commentary',
        commitSha: 'c-handoff',
        base: 'master',
        baseSha: 'c-base',
        claude: { model: 'claude-x', costUsd: 0.05, durationMs: 20_000, numTurns: 9 },
      };
    },
    readFixChecks: async (input: Parameters<typeof readFixChecks>[0]) => {
      calls.push('readFixChecks');
      return readFixChecks(input);
    },
    runFindingChecks: async (input: RunFindingChecksInput): Promise<RunFindingChecksResult> => {
      calls.push(input.previewOrigin ? 'runFindingChecks:preview' : 'runFindingChecks:production');
      seen.checks.push(input);
      if (mocks.runChecks) return mocks.runChecks(input);
      const passes = input.previewOrigin ? outcomes.preview : outcomes.production;
      const results = input.checks.map((check, i) => {
        const pass = passes(check);
        return {
          n: i + 1,
          url: check.url,
          kind: check.kind,
          pass,
          expected: JSON.stringify(check.expect),
          measured: pass ? 'as expected' : 'not as expected',
        };
      });
      return { ranAt: '2026-10-13T20:00:00.000Z', passed: results.every((row) => row.pass), results };
    },
    generateVerifyBlock: async (input: GenerateVerifyBlockInput): Promise<GenerateVerifyBlockResult> => {
      calls.push('generateVerifyBlock');
      seen.regenerate.push(input);
      if (mocks.regenerate) return mocks.regenerate(input);
      return {
        checks: [CHECK_B],
        handoff: handoffWith([CHECK_B]),
        commitSha: 'c-block',
        baseSha: 'c-base',
        claude: { model: 'claude-x', costUsd: 0.03, durationMs: 9_000, numTurns: 5 },
      };
    },
    runFixer: async (input: RunFixerInput) => {
      calls.push('runFixer');
      seen.run = input;
      return RUN;
    },
    reviewFixDiff: async (input: ReviewFixDiffInput): Promise<ReviewFixDiffResult> => {
      calls.push('reviewFixDiff');
      seen.review = input;
      if (mocks.review) return mocks.review(input);
      return { problems: [], incomplete: null, diffChars: 100, reply: 'problems: []', claude: null };
    },
    openFixerPr: async (input: OpenFixerPrInput) => {
      calls.push('openFixerPr');
      seen.prs.push(structuredClone(input));
      return { prUrl: PR, draft: opensAsDraft(input) };
    },
    writeFindingFix: async (input: WriteFindingFixInput) => {
      calls.push('writeFindingFix');
      seen.write = input;
      return { findingCommitSha: 'c-file', indexCommitSha: 'c-index', commitSha: 'c-index' };
    },
    awaitPreviewDeploy: async (input: AwaitPreviewDeployInput) => {
      calls.push('awaitPreviewDeploy');
      seen.preview = input;
      return mocks.preview ? mocks.preview(input) : { origin: PREVIEW, deploymentId: 77 };
    },
  };
  return { activities, calls, seen };
}

function input(overrides: Partial<FixFindingInput> = {}): FixFindingInput {
  return {
    site: 'mattpyle-com',
    key: DEFECT_KEY,
    repo: 'mattpyle/argus',
    findingPath: `sites/mattpyle-com/findings/${DEFECT_KEY}.md`,
    indexPath: 'sites/mattpyle-com/findings/INDEX.md',
    handoffPath: `sites/mattpyle-com/handoffs/${DEFECT_KEY}.md`,
    branch: `fix/finding-${DEFECT_KEY}`,
    stopAfter: 'pr',
    ...overrides,
  };
}

let runs = 0;
async function execute(activities: Record<string, unknown>) {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities,
    taskQueue: QUEUE,
    bundlerOptions: {},
  });
  return worker.runUntil(
    bounded(
      env.client.workflow.execute(fixFindingWorkflow, {
        workflowId: `fix/mattpyle-com/checks-${++runs}`,
        taskQueue: QUEUE,
        args: [input()],
      }),
    ),
  );
}

const FULL_ORDER = [
  'readFinding',
  'generateHandoff',
  'readFixChecks',
  'runFindingChecks:production',
  'runFixer',
  'reviewFixDiff',
  'openFixerPr',
  'writeFindingFix',
  'awaitPreviewDeploy',
  'runFindingChecks:preview',
  'openFixerPr',
];

// ---------------------------------------------------------------------------
// Task 1 and the pass
// ---------------------------------------------------------------------------

test("the finding's own block is chosen over the handoff's, fails on production, passes on the preview: a ready PR", async () => {
  const { activities, calls, seen } = mockActivities({ finding: findingWith([CHECK_A]), handoff: handoffWith([CHECK_C]) });
  const result = await execute(activities);

  assert.deepEqual(calls, FULL_ORDER);
  // Both tests ran the finding's block, on production first and the preview second.
  assert.deepEqual(seen.checks[0], { key: DEFECT_KEY, checks: [CHECK_A] });
  assert.deepEqual(seen.checks[1], { key: DEFECT_KEY, checks: [CHECK_A], previewOrigin: PREVIEW });
  // The preview is the PR head's, in the site repository the PR names.
  assert.deepEqual(seen.preview, { repo: 'mattpyle/mattpyle.com-website', sha: 'c-fix-head', environment: 'Preview' });

  // The PR opens with the production test and is updated with the preview's.
  assert.equal(seen.prs[0].site?.preview, null);
  assert.equal(seen.prs[0].site?.production?.[0].pass, false);
  assert.equal(seen.prs[1].site?.preview?.[0].pass, true);

  assert.equal(result.draft, false);
  assert.equal(result.verify?.source, 'finding');
  assert.equal(result.verify?.regenerated, false);
  assert.equal(result.verify?.previewOrigin, PREVIEW);
  assert.deepEqual(result.verify?.block, [CHECK_A]);
});

// ---------------------------------------------------------------------------
// Task 2: the production test
// ---------------------------------------------------------------------------

test('a finding check that passes on production is never rewritten: the PR opens as a draft', async () => {
  const { activities, calls, seen } = mockActivities({
    finding: findingWith([CHECK_A, CHECK_C]),
    outcomes: { production: (check) => same(check, CHECK_C) },
  });
  const result = await execute(activities);

  assert.ok(!calls.includes('generateVerifyBlock'), 'a finding check is never regenerated');
  assert.deepEqual(calls, FULL_ORDER);
  assert.equal(seen.prs[0].site?.production?.[1].pass, true);
  assert.equal(opensAsDraft(seen.prs[0]), true, 'the PR opens as a draft');
  assert.equal(result.draft, true);
});

test('a handoff check that passes on production is written again once, told what each check measured', async () => {
  const { activities, calls, seen } = mockActivities({
    handoff: handoffWith([CHECK_A, CHECK_C]),
    outcomes: { production: (check) => same(check, CHECK_C) },
  });
  const result = await execute(activities);

  assert.deepEqual(calls, [
    'readFinding',
    'generateHandoff',
    'readFixChecks',
    'runFindingChecks:production',
    'generateVerifyBlock',
    'runFindingChecks:production',
    'runFixer',
    'reviewFixDiff',
    'openFixerPr',
    'writeFindingFix',
    'awaitPreviewDeploy',
    'runFindingChecks:preview',
    'openFixerPr',
  ]);
  const asked = seen.regenerate[0];
  assert.equal(seen.regenerate.length, 1);
  assert.equal(asked.origin, ORIGIN);
  assert.deepEqual(asked.rejected?.checks, [CHECK_A, CHECK_C]);
  assert.deepEqual(asked.rejected?.results?.map((row) => [row.n, row.pass, row.measured]), [
    [1, false, 'not as expected'],
    [2, true, 'as expected'],
  ]);
  // The fixer gets the handoff with the block that stands, and both tests run it.
  assert.equal(seen.run!.handoff, handoffWith([CHECK_B]));
  assert.deepEqual(seen.checks[1].checks, [CHECK_B]);
  assert.deepEqual(seen.checks[2].checks, [CHECK_B]);
  assert.equal(result.verify?.regenerated, true);
  assert.equal(result.draft, false);
});

test('a handoff check that still passes after the regeneration: the run continues and the PR opens as a draft', async () => {
  const { activities, calls, seen } = mockActivities({
    outcomes: { production: () => true },
  });
  const result = await execute(activities);

  assert.equal(calls.filter((c) => c === 'generateVerifyBlock').length, 1, 'one regeneration, no more');
  assert.ok(calls.includes('runFixer'), 'the run continues');
  assert.equal(seen.prs[0].site?.regenerated, true);
  assert.equal(seen.prs[0].site?.production?.[0].pass, true);
  assert.equal(opensAsDraft(seen.prs[0]), true);
  assert.equal(result.draft, true);
});

test('a broken handoff check on production is regenerated like a passing one', async () => {
  let call = 0;
  const { activities, calls, seen } = mockActivities({
    runChecks: async (input) => {
      call++;
      if (call === 1) throw ApplicationFailure.nonRetryable('the expression threw on https://www.mattpyle.com/: x is not defined', 'VerifyCheckBroken');
      const results = input.checks.map((check, i) => ({
        n: i + 1, url: check.url, kind: check.kind, pass: Boolean(input.previewOrigin), expected: 'e', measured: 'm',
      }));
      return { ranAt: '2026-10-13T20:00:00.000Z', passed: results.every((r) => r.pass), results };
    },
  });
  const result = await execute(activities);

  assert.ok(calls.includes('generateVerifyBlock'));
  assert.equal(seen.regenerate[0].rejected?.results, null);
  assert.match(String(seen.regenerate[0].rejected?.broken), /x is not defined/);
  assert.equal(result.draft, false);
});

test('a regeneration that fails leaves the first block standing, with the reason, and a draft', async () => {
  const { activities, calls, seen } = mockActivities({
    outcomes: { production: () => true },
    regenerate: async () => {
      throw ApplicationFailure.nonRetryable('The generated verify block was refused: verify is not a list.', 'VerifyBlockInvalid');
    },
  });
  const result = await execute(activities);

  assert.ok(calls.includes('runFixer'));
  assert.equal(seen.run!.handoff, handoffWith([CHECK_A]));
  assert.match(String(result.verify?.regenerateError), /verify is not a list/);
  assert.equal(result.verify?.regenerated, false);
  assert.equal(result.draft, true);
});

test('an empty block is unverifiable by checks: no test runs, no preview wait, and no draft', async () => {
  const { activities, calls, seen } = mockActivities({ handoff: DEFECT_HANDOFF });
  const result = await execute(activities);

  assert.deepEqual(calls, ['readFinding', 'generateHandoff', 'readFixChecks', 'runFixer', 'reviewFixDiff', 'openFixerPr', 'writeFindingFix']);
  assert.deepEqual(seen.prs[0].site?.block, []);
  assert.equal(result.verify?.source, 'handoff');
  assert.equal(result.draft, false);
});

test("a finding's empty block wins over the handoff's checks", async () => {
  const { activities, calls } = mockActivities({ finding: findingWith([]).replace('verify:\n', 'verify: []\n') });
  const result = await execute(activities);
  assert.ok(!calls.some((c) => c.startsWith('runFindingChecks')));
  assert.equal(result.verify?.source, 'finding');
  assert.deepEqual(result.verify?.block, []);
});

// ---------------------------------------------------------------------------
// Task 3: the preview test
// ---------------------------------------------------------------------------

test('a check that fails on the preview turns the PR into a draft, and is not rewritten', async () => {
  const { activities, calls, seen } = mockActivities({ outcomes: { preview: () => false } });
  const result = await execute(activities);

  assert.deepEqual(calls, FULL_ORDER);
  assert.ok(!calls.includes('generateVerifyBlock'));
  assert.equal(opensAsDraft(seen.prs[0]), false, 'the PR opened ready');
  assert.equal(seen.prs[1].site?.preview?.[0].pass, false);
  assert.equal(result.draft, true);
});

test('a preview build that failed is a draft with the reason, and no check runs against it', async () => {
  const { activities, calls, seen } = mockActivities({
    preview: async () => {
      throw ApplicationFailure.nonRetryable('The Preview deployment of c-fix-h ended failure.', 'PreviewFailed');
    },
  });
  const result = await execute(activities);

  assert.ok(!calls.includes('runFindingChecks:preview'));
  assert.match(String(seen.prs[1].site?.previewNote), /ended failure/);
  assert.equal(result.verify?.previewOrigin, null);
  assert.equal(result.draft, true);
});

test('no preview within 20 minutes: polled every 30 seconds, then a draft with the reason', async () => {
  let polls = 0;
  const { activities, calls, seen } = mockActivities({
    preview: async () => {
      polls++;
      throw ApplicationFailure.retryable('No Preview deployment of c-fix-h yet.', 'PreviewNotReady');
    },
  });
  const result = await execute(activities);

  assert.ok(polls >= 30 && polls <= 41, `about forty polls in twenty minutes, saw ${polls}`);
  assert.ok(!calls.includes('runFindingChecks:preview'));
  assert.match(String(seen.prs[1].site?.previewNote), /was ready within 20 minutes/);
  assert.equal(result.draft, true);
});

test('a worker without the bypass secret is a draft with the reason, and the run still completes', async () => {
  const { activities, seen } = mockActivities({
    runChecks: async (input) => {
      if (input.previewOrigin) {
        throw ApplicationFailure.nonRetryable('VERCEL_AUTOMATION_BYPASS_SECRET is not set on the worker.', 'PreviewBypassMissing');
      }
      const results = input.checks.map((check, i) => ({ n: i + 1, url: check.url, kind: check.kind, pass: false, expected: 'e', measured: 'm' }));
      return { ranAt: '2026-10-13T20:00:00.000Z', passed: false, results };
    },
  });
  const result = await execute(activities);
  assert.match(String(seen.prs[1].site?.previewNote), /VERCEL_AUTOMATION_BYPASS_SECRET is not set/);
  assert.equal(seen.write!.prUrl, PR, 'the finding was marked fixing before the preview');
  assert.equal(result.draft, true);
});

// ---------------------------------------------------------------------------
// The diff review
// ---------------------------------------------------------------------------

test("the review reads the fixer's diff, base to head, with the finding and the handoff the fixer ran", async () => {
  const { activities, calls, seen } = mockActivities();
  const result = await execute(activities);

  assert.ok(calls.indexOf('reviewFixDiff') === calls.indexOf('runFixer') + 1, 'straight after the fixer');
  assert.deepEqual(seen.review, {
    key: DEFECT_KEY,
    findingText: DEFECT_FINDING,
    handoff: handoffWith([CHECK_A]),
    baseSha: 'c-base',
    headSha: 'c-fix-head',
    coverage: null,
  });
  assert.deepEqual(seen.prs[0].review, { problems: [], incomplete: null });
  assert.deepEqual(result.review, { problems: [], incomplete: null });
  assert.equal(result.draft, false);
});

test("the handoff's map reaches the review and the PR, and a surface with only a reason opens a draft", async () => {
  const map = [
    `  - surface: ${ORIGIN}/scorecard/`,
    '    checks: [1]',
    '  - surface: the A2A answer',
    '    reason: A2A is a POST; no check kind sends one.',
  ];
  const handoff = handoffWith([CHECK_A]).replace('\n---\n\n# Handoff', `\nverify_coverage:\n${map.join('\n')}\n---\n\n# Handoff`);
  const { activities, calls, seen } = mockActivities({ handoff });
  const result = await execute(activities);

  const coverage = [
    { surface: `${ORIGIN}/scorecard/`, checks: [1] },
    { surface: 'the A2A answer', reason: 'A2A is a POST; no check kind sends one.' },
  ];
  assert.deepEqual(calls, FULL_ORDER, 'the map changes no step');
  assert.deepEqual(seen.review?.coverage, coverage);
  assert.deepEqual(seen.prs[0].site?.coverage, coverage);
  assert.deepEqual(result.verify?.coverage, coverage);
  assert.equal(result.draft, true);
});

test("a regeneration's map replaces the first block's", async () => {
  const regenerated = [{ surface: `${ORIGIN}/scorecard/`, checks: [1] }];
  const { activities, seen } = mockActivities({
    handoff: handoffWith([CHECK_A, CHECK_C]),
    outcomes: { production: (check) => same(check, CHECK_C) },
    regenerate: async () => ({
      checks: [CHECK_B],
      coverage: regenerated,
      handoff: handoffWith([CHECK_B]),
      commitSha: 'c-block',
      baseSha: 'c-base',
      claude: { model: 'claude-x', costUsd: 0.03, durationMs: 9_000, numTurns: 5 },
    }),
  });
  const result = await execute(activities);
  assert.deepEqual(seen.review?.coverage, regenerated);
  assert.deepEqual(result.verify?.coverage, regenerated);
  assert.equal(result.draft, false);
});

test('a reported problem opens the PR as a draft, and the preview test still runs', async () => {
  const problem = { file: 'src/lib/a2a-responder.mjs', line: 119, kind: 'error' as const, note: 'Missing space: "no product,no company".' };
  const { activities, calls, seen } = mockActivities({
    review: async () => ({ problems: [problem], incomplete: null, diffChars: 900, reply: null, claude: null }),
  });
  const result = await execute(activities);

  assert.ok(calls.includes('runFindingChecks:preview'));
  assert.deepEqual(seen.prs[0].review?.problems, [problem]);
  assert.deepEqual(seen.prs[1].review?.problems, [problem], 'the update after the preview keeps the review');
  assert.equal(opensAsDraft(seen.prs[0]), true);
  assert.equal(result.draft, true);
});

test('a review activity that throws is an unfinished review and a draft, never a failed workflow', async () => {
  const { activities, calls, seen } = mockActivities({
    review: async () => {
      throw new Error('worker lost the claude binary');
    },
  });
  const result = await execute(activities);

  assert.equal(calls.filter((c) => c === 'reviewFixDiff').length, 1, 'one attempt');
  assert.match(String(seen.prs[0].review?.incomplete), /^The review activity failed: worker lost the claude binary$/);
  assert.equal(result.draft, true);
});
