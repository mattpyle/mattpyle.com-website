import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCancellable } from '../../src/lib/proc.js';

test('runCancellable keeps stdout and stderr apart, and together in the order they arrived', async () => {
  const script = [
    "process.stdout.write('one\\n');",
    "setTimeout(() => process.stderr.write('two\\n'), 50);",
    "setTimeout(() => { process.stdout.write('three\\n'); process.exitCode = 3; }, 100);",
  ].join(' ');
  const res = await runCancellable(process.execPath, ['-e', script]);
  assert.equal(res.exitCode, 3);
  assert.equal(res.stdout, 'one\nthree\n');
  assert.equal(res.stderr, 'two\n');
  assert.equal(res.output, 'one\ntwo\nthree\n');
});
