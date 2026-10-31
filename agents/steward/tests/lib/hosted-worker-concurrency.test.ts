import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOSTED_ACTIVITY_CONCURRENCY,
  HOSTED_FAST_ACTIVITY_CONCURRENCY,
  HOSTED_FINDINGS_ACTIVITY_CONCURRENCY,
  QUEUE_AUDIT,
  QUEUE_AUDIT_FAST,
  QUEUE_FINDINGS,
} from '../../src/config.js';

/**
 * The hosted container runs three workers with their own caps, and these tests
 * are what stops any of them drifting back to the SDK's default of 100.
 *
 * The audit queue's one is a correctness rule about Lighthouse; the fast queue's
 * four is a throughput choice for a public, synchronous tool. Swapping them would
 * be a silent regression in both directions at once — corrupted Lighthouse timing
 * marks on one queue, a public tool queueing behind itself on the other — so the
 * pair is asserted together and in order.
 *
 * Why the values and the wiring are asserted separately: a constant alone is a
 * number nobody has to read, and an SDK option alone is a line a later edit can
 * quietly retune.
 *
 * Read as source text rather than by importing the worker, because
 * `worker-hosted.ts` calls `main()` at module scope: importing it would try to
 * connect to Temporal and would refuse to start without `GITHUB_TOKEN`. A
 * `Worker.create` call cannot be inspected without one.
 */

const HOSTED_WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'worker-hosted.ts',
);

const source = () => fs.readFile(HOSTED_WORKER, 'utf8');

test('the hosted activity concurrency is 1, the serial-Lighthouse constraint', () => {
  assert.equal(HOSTED_ACTIVITY_CONCURRENCY, 1);
});

test('the fast queue runs four at a time, and it is a different number on purpose', () => {
  assert.equal(HOSTED_FAST_ACTIVITY_CONCURRENCY, 4);
  assert.notEqual(
    HOSTED_FAST_ACTIVITY_CONCURRENCY,
    HOSTED_ACTIVITY_CONCURRENCY,
    'a fast audit launches no browser, so the serial rule does not reach it — and the public ' +
      'tool it serves is synchronous, so a caller must not queue behind three others',
  );
});

test('each worker sets the option once, from its own constant, in queue order', async () => {
  const assignments = [
    ...(await source()).matchAll(/maxConcurrentActivityTaskExecutions:\s*([^,\n]+)/g),
  ].map((match) => match[1].trim());
  assert.deepEqual(
    assignments,
    ['HOSTED_ACTIVITY_CONCURRENCY', 'HOSTED_FAST_ACTIVITY_CONCURRENCY', 'HOSTED_FINDINGS_ACTIVITY_CONCURRENCY'],
    'worker-hosted.ts must pass maxConcurrentActivityTaskExecutions once per worker, each from ' +
      'its own constant — an extra assignment, or a literal, is how a cap comes back off',
  );
});

