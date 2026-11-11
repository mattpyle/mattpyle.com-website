import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, type WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import proto from '@temporalio/proto';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
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
  type AwaitFixPrMergeOptions,
  type FixIssue,
  type FixPrOutcome,
} from '../../src/activities/findings.js';
import { BYPASS_SECRET_ENV, runFindingChecks } from '../../src/activities/verify-finding.js';
import { RetestRefused, requestRetest } from '../../src/lib/finding-retest.js';
import { PREVIEW_CHECKS_MARKER, findingWorkflowId, type FindingVerdict } from '../../src/lib/findings.js';
import { VERCEL_BYPASS_HEADER } from '../../src/lib/verify-checks.js';
import { FAKE_APP_SLUG } from '../helpers/fake-github-app.js';

/**
 * The retest end to end (STW-587): the real `findingWorkflow` with the real
 * preview test activities against the fake GitHub, as in
 * `finding-preview-test.test.ts`. The merge wait is a mock that reads the fake
 * PR every 50 ms: merged, closed, a new head (when the run passed
 * `retestAfter`), or still open. It never heartbeats, like the real one, so a
 * cancelled poll keeps reading until the PR closes and its result is dropped.
 *
 * A server per test, for the reason `finding-lifecycle.test.ts` gives. No test
 * waits on a timer, so none needs time skipping; results are read with a plain
 * `Client` and the `state` query.
 */

const FINDINGS = 'steward-findings';
const SITE = 'mattpyle-com';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR_NUMBER = 501;
const PR = `https://github.com/${SITE_REPO}/pull/${PR_NUMBER}`;
const PREVIEW = 'https://mattpyle-com-website-abc123-mattpyles-projects.vercel.app';
const FINDING_PATH = `sites/${SITE}/findings/${DEFECT_KEY}.md`;
const FIRST = 'aaaaaaa1111';
const SECOND = 'bbbbbbb2222';
const FAILING = 'Accessibility: 100/100 (Fail)';
const PASSING = 'Accessibility: 1 axe violation (Fail)';

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
const page = { text: FAILING };
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

