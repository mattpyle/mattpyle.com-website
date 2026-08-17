import assert from 'node:assert/strict';
import test from 'node:test';
import { statusNote } from '../src/lib/mcp-temporal.mjs';

// The sentence a get_audit status view puts in `note`.
//
// The case worth a test is the one that used to read as a contradiction: since the hosted worker
// runs one activity at a time, a run that is rendering pages can also be waiting for the slot, so
// `queued: true` arrives beside a note saying the audit is rendering. The note now carries both.
//
// The rest of the function is the two fallbacks for a run with no note of its own, pinned here so
// the fix cannot quietly change what a caller with no workflow state is told.

test('a queued run with a note of its own says it is queued and says what it is doing', () => {
  const note = statusNote({
    note: 'rendering 3 page(s) of https://www.mattpyle.com',
    queued: true,
    done: false,
  });

  assert.match(note, /^queued/, 'the wait is the first thing a caller reads');
  assert.match(note, /rendering 3 page\(s\) of https:\/\/www\.mattpyle\.com/, 'the work survives');
});

test('a running run keeps its own note untouched', () => {
  const note = statusNote({
    note: 'rendering 3 page(s) of https://www.mattpyle.com',
    queued: false,
    done: false,
  });

  assert.equal(note, 'rendering 3 page(s) of https://www.mattpyle.com');
});

test('a queued run with no note of its own is told nothing has picked it up', () => {
  const note = statusNote({ queued: true, done: false });

  assert.match(note, /^queued — the audit is started and durable/);
  assert.doesNotMatch(note, /behind another audit/);
});

test('a running run with no note names the busy worker rather than a failure', () => {
  const note = statusNote({ queued: false, done: false });

  assert.match(note, /^running — a worker has this audit in hand/);
});

test('a finished run with no note reports the query error, or says there was no state', () => {
  assert.equal(
    statusNote({ queued: false, done: true, queryError: 'the audit worker did not answer within 4s' }),
    'the audit worker did not answer within 4s',
  );
  assert.match(statusNote({ queued: false, done: true }), /^no state/);
});
