import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOSTED_ACTIVITY_CONCURRENCY,
  HOSTED_FAST_ACTIVITY_CONCURRENCY,
  HOSTED_FINDINGS_ACTIVITY_CONCURRENCY,
  HOSTED_FINDINGS_CHECKS_ACTIVITY_CONCURRENCY,
  HOSTED_FINDINGS_WATCH_ACTIVITY_CONCURRENCY,
  QUEUE_AUDIT,
  QUEUE_AUDIT_FAST,
  QUEUE_FINDINGS,
  QUEUE_FINDINGS_CHECKS,
  QUEUE_FINDINGS_WATCH,
} from '../../src/config.js';
import { hostedRegistry } from '../../src/hosted-registry.js';

/**
 * The hosted container runs five workers, and `src/hosted-registry.ts` is the
 * one list of what each of them is: its queue, its activities, whether it
 * carries the workflow bundle, and its cap. `worker-hosted.ts` builds its
 * `Worker.create` calls from that list and declares nothing of its own, so these
 * tests build the same list the container boots from. A wrong map wired to a
 * queue fails here by queue name.
 *
 * The entry point itself cannot be imported: it calls `main()` at module scope,
 * which connects to Temporal and refuses to start without a GitHub App credential. That
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
  'readScorecardPrChecks',
  'mergeScorecardPr',
  'archiveScorecardRun',
  'reportRunHealth',
  'checkActionUsage',
];

const FINDINGS_ACTIVITIES = [
  'readFindingsIndex',
  'readFinding',
  'writeFindingVerdict',
  'writeFindingReturned',
  'readSiteAutoFix',
  'readFindingSettings',
  'openFixIssue',
  'awaitFixPr',
  'findFixPr',
  'writeFindingFix',
  'awaitFixPrMerge',
  'awaitPrPreview',
  'awaitProductionDeploy',
  'readProductionDeploy',
  'listOpenFindingWorkflows',
  'readFixPr',
  'readVerifyBlock',
  'runFindingChecks',
  'writeFindingVerification',
  'reportPreviewChecks',
  'requestFixSlot',
  'runningWorkflowIds',
  'closeConflictingFixPr',
  'commentOnFixPr',
  'reportRunHealth',
  'readSiteHosts',
  'readRecheckBlock',
  'writeFindingRecheck',
  'readWatchRun',
  'writeFindingVerdictMeasure',
  'writeFindingLook',
  'draftFixLogEntry',
  'commitFixLogEntry',
  'openFixLogConfirmation',
  'readFixLogConfirmationChecks',
  'mergeFixLogConfirmation',
];

/** The registry entry for a queue, found by name so a test names the queue it is about. */
function entryFor(taskQueue: string) {
  const entry = hostedRegistry().find((each) => each.taskQueue === taskQueue);
  assert.ok(entry, `the hosted registry has no entry for ${taskQueue}`);
  return entry;
}

const names = (taskQueue: string) => Object.keys(entryFor(taskQueue).activities);

/**
 * Every `proxyActivities` call in a workflow source: the activity names its
 * `Pick` names, and the queue it schedules on, resolved through the file's own
 * `const QUEUE_… = '…'` (determinism rule 9 duplicates the names there).
 */
