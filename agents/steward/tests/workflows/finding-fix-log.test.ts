import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, type WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { bounded, createLocalEnv } from '../helpers/test-env.js';
import { createFindingsWorkers } from '../helpers/findings-workers.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { skipVerdictMeasure } from '../helpers/verdict-measure.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';
import { GOOD, acceptingReviewer, reply } from '../lib/fix-log-fixtures.js';
import { findingStateQuery, findingWorkflow, fixSignal, verdictSignal, type FindingState, type FindingWorkflowInput } from '../../src/workflows/finding.js';
import {
  awaitPrPreview,
  readFinding,
  readVerifyBlock,
  reportPreviewChecks,
  type AwaitFixPrMergeOptions,
  type FixIssue,
  type FixPrOutcome,
} from '../../src/activities/findings.js';
import { PR_HEAD_SETTLE, commitFixLogEntry, draftFixLogEntryWith, type DraftFixLogEntryActivityInput } from '../../src/activities/fix-log.js';
import { BYPASS_SECRET_ENV, runFindingChecks } from '../../src/activities/verify-finding.js';
import { BRIEF_PATH } from '../../src/lib/fix-log-backfill.js';
import { findingWorkflowId, type FindingVerdict } from '../../src/lib/findings.js';
import { branchSha, ensureBranch } from '../../src/lib/github-contents.js';
import type { FixLogSend } from '../../src/lib/llm.js';
import { VERCEL_BYPASS_HEADER } from '../../src/lib/verify-checks.js';

/**
 * The fix log entry step of `findingWorkflow` (STW-710) end to end: the real
 * preview test, the real `draftFixLogEntry` with an injected model, and the real
 * `commitFixLogEntry`, all against the fake GitHub, as `finding-retest.test.ts`
 * runs the retest. The merge wait is a mock that reads the PR branch's head
 * every 50 ms: merged, closed, a new head (when the run passed `retestAfter`), or
 * still open.
 *
 * The fake keeps a PR's head apart from its branch's head, so this file keeps
 * them together: every push, the fixer's or Steward's, is read from the branch,
 * and the PR and its preview follow it.
 *
 * A real dev server per test (`createLocalEnv`), for the reason
 * `finding-retest.test.ts` gives. No test waits on a timer.
 */

const FINDINGS = 'steward-findings';
const SITE = 'mattpyle-com';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR_NUMBER = 501;
const PR = `https://github.com/${SITE_REPO}/pull/${PR_NUMBER}`;
const BRANCH = 'claude/issue-101-x';
const PREVIEW = 'https://mattpyle-com-website-abc123-mattpyles-projects.vercel.app';
const FINDING_PATH = `sites/${SITE}/findings/${DEFECT_KEY}.md`;
const ENTRY_PATH = 'src/content/fixes/mp-950.md';
const FAILING = 'Accessibility: 100/100 (Fail)';
const PASSING = 'Accessibility: 1 axe violation (Fail)';
const ENTRY_COMMIT = 'Fix log: add the entry for MP-950';

const FACTS = ['references: []', 'key_short: MP-950', 'links:', `  pr: ${PR}`].join('\n');
const BLOCK = [
  'verify:',
  `  - url: "${ORIGIN}/scorecard/"`,
  '    kind: status',
  '    expect: 200',
  `  - url: "${ORIGIN}/scorecard/"`,
  '    kind: text',
  '    expect:',
  '      count: 0',
  '      of: "100/100 (Fail)"',
].join('\n');
/** The finding as the run sees it after `writeFindingFix`: `fixing`, with its PR and its short key. */
const WITH_BLOCK = DEFECT_FINDING.replace('status: approved', 'status: fixing').replace('references: []', `${FACTS}\n${BLOCK}`);
const NO_CHECKS = DEFECT_FINDING.replace('status: approved', 'status: fixing').replace('references: []', FACTS);

let env: TestWorkflowEnvironment;
let client: Client;
let github: FakeGitHub | undefined;
const page = { text: FAILING };
const previous = { fetch: globalThis.fetch, secret: process.env[BYPASS_SECRET_ENV] };

// The fake PR head follows the branch only through `follow`, so the commit's wait for it is one read here.
Object.assign(PR_HEAD_SETTLE, { tries: 1, intervalMs: 0 });

beforeEach(async () => {
  env = await createLocalEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  github?.restore();
  github = undefined;
  globalThis.fetch = previous.fetch;
  if (previous.secret === undefined) delete process.env[BYPASS_SECRET_ENV];
  else process.env[BYPASS_SECRET_ENV] = previous.secret;
  await env?.teardown();
});

