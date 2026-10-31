import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';
import {
  findingStateQuery,
  findingWorkflow,
  fixSignal,
  verdictSignal,
  type FindingState,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import {
  awaitPrPreview,
  readFinding,
  readVerifyBlock,
  reportPreviewChecks,
  type FixIssue,
  type FixPrOutcome,
} from '../../src/activities/findings.js';
import { BYPASS_SECRET_ENV, runFindingChecks } from '../../src/activities/verify-finding.js';
import { PREVIEW_CHECKS_MARKER, type FindingVerdict } from '../../src/lib/findings.js';
import { VERCEL_BYPASS_HEADER } from '../../src/lib/verify-checks.js';

/**
 * The preview test end to end (fix-pr-runs-the-verify-block): the real
 * `findingWorkflow` with the real `readFinding`, `readVerifyBlock`,
 * `awaitPrPreview`, `runFindingChecks` and `reportPreviewChecks`, against the
 * fake GitHub (the finding file, the PR, its preview deployment, its comments
 * and its draft flag) and a fake preview origin that answers only a request
 * that carries the bypass secret. The fix issue, the PR wait and the merge wait
 * are mocked: the PR closes at the first merge poll, which parks the run at
 * `waiting-fix` with the preview result in its state.
 *
 * A server per test, for the reason `finding-lifecycle.test.ts` gives. No test
 * here has a timer, so none needs time skipping.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const FINDINGS = 'steward-findings';
const SITE = 'mattpyle-com';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR_NUMBER = 501;
const PR = `https://github.com/${SITE_REPO}/pull/${PR_NUMBER}`;
const PREVIEW = 'https://mattpyle-com-website-abc123-mattpyles-projects.vercel.app';
const FINDING_PATH = `sites/${SITE}/findings/${DEFECT_KEY}.md`;

/** Two checks: the page answers 200, and the label the finding wants gone is gone. */
const WITH_BLOCK = DEFECT_FINDING.replace(
  'references: []',
  [
    'references: []',
    'verify:',
    `  - url: "${ORIGIN}/scorecard/"`,
    '    kind: status',
    '    expect: 200',
    `  - url: "${ORIGIN}/scorecard/"`,
    '    kind: text',
    '    expect:',
    '      count: 0',
    '      of: "100/100 (Fail)"',
  ].join('\n'),
);

let env: TestWorkflowEnvironment;
let client: Client;
let github: FakeGitHub | undefined;
let secret: string;
const previous = { fetch: globalThis.fetch, secret: process.env[BYPASS_SECRET_ENV] };

beforeEach(async () => {
  env = await createTestEnv();
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

interface Scene {
  /** The finding file the findings repository holds. */
  finding: string;
  /** What the preview's `/scorecard/` says. */
  page: string;
  /** Whether a succeeded Preview deployment of the PR head exists. */
  deployed?: boolean;
}

/** The fake GitHub, the fake preview origin and the PR with its deployment. */
function stage(scene: Scene): FakeGitHub {
  // A secret built at run time: the gitleaks job scans literals.
  secret = ['bypass', Math.random().toString(36).slice(2)].join('-');
  process.env[BYPASS_SECRET_ENV] = secret;
  const gh = installFakeGitHub({ defaultBranch: 'main', seed: { [FINDING_PATH]: scene.finding } });
  gh.pulls.push({
    number: PR_NUMBER,
    head: 'claude/issue-101-x',
    base: 'master',
    title: 'Fix the label',
    body: '',
    draft: false,
    sha: 'head-501',
  });
  if (scene.deployed !== false) {
    gh.deployments.push({
      id: 7,
      sha: 'head-501',
      environment: 'Preview',
      statuses: [{ state: 'success', environment_url: `${PREVIEW}/` }],
    });
  }
  // The preview answers a request with the bypass secret and refuses the rest,
  // as Vercel Authentication does. Everything else goes to the fake GitHub.
  const fakeGitHub = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== PREVIEW) return fakeGitHub(input, init);
    const sent = new Headers(init?.headers).get(VERCEL_BYPASS_HEADER);
    if (sent !== secret) return new Response('Authentication Required', { status: 401 });
    return new Response(`<html><body>${scene.page}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  github = gh;
  return gh;
}

const none = { findingCommitSha: null, indexCommitSha: null, commitSha: null };

const activities = {
  // The real ones.
  readFinding,
  readVerifyBlock,
  awaitPrPreview,
  runFindingChecks,
  reportPreviewChecks,
  // The mocked rest: an issue, its PR, and a PR that closes unmerged.
  readSiteAutoFix: async () => false,
  requestFixSlot: async () => ({ paths: [], dispatched: false }),
  openFixIssue: async (): Promise<FixIssue> => ({
    repo: SITE_REPO,
    number: 101,
    url: `https://github.com/${SITE_REPO}/issues/101`,
    reused: false,
  }),
  awaitFixPr: async () => ({ prUrl: PR, branch: 'claude/issue-101-x' }),
  writeFindingFix: async () => none,
  writeFindingVerdict: async () => none,
  writeFindingReturned: async () => none,
  awaitFixPrMerge: async (prUrl: string): Promise<FixPrOutcome> => ({ prUrl, state: 'closed', mergeSha: null, at: null }),
};

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

const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'file', at: '2026-10-31T18:00:00Z' };

