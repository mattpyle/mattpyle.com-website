import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { createTestEnv } from '../helpers/test-env.js';
import { DEFECT_FINDING } from '../helpers/finding-fixtures.js';
import { FixRefused, followFix, requestFix, type FindingFixDeps } from '../../src/lib/finding-fix.js';
import { findingPath, findingWorkflowId } from '../../src/lib/findings.js';
import {
  findingStateQuery,
  type FindingState,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import type { FixIssue, FixPrOutcome, OpenFixIssueInput, WriteFindingReturnedInput } from '../../src/activities/findings.js';

/**
 * `steward finding fix`, the one fix path, against the time-skipping server:
 * the real `findingWorkflow` on `steward-findings` with mocked activities,
 * whose fix issue gets its PR at the first poll. The finding file and GitHub
 * are in-memory maps behind `requestFix`'s deps.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const FINDINGS = 'steward-findings';
const SITE = 'mattpyle-com';
const REPO = 'mattpyle/argus';
const ORIGIN = 'https://www.mattpyle.com';
const CLOSED_PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/338';
const ACTION_PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/501';

let env: TestWorkflowEnvironment;
// A plain client: the time-skipping one lets the server skip time while it
// awaits a result, which times out a parent idling at `waiting-fix`.
let client: Client;

before(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

function approvedFile(): Record<string, unknown> {
  return {
    status: 'approved',
    kind: 'defect',
    verdict_reason: 'Approved by Matt via steward finding approve.',
    verdict_at: '2026-10-11T06:26:32.301Z',
    verdict_source: 'cli',
  };
}

function fixingFile(prUrl: string): Record<string, unknown> {
  return { ...approvedFile(), status: 'fixing', links: { pr: prUrl } };
}

/**
 * `file` is the frontmatter the deps hand back; `text` is the body the gate
 * parses, by default the fixtures' defect with a cause and a measure.
 */
function harness(
  key: string,
  file: Record<string, unknown>,
  prs: Record<string, 'open' | 'merged' | 'closed'> = {},
  text: string = DEFECT_FINDING,
) {
  const files: Record<string, Record<string, unknown>> = { [findingPath(SITE, key)]: file };
  const said: string[] = [];
  const returned: { prUrl: string }[] = [];
  const activityCalls: string[] = [];

  const deps: FindingFixDeps = {
    client,
    repo: REPO,
    taskQueue: FINDINGS,
    origin: ORIGIN,
    readFinding: async (p) => {
      const data = files[p];
      if (!data) throw new Error(`${p} is not in ${REPO}`);
      return { data, text };
    },
    readPr: async (prUrl) => prs[prUrl] ?? 'open',
    returnFinding: async (input) => {
      returned.push({ prUrl: input.prUrl });
      files[input.findingPath] = { ...files[input.findingPath], status: 'approved' };
      return { commitSha: 'c-returned' };
    },
    say: (line) => said.push(line),
    waitMs: 20_000,
    pollMs: 50,
  };

  // The run's own activities: each issue's PR opens at the first poll and
  // closes at the first merge poll, so the run returns to `waiting-fix`.
  const issues: OpenFixIssueInput[] = [];
  const activities = {
    readSiteAutoFix: async () => false,
    // A cause with no path: the activity grants, and no dispatcher runs.
    requestFixSlot: async () => ({ paths: [], dispatched: false }),
    openFixIssue: async (input: OpenFixIssueInput): Promise<FixIssue> => {
      issues.push(input);
      const number = 100 + issues.length;
      activityCalls.push(`openFixIssue:${number}`);
      return { repo: 'mattpyle/mattpyle.com-website', number, url: `https://github.com/mattpyle/mattpyle.com-website/issues/${number}`, reused: false };
    },
    awaitFixPr: async () => ({ prUrl: ACTION_PR, branch: 'claude/issue-101-x' }),
    writeFindingFix: async () => {
      activityCalls.push('writeFindingFix');
      return { findingCommitSha: null, indexCommitSha: null, commitSha: null };
    },
    writeFindingVerdict: async () => {
      activityCalls.push('writeFindingVerdict');
      return { findingCommitSha: null, indexCommitSha: null, commitSha: null };
    },
    writeFindingReturned: async (input: WriteFindingReturnedInput) => {
      activityCalls.push(`writeFindingReturned:${input.prUrl}`);
      return { findingCommitSha: null, indexCommitSha: null, commitSha: null };
    },
    awaitFixPrMerge: async (prUrl: string): Promise<FixPrOutcome> => {
      activityCalls.push('awaitFixPrMerge');
      return { prUrl, state: 'closed', mergeSha: null, at: null };
    },
  };

  return { deps, said, returned, activityCalls, activities, issues };
}

async function withWorkers<T>(activities: object, fn: () => Promise<T>): Promise<T> {
  const findingsWorker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities,
    taskQueue: FINDINGS,
    bundlerOptions: {},
  });
  return await findingsWorker.runUntil(fn());
}

