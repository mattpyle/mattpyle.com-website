import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOSTED_ACTIVITY_CONCURRENCY,
  HOSTED_FAST_ACTIVITY_CONCURRENCY,
  QUEUE_AUDIT,
  QUEUE_AUDIT_FAST,
} from '../../src/config.js';

/**
 * The hosted container runs two workers with two very different caps, and these
 * tests are what stops either drifting back to the SDK's default of 100.
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
    ['HOSTED_ACTIVITY_CONCURRENCY', 'HOSTED_FAST_ACTIVITY_CONCURRENCY'],
    'worker-hosted.ts must pass maxConcurrentActivityTaskExecutions once per worker, each from ' +
      'its own constant — a third assignment, or a literal, is how a cap comes back off',
  );
});

test('the second worker serves the fast queue and registers nothing but the fast audit', async () => {
  const text = await source();

  const queues = [...text.matchAll(/taskQueue:\s*([A-Z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(
    queues,
    ['QUEUE_AUDIT', 'QUEUE_AUDIT_FAST'],
    'two workers, two queues, and the fast one is second',
  );
  assert.notEqual(QUEUE_AUDIT, QUEUE_AUDIT_FAST, 'sharing a queue would be sharing the cap');

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
    1,
    "only the audit queue's worker carries the workflow bundle; the fast queue is activities only",
  );
});