async function proxiesIn(file: string): Promise<{ activities: string[]; queue: string }[]> {
  const source = await fs.readFile(path.join(SRC, 'workflows', file), 'utf8');
  const constants = new Map([...source.matchAll(/const (QUEUE_\w+) = '([^']+)';/g)].map((m) => [m[1], m[2]]));
  return [...source.matchAll(/proxyActivities<\s*Pick<typeof activities,\s*([^>]*)>\s*>\(\{\s*taskQueue: (\w+),/g)].map((m) => {
    const queue = constants.get(m[2]);
    assert.ok(queue, `${file}: ${m[2]} is not declared in the file`);
    return { activities: [...m[1].matchAll(/'(\w+)'/g)].map((name) => name[1]), queue };
  });
}

/** Each proxy's activities are registered on the queue it names, and `runFindingChecks` is on the checks queue. */
function assertProxiesServed(file: string, proxies: { activities: string[]; queue: string }[]) {
  for (const proxy of proxies) {
    const registered = names(proxy.queue);
    for (const name of proxy.activities) assert.ok(registered.includes(name), `${file}: ${name} is not registered on ${proxy.queue}`);
    const expected = proxy.activities.includes('runFindingChecks') ? QUEUE_FINDINGS_CHECKS : QUEUE_FINDINGS;
    assert.equal(proxy.queue, expected, `${file}: ${proxy.activities.join(', ')} schedules on ${proxy.queue}`);
  }
}

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
  assert.equal(HOSTED_FINDINGS_ACTIVITY_CONCURRENCY, 10, 'no browser runs on the findings queue since STW-716');
  assert.equal(HOSTED_FINDINGS_CHECKS_ACTIVITY_CONCURRENCY, 2, 'the two Chromium checks the findings queue allowed before, so the worst case does not grow');
  assert.deepEqual(
    hostedRegistry().map((each) => [each.taskQueue, each.maxConcurrentActivityTaskExecutions]),
    [
      [QUEUE_AUDIT, HOSTED_ACTIVITY_CONCURRENCY],
      [QUEUE_AUDIT_FAST, HOSTED_FAST_ACTIVITY_CONCURRENCY],
      [QUEUE_FINDINGS, HOSTED_FINDINGS_ACTIVITY_CONCURRENCY],
      [QUEUE_FINDINGS_WATCH, HOSTED_FINDINGS_WATCH_ACTIVITY_CONCURRENCY],
      [QUEUE_FINDINGS_CHECKS, HOSTED_FINDINGS_CHECKS_ACTIVITY_CONCURRENCY],
    ],
  );
  assert.equal(HOSTED_FINDINGS_WATCH_ACTIVITY_CONCURRENCY, 1, 'one watch attempt at a time: each can launch Chromium');
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
  assert.ok(!localWorkerQueues(false).includes(QUEUE_FINDINGS_CHECKS), 'the checks queue has the hosted worker alone');
  assert.match(local, /LOCAL_WORKER_QUEUES\.map\(/, 'the worker creates one Worker per entry of the shared list');
  assert.doesNotMatch(local, /QUEUE_FINDINGS/, 'the ready line lists the queues the local worker serves');
});

test('the registry serves five distinct queues, audit then fast then findings then watch then checks', () => {
  const queues = [QUEUE_AUDIT, QUEUE_AUDIT_FAST, QUEUE_FINDINGS, QUEUE_FINDINGS_WATCH, QUEUE_FINDINGS_CHECKS];
  assert.deepEqual(hostedRegistry().map((each) => each.taskQueue), queues);
  assert.equal(new Set(queues).size, 5, 'sharing a queue would be sharing the cap');
});

test('runFindingChecks is registered on the checks queue and, for a check scheduled before the move, on steward-findings', async () => {
  assert.equal(QUEUE_FINDINGS_CHECKS, 'steward-findings-checks');
  assert.deepEqual(names(QUEUE_FINDINGS_CHECKS), ['runFindingChecks'], 'the checks queue serves the browser checks and nothing else');
  assert.ok(
    names(QUEUE_FINDINGS).includes('runFindingChecks'),
    'a check keeps the queue it was scheduled on for every retry, so one scheduled before the deploy completes on steward-findings',
  );
  assert.equal(entryFor(QUEUE_FINDINGS_CHECKS).carriesWorkflows, false);
  const { BROWSER_ACTIVITY_TYPES } = await import('../../src/lib/recycle-policy.js');
  assert.ok(BROWSER_ACTIVITY_TYPES.has('runFindingChecks'), 'an activity that can launch Chromium arms the recycle');
});

test('every runFindingChecks proxy in the findings workflows schedules on the checks queue', async () => {
  const counts: Record<string, number> = {};
  for (const file of ['finding.ts', 'verify-finding.ts', 'recheck-findings.ts']) {
    const proxies = (await proxiesIn(file)).filter((proxy) => proxy.activities.includes('runFindingChecks'));
    counts[file] = proxies.length;
    for (const proxy of proxies) assert.equal(proxy.queue, QUEUE_FINDINGS_CHECKS, `${file}: a check on ${proxy.queue} holds a slot a verdict write needs`);
  }
  // The preview test and the verdict measurement; the verify's fast and slow phase; the recheck.
  assert.deepEqual(counts, { 'finding.ts': 2, 'verify-finding.ts': 2, 'recheck-findings.ts': 1 });
});

test('the watch queue registers watchFinding alone, the queue the workflow names, and the recycle policy counts it', async () => {
  assert.deepEqual(names(QUEUE_FINDINGS_WATCH), ['watchFinding']);
  assert.ok(!names(QUEUE_FINDINGS).includes('watchFinding'), 'a watch attempt on steward-findings would hold a verdict write\'s slot');
  // Determinism rule 9: the workflow duplicates the queue name; a typo there would schedule onto a queue nobody polls.
  const workflow = await fs.readFile(path.join(SRC, 'workflows', 'finding.ts'), 'utf8');
  assert.match(workflow, new RegExp(`const QUEUE_FINDINGS_WATCH = '${QUEUE_FINDINGS_WATCH}';`));
  const { BROWSER_ACTIVITY_TYPES } = await import('../../src/lib/recycle-policy.js');
  assert.ok(BROWSER_ACTIVITY_TYPES.has('watchFinding'), 'an activity that can launch Chromium arms the recycle');
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
  assert.equal(names(QUEUE_AUDIT).length, 14);
  assert.equal(names(QUEUE_FINDINGS).length, 36);
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
      [QUEUE_FINDINGS_WATCH, false],
      [QUEUE_FINDINGS_CHECKS, false],
    ],
    'the fast queue is activities only, so it can never be given a deep audit',
  );
});

