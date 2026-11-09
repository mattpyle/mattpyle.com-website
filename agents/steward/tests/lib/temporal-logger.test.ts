import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import pino from 'pino';
import { bridgeLogEntry, temporalLogger } from '../../src/lib/temporal-logger.js';

/**
 * The bridge from the Temporal Runtime logger to pino (STW-549). Tested on the
 * function and a pino instance writing to a buffer; `Runtime.install` itself
 * runs once per process in the worker entry points and is not called here,
 * because the test environment installs a Runtime of its own.
 */

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      done();
    },
  });
  return { lines, sink: pino({ level: 'trace' }, stream) };
}

test('a workflow log entry becomes one JSON line with the SDK metadata on it', () => {
  const { lines, sink } = capture();
  bridgeLogEntry(
    {
      level: 'INFO',
      message: 'Findings recheck of temporal-io: 23 approved, resolved 1.',
      timestampNanos: 1n,
      meta: { sdkComponent: 'workflow', workflowId: 'recheck/temporal-io/x', runId: 'r1', taskQueue: 'steward-findings' },
    },
    sink,
  );
  assert.equal(lines.length, 1, 'one entry is one line');
  const line = JSON.parse(lines[0]!);
  assert.equal(line.level, 30, 'pino info');
  assert.equal(line.msg, 'Findings recheck of temporal-io: 23 approved, resolved 1.');
  assert.equal(line.sdkComponent, 'workflow');
  assert.equal(line.workflowId, 'recheck/temporal-io/x');
  assert.equal(line.runId, 'r1');
  assert.equal(line.taskQueue, 'steward-findings');
});

test('an activity entry keeps its activity metadata', () => {
  const { lines, sink } = capture();
  bridgeLogEntry(
    { level: 'WARN', message: 'Activity failed', timestampNanos: 1n, meta: { sdkComponent: 'activity', activityType: 'writeFindingRecheck', attempt: 2 } },
    sink,
  );
  const line = JSON.parse(lines[0]!);
  assert.equal(line.level, 40, 'pino warn');
  assert.equal(line.activityType, 'writeFindingRecheck');
  assert.equal(line.attempt, 2);
});

test('each SDK level maps to the pino level of the same name', () => {
  const { lines, sink } = capture();
  for (const level of ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as const) {
    bridgeLogEntry({ level, message: level, timestampNanos: 1n }, sink);
  }
  assert.deepEqual(lines.map((line) => JSON.parse(line).level), [10, 20, 30, 40, 50]);
});

test('an entry with no metadata is a line with a message', () => {
  const { lines, sink } = capture();
  bridgeLogEntry({ level: 'INFO', message: 'bare', timestampNanos: 1n }, sink);
  assert.equal(JSON.parse(lines[0]!).msg, 'bare');
});

test('the Runtime logger passes INFO and above and drops DEBUG', () => {
  const { lines, sink } = capture();
  const logger = temporalLogger(sink);
  logger.debug('below the floor', { sdkComponent: 'worker' });
  logger.info('Worker state changed', { sdkComponent: 'worker', state: 'RUNNING' });
  logger.error('boom', { sdkComponent: 'worker' });
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(parsed.map((line) => line.msg), ['Worker state changed', 'boom']);
  assert.equal(parsed[0].state, 'RUNNING');
});
