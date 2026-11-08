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
import { hostedRegistry } from '../../src/hosted-registry.js';

/**
 * The hosted container runs three workers, and `src/hosted-registry.ts` is the
 * one list of what each of them is: its queue, its activities, whether it
 * carries the workflow bundle, and its cap. `worker-hosted.ts` builds its
 * `Worker.create` calls from that list and declares nothing of its own, so these
 * tests build the same list the container boots from. A wrong map wired to a
 * queue fails here by queue name.
 *
 * The entry point itself cannot be imported: it calls `main()` at module scope,
 * which connects to Temporal and refuses to start without `GITHUB_TOKEN`. That
 * is why the registry is its own module. Nothing here reads `worker-hosted.ts`
 * as text, so nothing here cares how an object is spelled or in what order it
 * is declared.
 *
 * The caps are asserted against the constants too. The audit queue's one is a
 * correctness rule about Lighthouse; the fast queue's four is a throughput
 * choice for a public, synchronous tool. Swapping them would be a silent
 * regression in both directions at once, so the pair is asserted together.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

const AUDIT_ACTIVITIES = [
  'auditSiteFast',
  'auditSiteFetchChecks',
  'auditRenderedPage',
  'assembleDeepAudit',
  'resolveAuditUrls',
  'resolveRunStamp',
  'auditLiveUrl',
  'readPublishedScorecard',
  'publishScorecardRun',
  'archiveScorecardRun',
  'reportRunHealth',
  'checkCredentialExpiry',
  'checkActionUsage',
];

const FINDINGS_ACTIVITIES = [
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
  'listFixableFindings',
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
  'readSiteHosts',
  'readRecheckBlock',
  'writeFindingRecheck',
];

/** The registry entry for a queue, found by name so a test names the queue it is about. */
function entryFor(taskQueue: string) {
  const entry = hostedRegistry().find((each) => each.taskQueue === taskQueue);
  assert.ok(entry, `the hosted registry has no entry for ${taskQueue}`);
  return entry;
}

const names = (taskQueue: string) => Object.keys(entryFor(taskQueue).activities);

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

test('each queue takes its own cap from the registry, never the SDK default of 100', () => {
  assert.equal(HOSTED_FINDINGS_ACTIVITY_CONCURRENCY, 2);
  assert.deepEqual(
    hostedRegistry().map((each) => [each.taskQueue, each.maxConcurrentActivityTaskExecutions]),
    [
      [QUEUE_AUDIT, HOSTED_ACTIVITY_CONCURRENCY],
      [QUEUE_AUDIT_FAST, HOSTED_FAST_ACTIVITY_CONCURRENCY],
      [QUEUE_FINDINGS, HOSTED_FINDINGS_ACTIVITY_CONCURRENCY],
    ],
  );
});

