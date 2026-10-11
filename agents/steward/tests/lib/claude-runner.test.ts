import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, type ClaudeRunOptions } from '../../src/lib/claude-runner.js';

/**
 * The runner against a stub process in Claude Code's place: the four ways a
 * run ends that the spike's one live run never reached. No model is called.
 *
 * Each early end has to do two things, and both are asserted: name itself in
 * the outcome, and take the process down, so the promise resolves well inside
 * the test's own timeout rather than when the stub would have exited (never).
 */

const STUB = fileURLToPath(new URL('../fixtures/claude-stub.mjs', import.meta.url));

function options(mode: string, overrides: Partial<ClaudeRunOptions> = {}, extra: string[] = []): ClaudeRunOptions {
  return {
    command: process.execPath,
    argv: [STUB, mode, ...extra],
    cwd: os.tmpdir(),
    env: process.env,
    signal: new AbortController().signal,
    timeoutMs: 20_000,
    stallMs: 20_000,
    ...overrides,
  };
}

test('a finished run: exit 0, the result folded in, nothing flagged', { timeout: 30_000 }, async () => {
  const seen: string[] = [];
  const run = await runClaude(options('ok', { onActivity: (a) => seen.push(a) }));
  assert.equal(run.exitCode, 0);
  assert.deepEqual([run.cancelled, run.timedOut, run.stalled], [false, false, false]);
  assert.equal(run.state.finalMessage, 'Done.');
  assert.equal(run.state.numTurns, 3);
  assert.equal(run.state.model, 'stub-model');
  assert.ok(seen.includes('Bash npm test'), 'the heartbeat was told the tool call');
});

test('the kill at the time limit: a run that never stops is stopped and says timedOut', { timeout: 30_000 }, async () => {
  const started = Date.now();
  const run = await runClaude(options('busy', { timeoutMs: 700 }));
  assert.equal(run.timedOut, true);
  assert.deepEqual([run.cancelled, run.stalled], [false, false]);
  assert.notEqual(run.exitCode, 0);
  assert.equal(run.state.finalMessage, null, 'no result event arrived');
  assert.equal(run.state.lastActivity, 'Bash npm run build');
  assert.ok(Date.now() - started < 15_000, 'the process tree went down with the deadline');
});

test('cancellation mid-turn: the abort kills the run and says cancelled', { timeout: 30_000 }, async () => {
  const controller = new AbortController();
  let aborted = false;
  const run = await runClaude(
    options('busy', {
      signal: controller.signal,
      onActivity: () => {
        // Mid-turn: the first tool call is already on the stream.
        if (!aborted) {
          aborted = true;
          controller.abort();
        }
      },
    }),
  );
  assert.equal(run.cancelled, true);
  assert.deepEqual([run.timedOut, run.stalled], [false, false]);
  assert.notEqual(run.exitCode, 0);
});

test('a signal that is already aborted stops the run at once', { timeout: 30_000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  const run = await runClaude(options('busy', { signal: controller.signal }));
  assert.equal(run.cancelled, true);
});

test('a stalled run: no output for the stall limit stops it and says stalled, not timedOut', { timeout: 30_000 }, async () => {
  const run = await runClaude(options('silent', { stallMs: 700 }));
  assert.equal(run.stalled, true);
  assert.deepEqual([run.cancelled, run.timedOut], [false, false]);
  assert.equal(run.state.lastActivity, 'Bash npm run a11y', 'the outcome says where it went quiet');
});

test('output resets the stall clock: a busy run outlives the stall limit', { timeout: 30_000 }, async () => {
  // Events every 50ms against a 700ms stall limit, for 2s: only the deadline ends it.
  const run = await runClaude(options('busy', { stallMs: 700, timeoutMs: 2_000 }));
  assert.equal(run.stalled, false);
  assert.equal(run.timedOut, true);
});

test('a non-zero exit with changes present: the exit code and the stderr tail come back, the change stays', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-stub-'));
  const file = path.join(dir, 'changed.txt');
  try {
    const run = await runClaude(options('exit1', {}, [file]));
    assert.equal(run.exitCode, 1);
    assert.deepEqual([run.cancelled, run.timedOut, run.stalled], [false, false, false]);
    assert.equal(run.state.finalMessage, null);
    assert.match(run.stderrTail, /overloaded/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'half a fix\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