/** The fake GitHub with the PR at {@link FIRST} and its preview, and a preview origin that serves {@link page}. */
function stage(finding = WITH_BLOCK): FakeGitHub {
  const secret = ['bypass', Math.random().toString(36).slice(2)].join('-');
  process.env[BYPASS_SECRET_ENV] = secret;
  page.text = FAILING;
  const gh = installFakeGitHub({ defaultBranch: 'main', seed: { [FINDING_PATH]: finding } });
  gh.pulls.push({ number: PR_NUMBER, head: 'claude/issue-101-x', base: 'master', title: 'Fix', body: '', draft: false, sha: FIRST });
  deploy(gh, FIRST, 7);
  const fakeGitHub = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== PREVIEW) return fakeGitHub(input, init);
    if (new Headers(init?.headers).get(VERCEL_BYPASS_HEADER) !== secret) return new Response('Authentication Required', { status: 401 });
    return new Response(`<html><body>${page.text}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  github = gh;
  return gh;
}

/** A succeeded Preview deployment of `sha`, newest first as GitHub lists them. */
function deploy(gh: FakeGitHub, sha: string, id: number): void {
  gh.deployments.unshift({ id, sha, environment: 'Preview', statuses: [{ state: 'success', environment_url: `${PREVIEW}/` }] });
}

/** A new commit on the PR, with its preview, serving `text`. */
function push(gh: FakeGitHub, sha: string, text: string): void {
  page.text = text;
  deploy(gh, sha, gh.deployments.length + 10);
  gh.pulls[0].sha = sha;
}

const none = { findingCommitSha: null, indexCommitSha: null, commitSha: null };
const mergeCalls: AwaitFixPrMergeOptions[] = [];

/** The merge wait as the fake PR answers it, polled every 50 ms for up to 20 seconds. */
async function awaitFixPrMerge(prUrl: string, options: AwaitFixPrMergeOptions = {}): Promise<FixPrOutcome> {
  mergeCalls.push(options);
  for (let i = 0; i < 400; i++) {
    const pull = github?.pulls[0];
    if (!pull) break;
    if (pull.merged) return { prUrl, state: 'merged', mergeSha: pull.mergeSha ?? 'merge-501', at: '2026-11-10T20:00:00Z' };
    if (pull.state === 'closed') return { prUrl, state: 'closed', mergeSha: null, at: '2026-11-10T20:00:00Z' };
    const head = pull.sha ?? '';
    if (options.retestAfter && head && head !== options.retestAfter) {
      return { prUrl, state: 'pushed', mergeSha: null, at: null, headSha: head };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw ApplicationFailure.retryable(`${prUrl} is still open.`, 'PrStillOpen');
}

const activities = {
  readFinding,
  readVerifyBlock,
  awaitPrPreview,
  runFindingChecks,
  reportPreviewChecks,
  readSiteAutoFix: async () => false,
  requestFixSlot: async () => ({ paths: [], dispatched: false }),
  openFixIssue: async (): Promise<FixIssue> => ({ repo: SITE_REPO, number: 101, url: `https://github.com/${SITE_REPO}/issues/101`, reused: false }),
  awaitFixPr: async () => ({ prUrl: PR, branch: 'claude/issue-101-x' }),
  writeFindingFix: async () => none,
  writeFindingVerdict: async () => none,
  writeFindingReturned: async () => none,
  awaitFixPrMerge,
  awaitProductionDeploy: async () => ({ liveSha: 'live-1', deploymentId: 1 }),
  readFixPr: async () => ({ prUrl: PR, merged: true, mergedAt: '2026-11-10T20:00:00Z' }),
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

const APPROVE: FindingVerdict = { status: 'approved', reason: 'Real.', source: 'file', at: '2026-11-10T18:00:00Z' };
const WORKFLOW_ID = findingWorkflowId(SITE, DEFECT_KEY);

async function until(handle: WorkflowHandle, what: string, done: (s: FindingState) => boolean): Promise<FindingState> {
  for (let i = 0; i < 400; i++) {
    const state: FindingState = await handle.query(findingStateQuery);
    if (done(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the run did not reach: ${what}`);
}

const merging = (n: number) => (s: FindingState) => s.step === 'waiting-merge' && s.previewTests === n;

/** Runs `body` against a started, approved and fixed run, then terminates it. */
async function scenario(body: (handle: WorkflowHandle) => Promise<void>, start = true): Promise<void> {
  mergeCalls.length = 0;
  const worker = await Worker.create({ connection: env.nativeConnection, workflowBundle: await workflowBundle(), activities, taskQueue: FINDINGS });
  await worker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(findingWorkflow, { workflowId: WORKFLOW_ID, taskQueue: FINDINGS, args: [input] });
        await handle.signal(verdictSignal, APPROVE);
        if (start) await handle.signal(fixSignal, { source: 'cli', at: '2026-11-10T18:05:00Z' });
        try {
          await body(handle);
        } finally {
          // Close the PR so a cancelled poll still reading it returns, then end the run.
          if (github?.pulls[0]) github.pulls[0].state = 'closed';
          await handle.terminate('test over').catch(() => undefined);
        }
      })(),
    ),
  );
}

test('a new head commit after a failed test is tested again, and a pass clears the draft Steward set', async () => {
  const gh = stage();
  await scenario(async (handle) => {
    const first = await until(handle, 'the first test', merging(1));
    assert.equal(first.previewResult, 'check 2 of 2 fails on the preview; PR marked draft');
    assert.equal(first.previewSha, FIRST);
    assert.equal(gh.pulls[0].draft, true, 'the failure made the PR a draft');
    assert.deepEqual(mergeCalls.at(-1), { reportConflict: true, retestAfter: FIRST }, 'the merge wait names the commit it tested');

    push(gh, SECOND, PASSING);
    const second = await until(handle, 'the second test', merging(2));
    assert.equal(second.previewResult, '2 of 2 checks pass on the preview');
    assert.equal(second.previewSha, SECOND);
    assert.equal(gh.pulls[0].draft, false, 'Steward cleared its own draft');
    assert.deepEqual(
      gh.pulls[0].timeline?.map((e) => `${e.event}/${e.actor?.login}`),
      [`convert_to_draft/${FAKE_APP_SLUG}[bot]`, `ready_for_review/${FAKE_APP_SLUG}[bot]`],
    );
    const comments = gh.pulls[0].comments ?? [];
    assert.equal(comments.length, 1, 'one comment, rewritten in place');
    assert.ok(comments[0].includes(PREVIEW_CHECKS_MARKER));
    assert.match(comments[0], /for commit `bbbbbbb`/);
    assert.match(comments[0], /has marked it ready for review again/);
    assert.match(comments[0], /Earlier tests of this PR, oldest first:\n\n- `aaaaaaa`: check 2 of 2 fails on the preview; PR marked draft/);
    assert.deepEqual(mergeCalls.at(-1), { reportConflict: true, retestAfter: SECOND });
  });
});

test('steward finding retest tests the same head again, and the failure comment names the three routes', async () => {
  const gh = stage();
  await scenario(async (handle) => {
    await until(handle, 'the first test', merging(1));
    const failure = gh.pulls[0].comments?.[0] ?? '';
    assert.match(failure, /Steward made this PR a draft, so that it does not merge by accident\./);
    assert.match(failure, /1\. The fix is wrong: comment `@claude` on this PR/);
    assert.match(failure, new RegExp(`2\\. The check or Steward is wrong: correct it, then run \`steward finding retest ${DEFECT_KEY}\``));
    assert.match(failure, /3\. Judge it yourself: mark this PR ready and merge it\./);

    // The check was wrong, and was corrected: the same commit now passes.
    page.text = PASSING;
    const accepted = await requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z');
    assert.deepEqual(accepted, { prUrl: PR, testedSha: FIRST, test: 2, workflowId: WORKFLOW_ID });

    const second = await until(handle, 'the retest', merging(2));
    assert.equal(second.previewResult, '2 of 2 checks pass on the preview');
    assert.equal(second.previewSha, FIRST, 'the same head');
    assert.equal(second.retestRequested, false);
    assert.equal(gh.pulls[0].draft, false);
    assert.match(gh.pulls[0].comments?.[0] ?? '', /- `aaaaaaa`: check 2 of 2 fails/);
  });
});