async function untilParked(handle: WorkflowHandle): Promise<FindingState> {
  for (let i = 0; i < 400; i++) {
    const state: FindingState = await handle.query(findingStateQuery);
    if (state.step === 'waiting-fix' && state.fixAttempts === 1) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the run did not park at waiting-fix');
}

/** Runs one attempt to the point where its PR has closed and the preview test has finished. */
async function runAttempt(id: string): Promise<FindingState> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities,
    taskQueue: FINDINGS,
    bundlerOptions: {},
  });
  return await worker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(findingWorkflow, {
          workflowId: `finding/${SITE}/preview-${id}`,
          taskQueue: FINDINGS,
          args: [input],
        });
        await handle.signal(verdictSignal, APPROVE);
        await handle.signal(fixSignal, { source: 'cli', at: '2026-10-31T18:05:00Z' });
        const state = await untilParked(handle);
        await handle.terminate('test over');
        return state;
      })(),
    ),
  );
}

test('one check fails on the preview: the comment carries both measured values and the PR becomes a draft', async () => {
  const gh = stage({ finding: WITH_BLOCK, page: 'Accessibility: 100/100 (Fail)' });
  const state = await runAttempt('fails');

  assert.equal(state.previewResult, 'check 2 of 2 fails on the preview; PR marked draft');
  const pull = gh.pulls[0];
  assert.equal(pull.comments?.length, 1, 'one comment');
  const comment = pull.comments?.[0] ?? '';
  assert.ok(comment.includes(PREVIEW_CHECKS_MARKER), 'the hidden marker');
  assert.match(comment, /commit `head-50`/);
  assert.match(comment, /\*\*Check 2 fails on the preview\.\*\* Steward marks this PR a draft\./);
  // The rows name the preview URL the checks ran on.
  assert.match(comment, /1\. `status` https:\/\/mattpyle-com-website-abc123-mattpyles-projects\.vercel\.app\/scorecard\/\n {3}- Expects: .*\n {3}- Measured: .*\n {3}- Pass\./);
  assert.match(comment, /2\. `text` https:\/\/mattpyle-com-website-abc123-mattpyles-projects\.vercel\.app\/scorecard\/\n {3}- Expects: .*100\/100 \(Fail\).*\n {3}- Measured: .*\n {3}- Fail\./);
  assert.equal(pull.draft, true, 'the PR is a draft');
  assert.ok(!comment.includes(secret), 'the bypass secret is nowhere in the comment');
});

test('every check passes on the preview: the comment carries the values and the PR stays ready', async () => {
  const gh = stage({ finding: WITH_BLOCK, page: 'Accessibility: 1 axe violation (Fail)' });
  const state = await runAttempt('passes');

  assert.equal(state.previewResult, '2 of 2 checks pass on the preview');
  const pull = gh.pulls[0];
  assert.equal(pull.comments?.length, 1);
  assert.match(pull.comments?.[0] ?? '', /\*\*All 2 checks pass on the preview\.\*\*/);
  assert.match(pull.comments?.[0] ?? '', /Measured: /);
  assert.equal(pull.draft, false, 'the PR stays ready');
  assert.ok(!gh.calls.includes('POST /graphql'), 'no draft conversion was sent');
});

test('a finding with no checks skips the step: no preview lookup, no comment, no draft', async () => {
  const gh = stage({ finding: DEFECT_FINDING, page: '' });
  const state = await runAttempt('no-checks');

  assert.equal(state.previewResult, 'skipped: the finding has no checks');
  assert.equal(gh.pulls[0].comments?.length ?? 0, 0);
  assert.equal(gh.pulls[0].draft, false);
  assert.ok(!gh.calls.some((c) => c.includes('/deployments')), 'no deployment was looked up');
});

test('a preview deployment that failed is unmeasured: the comment says why and the PR stays ready', async () => {
  const gh = stage({ finding: WITH_BLOCK, page: '', deployed: false });
  gh.deployments.push({ id: 8, sha: 'head-501', environment: 'Preview', statuses: [{ state: 'failure' }] });
  const state = await runAttempt('build-failed');

  assert.match(state.previewResult ?? '', /^unmeasured: The Preview deployment of head-50 ended failure\./);
  const pull = gh.pulls[0];
  assert.match(pull.comments?.[0] ?? '', /\*\*The preview was not measured\.\*\* The Preview deployment of head-50 ended failure\./);
  assert.equal(pull.draft, false);
});
