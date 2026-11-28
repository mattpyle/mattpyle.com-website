import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowUpdateFailedError, type WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { createFindingsWorkers } from '../helpers/findings-workers.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { skipVerdictMeasure } from '../helpers/verdict-measure.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { ORIGIN } from '../helpers/finding-fixtures.js';
import { GOOD, findingText } from '../lib/fix-log-fixtures.js';
import {
  findingStateQuery,
  findingWorkflow,
  fixSignal,
  requestFixUpdate,
  verdictSignal,
  type FindingState,
  type FindingWorkflowInput,
  type FindingWorkflowResult,
} from '../../src/workflows/finding.js';
import { readFinding, readFixPr, type FixIssue, type FixPrOutcome, type WriteFindingVerificationInput } from '../../src/activities/findings.js';
import { mergeFixLogConfirmation, openFixLogConfirmation, readFixLogConfirmationChecks } from '../../src/activities/fix-log-confirm.js';
import { entryData, entryFileText, entryPath, findingFacts } from '../../src/lib/fix-log-rules.js';
import { findingWorkflowId, type FindingVerdict } from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { ensureBranch } from '../../src/lib/github-contents.js';

/**
 * The fix log confirmation in `findingWorkflow` (STW-712) end to end: the real
 * `openFixLogConfirmation`, `readFixLogConfirmationChecks` and
 * `mergeFixLogConfirmation` against the fake GitHub, after a verify child whose
 * own activities are mocks. The fix PR merges at once, production serves it,
 * and the verify writes the finding `resolved` or `reopened` into the fake
 * findings branch, as the real write does, before the step reads it.
 *
 * A time-skipping server per test (`createTestEnv`): the step polls the checks
 * once a minute, and `skipResult` lets the server skip those timers. A run that
 * parks never completes, so its tests advance time with `env.sleep`.
 */

const FINDINGS = 'steward-findings';
const SITE = 'mattpyle-com';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const FINDINGS_REPO = 'mattpyle/argus';
const KEY = 'MP-950';
const SLUG = 'synthetic-mp-950';
const FINDING_PATH = `sites/${SITE}/findings/${SLUG}.md`;
const PR_NUMBER = 501;
const PR = `https://github.com/${SITE_REPO}/pull/${PR_NUMBER}`;
const PREVIEW = 'https://mattpyle-com-website-abc123-mattpyles-projects.vercel.app';
const ENTRY = entryPath(KEY);
const PASSING = [{ name: 'Private paths not tracked', status: 'completed', conclusion: 'success' }];
const CHECK = { url: `${ORIGIN}/about/`, kind: 'text', expect: { count: 0, of: 'old line' } };

let env: TestWorkflowEnvironment;
let client: Client;
let github: FakeGitHub | undefined;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  github?.restore();
  github = undefined;
  await env?.teardown();
});

/** The entry as the fix PR merged it: no `verified`, no `merged`, no checks. */
function draftEntry(): string {
  const facts = findingFacts(findingText(KEY, { status: 'fixing', verified: false, pr: PR_NUMBER }))!;
  const data = entryData(facts, { number: PR_NUMBER, title: 'fix: the about page', opened: '2026-11-27T17:00:00Z', merged: null }, {
    title: GOOD.title,
    lead: GOOD.lead,
    visual: false,
    measures: [GOOD.measure],
    story: GOOD.story,
  });
  return entryFileText(data, GOOD.story);
}

/** The finding after the verify: the write the child makes, in the form `findingFacts` reads. */
function verifiedFinding(passed: boolean): string {
  const at = '2026-11-27T21:00:00.000Z';
  const base = findingText(KEY, { status: passed ? 'resolved' : 'reopened', verified: false, pr: PR_NUMBER });
  return `${base}\n## Verification\n\nSteward ran this finding's checks against production at ${at}. Outcome: ${passed ? 'resolved' : 'reopened'}.\n\n1. ${passed ? 'Pass' : 'Fail'}, \`text\` on ${ORIGIN}/about/. Expected: 0 occurrences of "old line". Measured: ${passed ? '0 occurrences' : '1 occurrence'}.\n`;
}

async function stage(options: { entry?: boolean } = {}): Promise<FakeGitHub> {
  const gh = installFakeGitHub({ seed: options.entry === false ? {} : { [ENTRY]: draftEntry() } });
  github = gh;
  await ensureBranch('main', 'seed', FINDINGS_REPO);
  gh.push('main', FINDING_PATH, findingText(KEY, { status: 'fixing', verified: false, pr: PR_NUMBER }), 'the finding');
  gh.pulls.push({ number: PR_NUMBER, head: 'claude/issue-101-x', base: 'master', title: 'fix: the about page', body: '', draft: false, sha: 'head-sha-1' });
  gh.checkRuns.get = () => PASSING;
  return gh;
}

const none = { findingCommitSha: null, indexCommitSha: null, commitSha: null };

