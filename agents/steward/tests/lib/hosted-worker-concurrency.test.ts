import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTED_ACTIVITY_CONCURRENCY } from '../../src/config.js';

/**
 * The hosted worker takes one activity at a time, and these two tests are what
 * stops it drifting back to the SDK's default of 100.
 *
 * Why the value and the wiring are asserted separately: the constant alone is a
 * number nobody has to read, and the SDK option alone is a line a later edit can
 * quietly retune. The pair holds the property the `marky` constraint actually
 * needs — that the process Railway runs never has two Lighthouse runs in it.
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

test('the hosted activity concurrency is 1, the serial-Lighthouse constraint', () => {
  assert.equal(HOSTED_ACTIVITY_CONCURRENCY, 1);
});

test('the hosted worker sets the option exactly once, from that constant', async () => {
  const source = await fs.readFile(HOSTED_WORKER, 'utf8');
  const assignments = [...source.matchAll(/maxConcurrentActivityTaskExecutions:\s*([^,\n]+)/g)].map(
    (match) => match[1].trim(),
  );
  assert.deepEqual(
    assignments,
    ['HOSTED_ACTIVITY_CONCURRENCY'],
    'worker-hosted.ts must pass maxConcurrentActivityTaskExecutions exactly once, and it must be ' +
      'HOSTED_ACTIVITY_CONCURRENCY — a second assignment, or a literal, is how the cap comes back off',
  );
});