const head = (): Promise<string> => branchSha(BRANCH, SITE_REPO);

/** A succeeded Preview deployment of `sha`, newest first as GitHub lists them. */
function deploy(gh: FakeGitHub, sha: string): void {
  if (gh.deployments.some((d) => d.sha === sha)) return;
  gh.deployments.unshift({ id: gh.deployments.length + 10, sha, environment: 'Preview', statuses: [{ state: 'success', environment_url: `${PREVIEW}/` }] });
}

/** The PR and its preview follow the branch head. */
async function follow(gh: FakeGitHub): Promise<string> {
  const sha = await head();
  gh.pulls[0].sha = sha;
  deploy(gh, sha);
  return sha;
}

let pushes = 0;
/** A fixer push: one commit on the PR branch, its preview serving `text`. */
async function pushFixer(gh: FakeGitHub, text: string): Promise<string> {
  page.text = text;
  gh.push(BRANCH, 'src/pages/scorecard.astro', `fix ${++pushes}`, `fixer push ${pushes}`);
  return follow(gh);
}

/** The fake GitHub: the brief and one entry on master, the finding on main, the PR's branch, and its preview. */
async function stage(finding = WITH_BLOCK, text = FAILING): Promise<FakeGitHub> {
  const secret = ['bypass', Math.random().toString(36).slice(2)].join('-');
  process.env[BYPASS_SECRET_ENV] = secret;
  page.text = text;
  pushes = 0;
  const gh = installFakeGitHub({
    seed: {
      [BRIEF_PATH]: '# Writing a fix log entry\n\nThe brief on master.',
      'src/content/fixes/mp-1.md': '---\nkey: MP-1\ntitle: An earlier fix\nslug: an-earlier-fix\n---\n\nStory.\n',
    },
  });
  github = gh;
  await ensureBranch('main', 'seed', SITE_REPO);
  gh.push('main', FINDING_PATH, finding, 'the finding');
  await ensureBranch(BRANCH, 'seed', SITE_REPO);
  gh.push(BRANCH, 'src/pages/scorecard.astro', 'fix 0', 'the fixer');
  gh.pulls.push({ number: PR_NUMBER, head: BRANCH, base: 'master', title: 'Fix the scorecard label', body: 'Fixes the label.', draft: false, sha: 'unset' });
  await follow(gh);
  const fakeGitHub = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== PREVIEW) return fakeGitHub(input, init);
    if (new Headers(init?.headers).get(VERCEL_BYPASS_HEADER) !== secret) return new Response('Authentication Required', { status: 401 });
    return new Response(`<html><body>${page.text}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  return gh;
}

const mergeCalls: AwaitFixPrMergeOptions[] = [];

/** The merge wait as the fake branch answers it. A new head is followed by the PR and its preview, so a retest finds it. */
async function awaitFixPrMerge(prUrl: string, options: AwaitFixPrMergeOptions = {}): Promise<FixPrOutcome> {
  mergeCalls.push(options);
  for (let i = 0; i < 400; i++) {
    const pull = github?.pulls[0];
    if (!pull || !github) break;
    if (pull.merged) return { prUrl, state: 'merged', mergeSha: 'merge-501', at: '2026-11-27T20:00:00Z' };
    if (pull.state === 'closed') return { prUrl, state: 'closed', mergeSha: null, at: '2026-11-27T20:00:00Z' };
    const now = await head();
    if (options.retestAfter && now !== options.retestAfter) {
      await follow(github);
      return { prUrl, state: 'pushed', mergeSha: null, at: null, headSha: now };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw ApplicationFailure.retryable(`${prUrl} is still open.`, 'PrStillOpen');
}

/** The writer: every turn is the good draft, unless a test gives it something else. Counts its calls. */
function writer(answer?: FixLogSend) {
  const calls: number[] = [];
  const send: FixLogSend = async (system, messages, options) => {
    calls.push(calls.length + 1);
    return answer ? answer(system, messages, options) : reply(GOOD);
  };
  return { send, calls };
}

const none = { findingCommitSha: null, indexCommitSha: null, commitSha: null };

function activities(model: { send: FixLogSend }, over: Record<string, unknown> = {}) {
  return {
    readFinding,
    readVerifyBlock,
    awaitPrPreview,
    runFindingChecks,
    reportPreviewChecks,
    readSiteAutoFix: async () => false,
    requestFixSlot: async () => ({ paths: [], dispatched: false }),
    openFixIssue: async (): Promise<FixIssue> => ({ repo: SITE_REPO, number: 101, url: `https://github.com/${SITE_REPO}/issues/101`, reused: false }),
    awaitFixPr: async () => ({ prUrl: PR, branch: BRANCH }),
    writeFindingFix: async () => none,
    writeFindingVerdict: async () => none,
    writeFindingReturned: async () => none,
    awaitFixPrMerge,
    awaitProductionDeploy: async () => ({ liveSha: 'live-1', deploymentId: 1 }),
    readFixPr: async () => ({ prUrl: PR, merged: true, mergedAt: '2026-11-27T20:00:00Z' }),
    draftFixLogEntry: (input: DraftFixLogEntryActivityInput) => draftFixLogEntryWith(input, { send: model.send, review: acceptingReviewer().send }),
    commitFixLogEntry,
    ...over,
  };
}