/** Every activity the run reaches, mocked up to the verify; the confirmation's three are real unless a test replaces one. */
function activities(gh: FakeGitHub, production: { passes: boolean }, over: Record<string, unknown> = {}) {
  return {
    readFinding,
    readFixPr,
    readSiteAutoFix: async () => false,
    requestFixSlot: async () => ({ paths: [], dispatched: false }),
    openFixIssue: async (): Promise<FixIssue> => ({ repo: SITE_REPO, number: 101, url: `https://github.com/${SITE_REPO}/issues/101`, reused: false }),
    awaitFixPr: async () => ({ prUrl: PR, branch: 'claude/issue-101-x' }),
    writeFindingFix: async () => none,
    writeFindingVerdict: async () => none,
    writeFindingReturned: async () => none,
    commentOnFixPr: async () => ({ posted: true }),
    awaitPrPreview: async () => ({ origin: PREVIEW, deploymentId: 7, sha: 'head-sha-1' }),
    reportPreviewChecks: async () => ({ posted: true, failed: [], draft: false }),
    readVerifyBlock: async () => ({ handoff: null, hasBlock: true, checks: [CHECK], source: 'finding' as const }),
    runFindingChecks: async (input: { previewOrigin?: string; checks: unknown[] }) => {
      const pass = input.previewOrigin ? true : production.passes;
      return {
        ranAt: '2026-11-27T21:00:00.000Z',
        passed: pass,
        results: input.checks.map((c: any, i) => ({ n: i + 1, url: c.url, kind: c.kind, pass, expected: '0 occurrences of "old line"', measured: pass ? '0 occurrences' : '1 occurrence' })),
      };
    },
    awaitFixPrMerge: async (prUrl: string): Promise<FixPrOutcome> => {
      Object.assign(gh.pulls[0], { merged: true, state: 'closed', mergeSha: 'm501' });
      return { prUrl, state: 'merged', mergeSha: 'm501', at: '2026-11-27T20:00:00Z' };
    },
    awaitProductionDeploy: async () => ({ liveSha: 'm501', deploymentId: 1 }),
    writeFindingVerification: async (input: WriteFindingVerificationInput) => {
      gh.push('main', FINDING_PATH, verifiedFinding(input.verification.status === 'resolved'), 'the verification');
      return { findingCommitSha: 'c-w1', indexCommitSha: 'c-w2', commitSha: 'c-w2' };
    },
    openFixLogConfirmation,
    readFixLogConfirmationChecks,
    mergeFixLogConfirmation,
    ...over,
  };
}

const input: FindingWorkflowInput = {
  site: SITE,
  key: SLUG,
  repo: FINDINGS_REPO,
  findingPath: FINDING_PATH,
  indexPath: `sites/${SITE}/findings/INDEX.md`,
  stopAfter: 'resolved',
  handoffPath: `sites/${SITE}/handoffs/${SLUG}.md`,
  branch: `fix/finding-${SLUG}`,
  origin: ORIGIN,
};

const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'file', at: '2026-11-27T18:00:00Z' };

async function run<T>(acts: Record<string, unknown>, body: (handle: WorkflowHandle<typeof findingWorkflow>) => Promise<T>): Promise<T> {
  const worker = await createFindingsWorkers({ connection: env.nativeConnection, workflowBundle: await workflowBundle(), activities: skipVerdictMeasure(acts), taskQueue: FINDINGS });
  return worker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(findingWorkflow, { workflowId: findingWorkflowId(SITE, SLUG), taskQueue: FINDINGS, args: [input] });
        await handle.signal(verdictSignal, APPROVE);
        await handle.signal(fixSignal, { source: 'cli', at: '2026-11-27T18:05:00Z' });
        try {
          return await body(handle);
        } finally {
          await handle.terminate('test over').catch(() => undefined);
        }
      })(),
    ),
  );
}

/** The run's result, with the server free to skip the step's poll timers. */
function skipResult(handle: { workflowId: string }): Promise<FindingWorkflowResult> {
  return env.client.workflow.getHandle<typeof findingWorkflow>(handle.workflowId).result() as Promise<FindingWorkflowResult>;
}

const state = async (handle: WorkflowHandle<typeof findingWorkflow>) => (await handle.query(findingStateQuery)) as FindingState;
const masterEntry = (gh: FakeGitHub) => parseFrontmatter(gh.file('master', ENTRY)?.text ?? '').data as Record<string, any>;