test('the local worker serves two queues on Cloud, four on the local dev server, never steward-findings', async () => {
  const local = await fs.readFile(path.join(SRC, 'worker.ts'), 'utf8');
  const { LOCAL_WORKER_QUEUES, IS_TEMPORAL_CLOUD, localWorkerQueues, QUEUE_LIGHT, QUEUE_HEAVY } = await import(
    '../../src/config.js'
  );
  assert.deepEqual(
    [...localWorkerQueues(true)],
    [QUEUE_LIGHT, QUEUE_HEAVY],
    'on Cloud the hosted worker owns the audit queues; a local poller there runs stale audit code after a merge',
  );
  assert.deepEqual(
    [...localWorkerQueues(false)],
    [QUEUE_LIGHT, QUEUE_HEAVY, QUEUE_AUDIT, QUEUE_AUDIT_FAST],
    'the local dev server has no hosted worker, so the local machine keeps the audit queues',
  );
  assert.deepEqual([...LOCAL_WORKER_QUEUES], [...localWorkerQueues(IS_TEMPORAL_CLOUD)], 'the constant resolves from the connection');
  assert.ok(!LOCAL_WORKER_QUEUES.includes(QUEUE_FINDINGS), 'a second poller on steward-findings lets an old-code local worker fail a hosted run');
  assert.match(local, /LOCAL_WORKER_QUEUES\.map\(/, 'the worker creates one Worker per entry of the shared list');
  assert.doesNotMatch(local, /QUEUE_FINDINGS/, 'the ready line lists the queues the local worker serves');
});

test('the registry serves three distinct queues, audit then fast then findings', () => {
  assert.deepEqual(
    hostedRegistry().map((each) => each.taskQueue),
    [QUEUE_AUDIT, QUEUE_AUDIT_FAST, QUEUE_FINDINGS],
  );
  assert.equal(new Set([QUEUE_AUDIT, QUEUE_AUDIT_FAST, QUEUE_FINDINGS]).size, 3, 'sharing a queue would be sharing the cap');
});

test('each queue registers exactly its own activities, by name', () => {
  assert.deepEqual(names(QUEUE_AUDIT).sort(), [...AUDIT_ACTIVITIES].sort(), `${QUEUE_AUDIT}: the audit and scorecard activities`);
  // The list is the contract with the queue: anything in it becomes work the public MCP endpoint
  // can dispatch onto this container with no workflow in between.
  assert.deepEqual(names(QUEUE_AUDIT_FAST), ['auditSiteFast'], `${QUEUE_AUDIT_FAST}: the fast audit and nothing else`);
  assert.deepEqual(
    names(QUEUE_FINDINGS).sort(),
    [...FINDINGS_ACTIVITIES].sort(),
    `${QUEUE_FINDINGS}: the findings activities, plus reportRunHealth`,
  );
  assert.equal(names(QUEUE_AUDIT).length, 13);
  assert.equal(names(QUEUE_FINDINGS).length, 28);
});

test('every registered activity is a function', () => {
  for (const entry of hostedRegistry()) {
    for (const [name, fn] of Object.entries(entry.activities)) {
      assert.equal(typeof fn, 'function', `${entry.taskQueue}: ${name} is not a function`);
    }
  }
});

test('the audit and findings queues carry the workflow bundle; the fast queue never does', () => {
  assert.deepEqual(
    hostedRegistry().map((each) => [each.taskQueue, each.carriesWorkflows]),
    [
      [QUEUE_AUDIT, true],
      [QUEUE_AUDIT_FAST, false],
      [QUEUE_FINDINGS, true],
    ],
    'the fast queue is activities only, so it can never be given a deep audit',
  );
});

test('every activity the verifier schedules is on steward-findings and registered by the hosted worker', async () => {
  const verifier = await fs.readFile(path.join(SRC, 'workflows', 'verify-finding.ts'), 'utf8');
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
  const registered = names(QUEUE_FINDINGS);
  for (const name of proxied) assert.ok(registered.includes(name), `${name} is not registered on ${QUEUE_FINDINGS}`);
  assert.deepEqual([...verifier.matchAll(/taskQueue: (\w+)/g)].map((m) => m[1]), Array(3).fill('QUEUE_FINDINGS'));
  assert.match(verifier, /const QUEUE_FINDINGS = 'steward-findings';/);
});

test('every activity the recheck schedules is on steward-findings and registered by the hosted worker', async () => {
  const recheck = await fs.readFile(path.join(SRC, 'workflows', 'recheck-findings.ts'), 'utf8');
  const proxied = [...recheck.matchAll(/Pick<typeof activities,\s*([^>]*)>/g)].flatMap((m) =>
    [...m[1].matchAll(/'(\w+)'/g)].map((name) => name[1]),
  );
  assert.deepEqual(proxied.sort(), [
    'listOpenFindingWorkflows',
    'readFindingsIndex',
    'readRecheckBlock',
    'readSiteHosts',
    'runFindingChecks',
    'writeFindingRecheck',
  ]);
  const registered = names(QUEUE_FINDINGS);
  for (const name of proxied) assert.ok(registered.includes(name), `${name} is not registered on ${QUEUE_FINDINGS}`);
  assert.deepEqual([...recheck.matchAll(/taskQueue: (\w+)/g)].map((m) => m[1]), Array(3).fill('QUEUE_FINDINGS'));
  assert.match(recheck, /const QUEUE_FINDINGS = 'steward-findings';/);
});
