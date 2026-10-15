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
import { STUB_PR } from '../helpers/stub-fix-workflow.js';
import { FixRefused, followFix, requestFix, type FindingFixDeps } from '../../src/lib/finding-fix.js';
import { findingPath, findingWorkflowId, fixWorkflowId } from '../../src/lib/findings.js';
import {
  findingStateQuery,
  type FindingState,
  type FindingWorkflowInput,
} from '../../src/workflows/finding.js';
import type { FixPrOutcome, WriteFindingReturnedInput } from '../../src/activities/findings.js';

/**
 * `steward finding fix`, the one fix path, against the time-skipping server:
 * the real `findingWorkflow` on `steward-findings` with mocked activities, and
 * a stub `fixFindingWorkflow` on `steward-heavy` that opens a PR at once. The
 * finding file and GitHub are in-memory maps behind `requestFix`'s deps.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const stubPath = fileURLToPath(new URL('../helpers/stub-fix-workflow.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const FINDINGS = 'steward-findings';
const HEAVY = 'steward-heavy';
const SITE = 'mattpyle-com';
const REPO = 'mattpyle/argus';
const ORIGIN = 'https://www.mattpyle.com';
const CLOSED_PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/338';

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

  // The parent's own activities: the stub's PR closes at the first poll, so
  // the run returns to `waiting-fix` and the test cancels it.
  const activities = {
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

  return { deps, said, returned, activityCalls, activities };
}

async function withWorkers<T>(activities: object, fn: () => Promise<T>): Promise<T> {
  const findingsWorker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath,
    activities,
    taskQueue: FINDINGS,
    bundlerOptions: {},
  });
  const heavyWorker = await Worker.create({
    connection: env.nativeConnection,
    workflowsPath: stubPath,
    taskQueue: HEAVY,
    bundlerOptions: {},
  });
  return await findingsWorker.runUntil(heavyWorker.runUntil(fn()));
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

test('an approved finding with no lifecycle run gets one, with the verdict from the file, and its fix runs as the child', async () => {
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

    const steps: string[] = [];
    const fixed = await followFix(client, SITE, key, requested, (s) => steps.push(s), { pollMs: 50 });
    assert.equal(fixed.prUrl, STUB_PR);
    assert.equal(steps[0], 'started');

    const state: FindingState = await requested.lifecycle.query(findingStateQuery);
    assert.equal(state.verdict?.source, 'file');
    assert.equal(state.verdict?.reason, 'Approved by Matt via steward finding approve.');
    // A verdict from the file writes nothing.
    assert.equal(h.activityCalls.includes('writeFindingVerdict'), false);
    // The child's parent is the lifecycle run.
    const child = await client.workflow.getHandle(fixWorkflowId(SITE, key)).describe();
    assert.equal(child.parentExecution?.workflowId, findingWorkflowId(SITE, key));
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
    const fixed = await followFix(client, SITE, key, requested, () => undefined, { pollMs: 50 });
    assert.equal(fixed.prUrl, STUB_PR);
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

test('an approved opportunity is refused before a run starts', async () => {
  const key = 'one-fix-path-opportunity--page';
  const h = harness(key, { ...approvedFile(), kind: 'opportunity' });
  await withWorkers(h.activities, async () => {
    await assert.rejects(requestFix(h.deps, SITE, key), /its kind is opportunity, not defect/);
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
    await followFix(client, SITE, key, requested, () => undefined, { pollMs: 50 });
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
    await followFix(client, SITE, key, requested, () => undefined, { pollMs: 50 });
    await closeRun(key);
  });
  assert.match(h.said.join('\n'), /cancelled finding\/mattpyle-com\/one-fix-path-verdict-run--page: it stopped at the verdict/);
});

test('an open lifecycle run waiting for a fix is signalled, not replaced', async () => {
  const key = 'one-fix-path-lifecycle--page';
  const h = harness(key, approvedFile());
  await withWorkers(h.activities, async () => {
    const first = await requestFix(h.deps, SITE, key);
    await followFix(client, SITE, key, first, () => undefined, { pollMs: 50 });
    // The stub's PR closes at the first poll, so the run returns to `waiting-fix`.
    while ((await first.lifecycle.query(findingStateQuery)).step !== 'waiting-fix') {
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = await requestFix(h.deps, SITE, key);
    assert.equal(second.started, false);
    assert.equal(second.lifecycle.workflowId, first.lifecycle.workflowId);
    const again = await followFix(client, SITE, key, second, () => undefined, { pollMs: 50 });
    assert.equal(again.prUrl, STUB_PR);
    await closeRun(key);
  });
});

test('a site with no production origin is refused before anything starts', async () => {
  const key = 'one-fix-path-no-origin--page';
  const h = harness(key, approvedFile());
  await assert.rejects(requestFix({ ...h.deps, origin: undefined }, SITE, key), /no production origin for mattpyle-com/);
});

test('no code path starts fixFindingWorkflow without a parent', async () => {
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