test('the laptop worker serves two queues on Cloud, four on the local dev server, never steward-findings', async () => {
  const local = await fs.readFile(path.join(path.dirname(HOSTED_WORKER), 'worker.ts'), 'utf8');
  const { LAPTOP_WORKER_QUEUES, IS_TEMPORAL_CLOUD, laptopWorkerQueues, QUEUE_LIGHT, QUEUE_HEAVY } = await import(
    '../../src/config.js'
  );
  assert.deepEqual(
    [...laptopWorkerQueues(true)],
    [QUEUE_LIGHT, QUEUE_HEAVY],
    'on Cloud the hosted worker owns the audit queues; a laptop poller there runs stale audit code after a merge',
  );
  assert.deepEqual(
    [...laptopWorkerQueues(false)],
    [QUEUE_LIGHT, QUEUE_HEAVY, QUEUE_AUDIT, QUEUE_AUDIT_FAST],
    'the local dev server has no hosted worker, so the laptop keeps the audit queues',
  );
  assert.deepEqual([...LAPTOP_WORKER_QUEUES], [...laptopWorkerQueues(IS_TEMPORAL_CLOUD)], 'the constant resolves from the connection');
  assert.ok(!LAPTOP_WORKER_QUEUES.includes(QUEUE_FINDINGS), 'a second poller on steward-findings lets an old-code laptop fail a hosted run');
  assert.match(local, /LAPTOP_WORKER_QUEUES\.map\(/, 'the worker creates one Worker per entry of the shared list');
  assert.doesNotMatch(local, /QUEUE_FINDINGS/, 'the ready line lists the queues the laptop worker serves');
});

test('the second worker serves the fast queue and registers nothing but the fast audit', async () => {
  const text = await source();

  const queues = [...text.matchAll(/taskQueue:\s*([A-Z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(
    queues,
    ['QUEUE_AUDIT', 'QUEUE_AUDIT_FAST', 'QUEUE_FINDINGS'],
    'three workers, three queues, and the fast one is second',
  );
  assert.equal(new Set([QUEUE_AUDIT, QUEUE_AUDIT_FAST, QUEUE_FINDINGS]).size, 3, 'sharing a queue would be sharing the cap');

  // The list is the contract with the queue, per the file's own docblock: anything in it becomes
  // work the public MCP endpoint can dispatch onto this container with no workflow in between.
  const fast = text.match(/const fastActivities = \{([^}]*)\}/);
  assert.ok(fast, "worker-hosted.ts must declare the fast queue's activity map by name");
  assert.deepEqual(
    fast[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    ['auditSiteFast'],
  );
});

test('the fast worker carries no workflow bundle, so it can never be given a deep audit', async () => {
  const workflowPaths = [...(await source()).matchAll(/^\s*workflowsPath,$/gm)];
  assert.equal(
    workflowPaths.length,
    2,
    "the audit and findings workers carry the workflow bundle; the fast queue is activities only",
  );
});

test('the findings worker runs a small bounded cap and registers only the findings activities', async () => {
  assert.equal(HOSTED_FINDINGS_ACTIVITY_CONCURRENCY, 2);
  const text = await source();
  const map = text.match(/const findingsActivities = \{([^}]*)\}/);
  assert.ok(map, "worker-hosted.ts must declare the findings queue's activity map by name");
  assert.deepEqual(
    map[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    [
      'listSites',
      'readFindingsIndex',
      'readFinding',
      'writeFindingVerdict',
      'writeFindingReturned',
      'readSiteAutoFix',
      'openFixIssue',
      'awaitFixPr',
      'writeFindingFix',
      'awaitFixPrMerge',
      'awaitPrPreview',
      'awaitProductionDeploy',
      'readProductionDeploy',
      'listOpenFindingWorkflows',
      'startFindingWorkflow',
      'readFixPr',
      'readVerifyBlock',
      'runFindingChecks',
      'writeFindingVerification',
      'reportPreviewChecks',
      'requestFixSlot',
      'runningWorkflowIds',
      'closeConflictingFixPr',
      'reportRunHealth',
    ],
  );
});

test('every activity the verifier schedules is on steward-findings and registered by the hosted worker', async () => {
  const hosted = await source();
  const registered = hosted.match(/const findingsActivities = \{([^}]*)\}/)![1];
  const verifier = await fs.readFile(path.join(path.dirname(HOSTED_WORKER), 'workflows', 'verify-finding.ts'), 'utf8');
  const proxied = [...verifier.matchAll(/Pick<typeof activities, ([^>]*)>/g)].flatMap((m) =>
    [...m[1].matchAll(/'(\w+)'/g)].map((name) => name[1]),
  );
  assert.deepEqual(proxied.sort(), [
    'readFinding',
    'readFixPr',
    'readProductionDeploy',
    'readVerifyBlock',
    'runFindingChecks',
    'writeFindingVerification',
  ]);
  for (const name of proxied) assert.match(registered, new RegExp(`\\b${name}\\b`), `${name} is not in findingsActivities`);
  assert.deepEqual([...verifier.matchAll(/taskQueue: (\w+)/g)].map((m) => m[1]), Array(3).fill('QUEUE_FINDINGS'));
  assert.match(verifier, /const QUEUE_FINDINGS = 'steward-findings';/);
});