/** Waits for `done`, moving server time on a minute at a time, for a run that parks and never completes. */
async function until(handle: WorkflowHandle<typeof findingWorkflow>, what: string, done: (s: FindingState) => boolean): Promise<FindingState> {
  for (let i = 0; i < 200; i++) {
    const s = await state(handle);
    if (done(s)) return s;
    if (s.step === 'confirming-fix-log') await env.sleep('1 minute');
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the run did not reach: ${what}`);
}

test('a fix production confirms: the entry is completed on master in a PR Steward merges, and the run ends resolved', async () => {
  const gh = await stage();
  const result = await run(activities(gh, { passes: true }), async (handle) => {
    const result = await skipResult(handle);
    const s = await state(handle);
    assert.match(s.fixLogConfirm ?? '', /^src\/content\/fixes\/mp-950\.md confirmed in https:\/\/github\.com\/.+\/pull\/2, merged as merge-2$/);
    return result;
  });
  assert.equal(result.outcome, 'resolved');
  const entry = masterEntry(gh);
  assert.equal(entry.status, 'fixed');
  assert.equal(entry.verified, '2026-11-27T21:00:00.000Z');
  assert.equal(entry.changes[0].merged, '2026-11-27T20:00:00Z');
  assert.equal(entry.title, GOOD.title);
  assert.equal(gh.merges.length, 1);
});

test('a reopened fix: the entry reads reopened on master, and the run parks as before', async () => {
  const gh = await stage();
  await run(activities(gh, { passes: false }), async (handle) => {
    const s = await until(handle, 'the park after the confirmation', (st) => st.step === 'parked' && !!st.fixLogConfirm);
    assert.match(s.fixLogConfirm ?? '', /merged as merge-2$/);
    assert.equal(s.parked?.stage, 'verify');
  });
  const entry = masterEntry(gh);
  assert.equal(entry.status, 'reopened');
  assert.equal(entry.checks[0].passed, false);
});

test('an entry that is not on master: the step does nothing, and the run ends resolved', async () => {
  const gh = await stage({ entry: false });
  await run(activities(gh, { passes: true }), async (handle) => {
    const result = await skipResult(handle);
    assert.equal(result.outcome, 'resolved');
    assert.equal((await state(handle)).fixLogConfirm, 'skipped: src/content/fixes/mp-950.md is not on master');
  });
  assert.equal(gh.pulls.length, 1, 'no confirmation PR');
});

test('a confirmation whose diff holds more than the confirmed fields is left open, and the run ends resolved', async () => {
  const gh = await stage();
  const open = async (i: Parameters<typeof openFixLogConfirmation>[0]) => {
    const opened = await openFixLogConfirmation(i);
    if (opened.state === 'opened') gh.push(opened.branch, 'src/pages/about.astro', 'another change', 'a second file');
    return opened;
  };
  await run(activities(gh, { passes: true }, { openFixLogConfirmation: open }), async (handle) => {
    const result = await skipResult(handle);
    assert.equal(result.outcome, 'resolved');
    assert.match((await state(handle)).fixLogConfirm ?? '', /^left open: https:\/\/github\.com\/.+\/pull\/2: (extra-files|head-moved): /);
  });
  assert.equal(gh.merges.length, 0);
  assert.equal(masterEntry(gh).verified, undefined, 'master is as it was');
});

for (const [name, over] of [
  ['the open', { openFixLogConfirmation: async () => { throw ApplicationFailure.nonRetryable('GitHub refused (403).', 'AuthError'); } }],
  ['the checks read', { readFixLogConfirmationChecks: async () => { throw ApplicationFailure.nonRetryable('GitHub refused (403).', 'AuthError'); } }],
  ['the merge', { mergeFixLogConfirmation: async () => { throw ApplicationFailure.nonRetryable('GitHub refused (403).', 'AuthError'); } }],
] as const) {
  test(`a failure in ${name} is one line in the state, and the run still ends resolved`, async () => {
    const gh = await stage();
    await run(activities(gh, { passes: true }, over), async (handle) => {
      const result = await skipResult(handle);
      assert.equal(result.outcome, 'resolved');
      assert.match((await state(handle)).fixLogConfirm ?? '', /^failed: .*403/);
    });
  });
}

test('a request-fix Update at confirming-fix-log gets its own refusal', async () => {
  const gh = await stage();
  let reads = 0;
  // Pending at first, so the run sits in the step's poll sleep while the Update arrives.
  const checks = async (i: Parameters<typeof readFixLogConfirmationChecks>[0]) => (++reads < 2 ? { state: 'pending' as const, failing: [], pending: ['CI'], requiredPassed: false } : readFixLogConfirmationChecks(i));
  await run(activities(gh, { passes: true }, { readFixLogConfirmationChecks: checks }), async (handle) => {
    for (let i = 0; i < 200 && (await state(handle)).step !== 'confirming-fix-log'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await state(handle)).step, 'confirming-fix-log');
    await assert.rejects(
      handle.executeUpdate(requestFixUpdate, { args: [{ source: 'cli', at: '2026-11-27T21:01:00Z' }] }),
      (err: unknown) => err instanceof WorkflowUpdateFailedError && /is verified, and the run is completing its fix log entry/.test(String((err.cause as Error)?.message)),
    );
    const result = await skipResult(handle);
    assert.equal(result.outcome, 'resolved');
  });
});