const input: FindingWorkflowInput = {
  site: SITE,
  key: DEFECT_KEY,
  repo: 'mattpyle/argus',
  findingPath: FINDING_PATH,
  indexPath: `sites/${SITE}/findings/INDEX.md`,
  stopAfter: 'resolved',
  handoffPath: `sites/${SITE}/handoffs/${DEFECT_KEY}.md`,
  branch: `fix/finding-${DEFECT_KEY}`,
  origin: ORIGIN,
};

const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'file', at: '2026-11-27T18:00:00Z' };

async function until(handle: WorkflowHandle, what: string, done: (s: FindingState) => boolean, limitMs = 20_000): Promise<FindingState> {
  const deadline = Date.now() + limitMs;
  let last = 'no state read';
  while (Date.now() < deadline) {
    const state = (await handle.query(findingStateQuery)) as FindingState;
    if (done(state)) return state;
    last = `step ${state.step}, ${state.previewTests} preview tests, entry ${state.fixLogEntry}`;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the run did not reach: ${what} within ${limitMs / 1000} s (${last})`);
}

/** Waits until a merge poll matching `ready` has started. */
async function mergeCall(ready: (o: AwaitFixPrMergeOptions) => boolean, limitMs = 5_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!mergeCalls.some(ready)) {
    if (Date.now() > deadline) assert.fail(`no merge poll matched within ${limitMs / 1000} s; calls: ${JSON.stringify(mergeCalls)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const merging = (n: number) => (s: FindingState) => s.step === 'waiting-merge' && s.previewTests === n;
const entryCommits = (gh: FakeGitHub) => gh.history(BRANCH).filter((m) => m === ENTRY_COMMIT).length;

async function scenario(acts: Record<string, unknown>, body: (handle: WorkflowHandle) => Promise<void>): Promise<void> {
  mergeCalls.length = 0;
  const worker = await createFindingsWorkers({ connection: env.nativeConnection, workflowBundle: await workflowBundle(), activities: skipVerdictMeasure(acts), taskQueue: FINDINGS });
  await worker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(findingWorkflow, { workflowId: findingWorkflowId(SITE, DEFECT_KEY), taskQueue: FINDINGS, args: [input] });
        await handle.signal(verdictSignal, APPROVE);
        await handle.signal(fixSignal, { source: 'cli', at: '2026-11-27T18:05:00Z' });
        try {
          await body(handle);
        } finally {
          if (github?.pulls[0]) github.pulls[0].state = 'closed';
          await handle.terminate('test over').catch(() => undefined);
        }
      })(),
    ),
  );
}

test('a first pass commits the entry, and the merge wait takes that commit as tested', async () => {
  const gh = await stage(WITH_BLOCK, PASSING);
  const tested = gh.pulls[0].sha;
  const model = writer();
  await scenario(activities(model), async (handle) => {
    const state = await until(handle, 'the merge wait after the entry', (s) => merging(1)(s) && !!s.fixLogEntry);
    const steward = await head();
    assert.notEqual(steward, tested, 'Steward committed on top of the tested commit');
    assert.equal(state.fixLogEntry, `${ENTRY_PATH} written as ${steward.slice(0, 7)}`);
    assert.match(gh.file(BRANCH, ENTRY_PATH)?.text ?? '', /^title: The about page still named a section it had removed$/m);
    assert.equal(entryCommits(gh), 1);
    assert.equal(model.calls.length, 1, 'one writer turn');
    await mergeCall((o) => o.retestAfter === steward);
    // The wait sees its own commit as tested: no second test starts.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(((await handle.query(findingStateQuery)) as FindingState).previewTests, 1);
    assert.ok(!mergeCalls.some((o) => o.retestAfter === tested), 'the measured commit is not the one the wait watches');
  });
});