test('every activity the verifier schedules is registered on the queue its proxy names', async () => {
  const verifier = await fs.readFile(path.join(SRC, 'workflows', 'verify-finding.ts'), 'utf8');
  const proxied = [...verifier.matchAll(/Pick<typeof activities, ([^>]*)>/g)].flatMap((m) =>
    [...m[1].matchAll(/'(\w+)'/g)].map((name) => name[1]),
  );
  // Each activity twice since STW-653: the fast phase's stub and the slow phase's.
  assert.deepEqual([...new Set(proxied)].sort(), [
    'readFinding',
    'readFixPr',
    'readProductionDeploy',
    'readVerifyBlock',
    'runFindingChecks',
    'writeFindingVerification',
  ]);
  assert.equal(proxied.length, 12);
  const proxies = await proxiesIn('verify-finding.ts');
  assert.deepEqual(proxies.flatMap((proxy) => proxy.activities), proxied, 'every proxy names its queue first');
  assertProxiesServed('verify-finding.ts', proxies);
});

test('every activity the recheck schedules is registered on the queue its proxy names', async () => {
  const recheck = await fs.readFile(path.join(SRC, 'workflows', 'recheck-findings.ts'), 'utf8');
  const proxied = [...recheck.matchAll(/Pick<typeof activities,\s*([^>]*)>/g)].flatMap((m) =>
    [...m[1].matchAll(/'(\w+)'/g)].map((name) => name[1]),
  );
  assert.deepEqual(proxied.sort(), [
    'listOpenFindingWorkflows',
    'readFindingsIndex',
    'readRecheckBlock',
    'readSiteHosts',
    'readWatchRun',
    'reportRunHealth',
    'runFindingChecks',
    'writeFindingRecheck',
  ]);
  const proxies = await proxiesIn('recheck-findings.ts');
  assert.deepEqual(proxies.flatMap((proxy) => proxy.activities).sort(), proxied, 'every proxy names its queue first');
  assertProxiesServed('recheck-findings.ts', proxies);
});