test('a retest is refused, read-only, with no run and with no open fix PR', async () => {
  stage();
  await assert.rejects(requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z'), (err: unknown) => {
    assert.ok(err instanceof RetestRefused);
    assert.match((err as Error).message, /^No run finding\/mattpyle-com\/.* has no open fix PR to test\.$/);
    return true;
  });
  await scenario(async (handle) => {
    await until(handle, 'the fix wait', (s) => s.step === 'waiting-fix');
    await assert.rejects(requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z'), (err: unknown) => {
      assert.ok(err instanceof RetestRefused);
      assert.match((err as Error).message, /The finding has no open fix PR: the run is at waiting-fix\./);
      return true;
    });
    const history = await handle.fetchHistory();
    assert.ok(
      !history.events?.some((e) => e.workflowExecutionUpdateAcceptedEventAttributes),
      'a refused Update leaves no trace in the history',
    );
  }, false);
});

test('a finding with no checks refuses a retest', async () => {
  stage(DEFECT_FINDING);
  await scenario(async (handle) => {
    await until(handle, 'the merge wait', (s) => s.step === 'waiting-merge');
    await assert.rejects(requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z'), /no checks, so there is nothing to test/);
    assert.deepEqual(mergeCalls, [{ reportConflict: true }], 'the merge wait as before the retest: no retestAfter');
  });
});

test('a pass leaves a draft a person set, and the comment names who set it', async () => {
  const gh = stage();
  await scenario(async (handle) => {
    await until(handle, 'the first test', merging(1));
    // Matt marks it ready, then makes it a draft again for his own reason.
    gh.pulls[0].timeline?.push({ event: 'ready_for_review', actor: { login: 'mattpyle' } });
    gh.pulls[0].timeline?.push({ event: 'convert_to_draft', actor: { login: 'mattpyle' } });
    push(gh, SECOND, PASSING);
    const second = await until(handle, 'the second test', merging(2));
    assert.equal(second.previewResult, '2 of 2 checks pass on the preview');
    assert.equal(gh.pulls[0].draft, true, "a person's draft stays");
    assert.match(gh.pulls[0].comments?.[0] ?? '', /This PR is still a draft: mattpyle made it one, not Steward, so Steward leaves it\./);
  });
});

test('a PR merged over a failed last test hands that result to the verify child', async () => {
  const gh = stage();
  await scenario(async (handle) => {
    await until(handle, 'the first test', merging(1));
    gh.pulls[0].merged = true;
    gh.pulls[0].mergeSha = 'merge-501';
    await until(handle, 'the end', (s) => s.step === 'done');
    const history = await handle.fetchHistory();
    const start = history.events?.find((e) => e.startChildWorkflowExecutionInitiatedEventAttributes)
      ?.startChildWorkflowExecutionInitiatedEventAttributes;
    const args = defaultPayloadConverter.fromPayload<{ previewAtMerge?: string }>(start?.input?.payloads?.[0] as any);
    assert.equal(args.previewAtMerge, 'check 2 of 2 fails on the preview; PR marked draft, at aaaaaaa');
  });
});

test('a merge and a retest in the same workflow task: the merge wins', async () => {
  const gh = stage();
  mergeCalls.length = 0;
  // A worker for the activities alone, so the workflow worker can stop while
  // the merge poll and the Update both land, and its successor reads them in
  // one workflow task.
  const activityWorker = await Worker.create({ connection: env.nativeConnection, activities, taskQueue: FINDINGS });
  const bundle = await workflowBundle();
  // No cache, so no sticky queue: the successor gets the task from the normal queue at once.
  const workflowWorker = () =>
    Worker.create({ connection: env.nativeConnection, workflowBundle: bundle, taskQueue: FINDINGS, maxCachedWorkflows: 0 });
  await activityWorker.runUntil(
    bounded(
      (async () => {
        const handle = await client.workflow.start(findingWorkflow, { workflowId: WORKFLOW_ID, taskQueue: FINDINGS, args: [input] });
        try {
          const first = await workflowWorker();
          await first.runUntil(
            (async () => {
              await handle.signal(verdictSignal, APPROVE);
              await handle.signal(fixSignal, { source: 'cli', at: '2026-11-10T18:05:00Z' });
              await until(handle, 'the first test', merging(1));
            })(),
          );
          // No workflow worker now. The Update waits for one; the merge lands meanwhile.
          const update = requestRetest(client, SITE, DEFECT_KEY, '2026-11-10T19:00:00Z');
          update.catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 500));
          gh.pulls[0].merged = true;
          gh.pulls[0].mergeSha = 'merge-501';
          await new Promise((resolve) => setTimeout(resolve, 500));
          const second = await workflowWorker();
          await second.runUntil(
            (async () => {
              const end = await until(handle, 'the end', (s) => s.step === 'done');
              assert.equal(end.previewTests, 1, 'no second test ran');
              const history = await handle.fetchHistory();
              const types = (history.events ?? [])
                .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
                .filter(Boolean);
              assert.equal(types.filter((t) => t === 'runFindingChecks').length, 1, 'the checks ran once');
              assert.ok(types.includes('awaitProductionDeploy'), 'the run went on to the deploy');
              // The merge's completion and the Update are in one workflow task:
              // the task right after the poll completed accepts the Update.
              const events = history.events ?? [];
              const T = proto.temporal.api.enums.v1.EventType;
              const mergeDone = events.findIndex(
                (e, i) => e.eventType === T.EVENT_TYPE_ACTIVITY_TASK_COMPLETED && i > events.findLastIndex((x) => x.activityTaskScheduledEventAttributes?.activityType?.name === 'awaitFixPrMerge'),
              );
              assert.deepEqual(
                events.slice(mergeDone + 1, mergeDone + 4).map((e) => e.eventType),
                [T.EVENT_TYPE_WORKFLOW_TASK_STARTED, T.EVENT_TYPE_WORKFLOW_TASK_COMPLETED, T.EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED],
                'one task holds the merge result and the Update',
              );
              // Accepted before the merge settled the race, so it returns a test number no test takes.
              assert.equal((await update).test, 2);
            })(),
          );
        } finally {
          gh.pulls[0].state = 'closed';
          await handle.terminate('test over').catch(() => undefined);
        }
      })(),
    ),
  );
});