test('a failed test writes no entry; the pass after a push writes it; a later push writes no second one', async () => {
  const gh = await stage(WITH_BLOCK, FAILING);
  const model = writer();
  await scenario(activities(model), async (handle) => {
    const first = await until(handle, 'the first, failed test', merging(1));
    assert.equal(first.previewResult, 'check 2 of 2 fails on the preview; PR marked draft');
    assert.equal(first.fixLogEntry ?? null, null, 'no entry step after a failed test');
    assert.equal(gh.file(BRANCH, ENTRY_PATH), undefined);
    assert.equal(model.calls.length, 0);

    await pushFixer(gh, PASSING);
    const second = await until(handle, 'the passing retest and its entry', (s) => merging(2)(s) && !!s.fixLogEntry);
    assert.match(second.fixLogEntry ?? '', /written as/);
    assert.equal(entryCommits(gh), 1);

    const pushed = await pushFixer(gh, PASSING);
    await until(handle, 'the third test', merging(3));
    await mergeCall((o) => o.retestAfter === pushed);
    assert.equal(entryCommits(gh), 1, 'no second entry');
    assert.equal(model.calls.length, 1, 'no second draft');
  });
});

test('a fixer push between the test and the commit is still tested', async () => {
  const gh = await stage(WITH_BLOCK, PASSING);
  const tested = gh.pulls[0].sha!;
  let pushedDuringDraft = '';
  // The fixer pushes while the model writes: Steward's commit lands on the fixer's, not on the tested one.
  const model = writer(async () => {
    if (!pushedDuringDraft) {
      page.text = PASSING;
      gh.push(BRANCH, 'src/pages/scorecard.astro', 'fix during the draft', 'fixer push during the draft');
      pushedDuringDraft = await head();
    }
    return reply(GOOD);
  });
  await scenario(activities(model), async (handle) => {
    await until(handle, 'the retest of the push', (s) => merging(2)(s));
    assert.ok(mergeCalls[0], 'a merge wait ran before the retest');
    assert.equal(mergeCalls[0].retestAfter, tested, 'the wait kept the measured commit, so the push was seen');
    assert.equal(entryCommits(gh), 1);
    assert.equal(model.calls.length, 1, 'the retest wrote no second entry');
  });
});

test('a finding with no checks writes its entry at once, and its merge wait is unchanged', async () => {
  const gh = await stage(NO_CHECKS, PASSING);
  const model = writer();
  await scenario(activities(model), async (handle) => {
    const state = await until(handle, 'the merge wait after the entry', (s) => s.step === 'waiting-merge' && !!s.fixLogEntry);
    assert.match(state.fixLogEntry ?? '', /written as/);
    assert.equal(entryCommits(gh), 1);
    await mergeCall(() => true);
    assert.ok(mergeCalls.every((o) => o.retestAfter === undefined), 'no retest without checks');
  });
});

const failures: Array<{ name: string; over: (gh: FakeGitHub) => Record<string, unknown>; model?: FixLogSend; line: RegExp }> = [
  {
    name: 'a missing model key',
    over: () => ({}),
    model: async () => {
      throw ApplicationFailure.nonRetryable('ANTHROPIC_API_KEY is not set. Drafting a fix log entry needs it.', 'ModelKeyMissing');
    },
    line: /not written: .*ANTHROPIC_API_KEY is not set/,
  },
  {
    name: 'a refused request',
    over: () => ({}),
    model: async () => {
      throw ApplicationFailure.nonRetryable('The model refused the request (401): invalid x-api-key', 'ModelRequestRefused', { status: 401 });
    },
    line: /not written: .*refused the request \(401\)/,
  },
  {
    name: 'an entry that still fails its checks',
    over: () => ({}),
    model: async () => ({ text: 'Not JSON.', usage: { inputTokens: 1, outputTokens: 1 } }),
    line: /not written: .*still fails after 3 attempts/,
  },
  {
    name: 'a commit GitHub refuses',
    over: () => ({
      commitFixLogEntry: async () => {
        throw ApplicationFailure.nonRetryable('GitHub answered 404 for the branch.', 'NotFound');
      },
    }),
    line: /not written: .*GitHub answered 404/,
  },
];

for (const failure of failures) {
  test(`${failure.name} ends the step, and the run goes on to the merge wait`, async () => {
    const gh = await stage(WITH_BLOCK, PASSING);
    const model = writer(failure.model);
    await scenario(activities(model, failure.over(gh)), async (handle) => {
      const state = await until(handle, 'the merge wait after the failed step', (s) => merging(1)(s) && !!s.fixLogEntry);
      assert.match(state.fixLogEntry ?? '', failure.line);
      assert.equal(gh.file(BRANCH, ENTRY_PATH), undefined, 'no entry on the branch');
      await mergeCall(() => true);
      assert.equal(state.previewResult, '2 of 2 checks pass on the preview');
    });
  });
}