async function closeRun(key: string): Promise<void> {
  const handle = client.workflow.getHandle(findingWorkflowId(SITE, key));
  await handle.cancel().catch(() => undefined);
  await handle.result().catch(() => undefined);
}

async function startedInput(key: string): Promise<FindingWorkflowInput> {
  const history = await client.workflow.getHandle(findingWorkflowId(SITE, key)).fetchHistory();
  const attrs = history.events?.[0]?.workflowExecutionStartedEventAttributes;
  const payload = attrs?.input?.payloads?.[0];
  return JSON.parse(Buffer.from(payload?.data as Uint8Array).toString('utf8')) as FindingWorkflowInput;
}

test('an approved finding with no lifecycle run gets one, with the verdict from the file, and its fix opens an issue', async () => {
  const key = 'one-fix-path-approved--page';
  const h = harness(key, approvedFile());
  await withWorkers(h.activities, async () => {
    const requested = await requestFix(h.deps, SITE, key);
    assert.equal(requested.started, true);
    assert.equal(requested.returnedFrom, null);

    const input = await startedInput(key);
    assert.equal(input.stopAfter, 'resolved');
    assert.equal(input.origin, ORIGIN);
    assert.equal(input.branch, `fix/finding-${key}`);

    const reported: string[] = [];
    const fixed = await followFix(requested, (url) => reported.push(url), { pollMs: 50 });
    assert.equal(fixed.prUrl, ACTION_PR);
    assert.equal(fixed.issueUrl, 'https://github.com/mattpyle/mattpyle.com-website/issues/101');
    assert.deepEqual(reported, [fixed.issueUrl]);

    const state: FindingState = await requested.lifecycle.query(findingStateQuery);
    assert.equal(state.verdict?.source, 'file');
    assert.equal(state.verdict?.reason, 'Approved by Matt via steward finding approve.');
    // A verdict from the file writes nothing.
    assert.equal(h.activityCalls.includes('writeFindingVerdict'), false);
    assert.deepEqual(h.activityCalls.slice(0, 2), ['openFixIssue:101', 'writeFindingFix']);
    await closeRun(key);
  });
  assert.match(h.said.join('\n'), /started finding\/mattpyle-com\/one-fix-path-approved--page \(stop after resolved\)/);
});

test('a fixing finding with no run and a closed PR is returned to approved, said so, and fixed under a new run', async () => {
  const key = 'one-fix-path-closed--page';
  const h = harness(key, fixingFile(CLOSED_PR), { [CLOSED_PR]: 'closed' });
  await withWorkers(h.activities, async () => {
    const requested = await requestFix(h.deps, SITE, key);
    assert.equal(requested.started, true);
    assert.equal(requested.returnedFrom, CLOSED_PR);
    assert.deepEqual(h.returned, [{ prUrl: CLOSED_PR }]);
    const fixed = await followFix(requested, () => undefined, { pollMs: 50 });
    assert.equal(fixed.prUrl, ACTION_PR);
    await closeRun(key);
  });
  assert.match(h.said[0], /returned one-fix-path-closed--page to approved: .*pull\/338 closed unmerged/);
});

