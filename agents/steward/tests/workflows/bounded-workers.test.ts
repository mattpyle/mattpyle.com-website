import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every `runUntil` in the suite takes `bounded(...)` from
 * `tests/helpers/test-env.ts`, or a helper that calls it.
 *
 * Why: `Worker.runUntil` shuts its worker down only when its own promise
 * settles. A worker started inside another worker's bounded promise is not
 * stopped by that outer bound. On CI on 2026-11-11 and 2026-11-13 one such
 * worker outlived its test, `env.teardown()` threw "Cannot close connection
 * while Workers hold a reference to it", and the orphaned worker kept the
 * test file's process alive until the job hit its 15-minute limit (STW-593).
 * `--test-timeout` fails the test but cannot end the process.
 *
 * `scripts/select-steward-tests.mjs` names this test in `DIRECTORY_READERS`
 * for `tests/`, so a change to any test file runs it.
 */

const TESTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `bounded(`, or this file's `phase(`, which calls it. A chain such as
 * `light.runUntil(heavy.runUntil(bounded(fn())))` counts: the inner worker
 * settles when its bound fires, and the outer one settles with it.
 */
const BOUNDING = /^(?:\w+\.runUntil\( ?)*(?:bounded|phase)\(/;

function files(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, out);
    else if (/\.(m?ts|m?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('every runUntil in the suite is bounded', () => {
  const unbounded: string[] = [];
  for (const file of files(TESTS)) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\.runUntil\(\s*/g)) {
      const rest = text.slice(match.index + match[0].length).replace(/\s+/g, ' ');
      if (!BOUNDING.test(rest)) {
        const line = text.slice(0, match.index).split('\n').length;
        unbounded.push(`${path.relative(TESTS, file).split(path.sep).join('/')}:${line}`);
      }
    }
  }
  assert.deepEqual(unbounded, [], 'a runUntil without bounded(...) can outlive its test and hang the file');
});

test('the guard finds an unbounded nested worker', () => {
  const sample = 'await outer.runUntil(bounded((async () => { await inner.runUntil((async () => {})()); })()));';
  const found = [...sample.matchAll(/\.runUntil\(\s*/g)].filter(
    (m) => !BOUNDING.test(sample.slice(m.index + m[0].length).replace(/\s+/g, ' ')),
  );
  assert.equal(found.length, 1);
});