test('a fixing finding whose PR is open or merged is refused, and nothing starts', async () => {
  for (const [state, why] of [
    ['open', /still open\. Merge or close it first/],
    ['merged', /merged\. `steward finding verify one-fix-path-/],
  ] as const) {
    const key = `one-fix-path-${state}--page`;
    const h = harness(key, fixingFile(CLOSED_PR), { [CLOSED_PR]: state });
    await withWorkers(h.activities, async () => {
      await assert.rejects(requestFix(h.deps, SITE, key), (err: Error) => err instanceof FixRefused && why.test(err.message));
      await assert.rejects(client.workflow.getHandle(findingWorkflowId(SITE, key)).describe(), WorkflowNotFoundError);
      assert.deepEqual(h.returned, []);
    });
  }
});

test('a proposed finding is refused with its status', async () => {
  const key = 'one-fix-path-proposed--page';
  const h = harness(key, { status: 'proposed' });
  await withWorkers(h.activities, async () => {
    await assert.rejects(requestFix(h.deps, SITE, key), /its status is proposed, not approved/);
  });
});

test('an approved opportunity that names no page is refused before a run starts', async () => {
  const key = 'one-fix-path-opportunity--page';
  const h = harness(key, { ...approvedFile(), kind: 'opportunity' });
  await withWorkers(h.activities, async () => {
    await assert.rejects(requestFix(h.deps, SITE, key), /names no page/);
    await assert.rejects(client.workflow.getHandle(findingWorkflowId(SITE, key)).describe(), WorkflowNotFoundError);
  });
});

test('an approved direction is refused before a run starts', async () => {
  const key = 'one-fix-path-direction--page';
  const h = harness(key, { ...approvedFile(), kind: 'direction' });
  await withWorkers(h.activities, async () => {
    await assert.rejects(requestFix(h.deps, SITE, key), /its kind is direction, not defect or opportunity/);
    await assert.rejects(client.workflow.getHandle(findingWorkflowId(SITE, key)).describe(), WorkflowNotFoundError);
  });
});

test('an approved defect in the old template, with no cause, is refused before a run starts', async () => {
  const key = 'one-fix-path-no-cause--page';
  const oldTemplate = [
    '---',
    'status: approved',
    'kind: defect',
    '---',
    '',
    "# /changelog hasn't logged a new entry in 6 weeks",
    '',
    '## Finding',
    '',
    'No entry since the launch.',
    '',
    '## How to measure',
    '',
    'Read the newest entry date.',
  ].join('\n');
  const h = harness(key, approvedFile(), {}, oldTemplate);
  await withWorkers(h.activities, async () => {
    await assert.rejects(requestFix(h.deps, SITE, key), /does not go to the fixer: its "What happened" names no cause/);
    await assert.rejects(client.workflow.getHandle(findingWorkflowId(SITE, key)).describe(), WorkflowNotFoundError);
  });
});

test("an unquoted verdict_at, parsed as a Date, is the run's verdict time", async () => {
  const key = 'one-fix-path-date-verdict--page';
  const h = harness(key, { ...approvedFile(), verdict_at: new Date('2026-09-13T02:45:00Z') });
  await withWorkers(h.activities, async () => {
    const requested = await requestFix(h.deps, SITE, key);
    const state = await requested.lifecycle.query(findingStateQuery);
    assert.equal(state.verdict?.at, '2026-09-13T02:45:00.000Z');
    await followFix(requested, () => undefined, { pollMs: 50 });
    await closeRun(key);
  });
});

test('an open run that stops at the verdict gives way to a lifecycle run', async () => {
  const key = 'one-fix-path-verdict-run--page';
  const h = harness(key, approvedFile());
  await withWorkers(h.activities, async () => {
    const old = await client.workflow.start('findingWorkflow', {
      workflowId: findingWorkflowId(SITE, key),
      taskQueue: FINDINGS,
      args: [
        {
          site: SITE,
          key,
          repo: REPO,
          findingPath: findingPath(SITE, key),
          indexPath: `sites/${SITE}/findings/INDEX.md`,
          stopAfter: 'verdict',
        } satisfies FindingWorkflowInput,
      ],
    });
    const requested = await requestFix(h.deps, SITE, key);
    assert.equal(requested.replacedVerdictRun, true);
    assert.equal(requested.started, true);

    const was = await client.workflow.getHandle(old.workflowId, old.firstExecutionRunId).describe();
    assert.equal(was.status.name, 'CANCELLED');
    assert.equal((await startedInput(key)).stopAfter, 'resolved');
    await followFix(requested, () => undefined, { pollMs: 50 });
    await closeRun(key);
  });
  assert.match(h.said.join('\n'), /cancelled finding\/mattpyle-com\/one-fix-path-verdict-run--page: it stopped at the verdict/);
});

test('an open lifecycle run waiting for a fix is signalled, not replaced', async () => {
  const key = 'one-fix-path-lifecycle--page';
  const h = harness(key, approvedFile());
  await withWorkers(h.activities, async () => {
    const first = await requestFix(h.deps, SITE, key);
    await followFix(first, () => undefined, { pollMs: 50 });
    // The PR closes at the first poll, so the run returns to `waiting-fix`.
    while ((await first.lifecycle.query(findingStateQuery)).step !== 'waiting-fix') {
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = await requestFix(h.deps, SITE, key);
    assert.equal(second.started, false);
    assert.equal(second.lifecycle.workflowId, first.lifecycle.workflowId);
    const reported: string[] = [];
    const again = await followFix(second, (url) => reported.push(url), { pollMs: 50 });
    assert.equal(again.prUrl, ACTION_PR);
    // The second attempt opens a second issue and closes the first, naming the PR.
    assert.deepEqual(reported, ['https://github.com/mattpyle/mattpyle.com-website/issues/102']);
    assert.deepEqual(h.issues[1].supersedes, {
      url: 'https://github.com/mattpyle/mattpyle.com-website/issues/101',
      reason: `${ACTION_PR} closed unmerged`,
    });
    await closeRun(key);
  });
});

test('a site with no production origin is refused before anything starts', async () => {
  const key = 'one-fix-path-no-origin--page';
  const h = harness(key, approvedFile());
  await assert.rejects(requestFix({ ...h.deps, origin: undefined }, SITE, key), /no production origin for mattpyle-com/);
});

test('nothing starts fixFindingWorkflow: the one child call is the replay branch in finding.ts', async () => {
  const offenders: string[] = [];
  const children: string[] = [];
  for (const entry of await fs.readdir(SRC, { recursive: true })) {
    if (!entry.endsWith('.ts')) continue;
    const text = await fs.readFile(path.join(SRC, entry), 'utf8');
    if (/\b(start|signalWithStart|execute)\(\s*['"]?fixFindingWorkflow\b/.test(text)) offenders.push(entry);
    if (/executeChild\(\s*fixFindingWorkflow\b/.test(text)) children.push(entry.replaceAll('\\', '/'));
  }
  assert.deepEqual(offenders, []);
  assert.deepEqual(children, ['workflows/finding.ts']);
});
