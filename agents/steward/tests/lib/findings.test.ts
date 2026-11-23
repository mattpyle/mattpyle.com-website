import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINDING_VERDICT_SOURCES,
  findingWorkflowId,
  isFindingSlug,
  isFindingVerdict,
  parseFindingWorkflowId,
  parseFindingsIndex,
  pendingActivityLine,
  runStateLines,
  setFrontmatterVerdict,
  setIndexVerdict,
  verdictSourceWrites,
  waitingReasonLine,
} from '../../src/lib/findings.js';

/** The findings store's pure rules: ID, slug guard, index format, and the status lines. */

test('the workflow ID round-trips and refuses anything else', () => {
  const id = findingWorkflowId('mattpyle-com', 'ux-a--about');
  assert.equal(id, 'finding/mattpyle-com/ux-a--about');
  assert.deepEqual(parseFindingWorkflowId(id), { site: 'mattpyle-com', key: 'ux-a--about' });
  assert.equal(parseFindingWorkflowId('steward-scorecard-scheduled-2026'), undefined);
  assert.equal(parseFindingWorkflowId('finding/../x'), undefined);
});

test('a slug is lower case letters, digits and hyphens, and nothing that traverses', () => {
  for (const ok of ['mattpyle-com', 'content-x--changelog', 'a1']) assert.ok(isFindingSlug(ok), ok);
  for (const bad of ['', '../x', 'a/b', 'A', '-a', 'a-', 'a.md', 'a b']) assert.ok(!isFindingSlug(bad), bad);
});

test('a kind column added before the reason moves the reason with the format line', () => {
  const text = [
    'Format: `key | status | kind | title | verdict reason`.',
    'k-one | approved | bug | Title | Because.',
  ].join('\n');
  const [line] = parseFindingsIndex(text);
  assert.equal(line.reason, 'Because.');
  assert.equal(
    setIndexVerdict(text, 'k-one', 'rejected', 'No | really').split('\n')[1],
    'k-one | rejected | bug | Title | No / really',
  );
});

test('a frontmatter block missing a verdict field gets it added before the close', () => {
  const text = '---\nkey: k\nstatus: proposed\n---\nbody\n';
  const out = setFrontmatterVerdict(text, { status: 'approved', reason: 'ok: yes', source: 'file', at: 'T' });
  assert.equal(
    out,
    '---\nkey: k\nstatus: approved\nverdict_reason: "ok: yes"\nverdict_at: T\nverdict_source: file\n---\nbody\n',
  );
});

test('a discord verdict is written with its own source, and an unknown source is not a verdict', () => {
  const text = '---\nstatus: proposed\nverdict_source:\n---\n';
  const out = setFrontmatterVerdict(text, { status: 'rejected', reason: 'No.', source: 'discord', at: 'T' });
  assert.equal(out, '---\nstatus: rejected\nverdict_source: discord\nverdict_reason: "No."\nverdict_at: T\n---\n');

  const verdict = { status: 'approved', reason: '', at: 'T' };
  assert.deepEqual(FINDING_VERDICT_SOURCES, ['cli', 'discord', 'file']);
  for (const source of FINDING_VERDICT_SOURCES) assert.ok(isFindingVerdict({ ...verdict, source }), source);
  for (const source of ['console', 'Discord', '', undefined, null, 1]) assert.ok(!isFindingVerdict({ ...verdict, source }), String(source));
  assert.ok(!isFindingVerdict({ ...verdict, source: 'discord', status: 'maybe' }));
  assert.ok(!isFindingVerdict(null));

  // Only a verdict that is already in the file is left unwritten.
  assert.deepEqual(FINDING_VERDICT_SOURCES.filter(verdictSourceWrites), ['cli', 'discord']);
});

test('CRLF files keep CRLF', () => {
  const text = '---\r\nstatus: proposed\r\nverdict_reason:\r\nverdict_at:\r\nverdict_source:\r\n---\r\n';
  const out = setFrontmatterVerdict(text, { status: 'approved', reason: 'r', source: 'cli', at: 'T' });
  assert.ok(!/[^\r]\n/.test(out));
});

test('a retrying activity is one line: the type, the attempt and the last failure', () => {
  assert.equal(pendingActivityLine({ activityType: { name: 'awaitFixPrMerge' }, attempt: 1 }), null, 'a first attempt has nothing to say');
  assert.equal(
    pendingActivityLine({
      activityType: { name: 'awaitFixPrMerge' },
      attempt: 7,
      lastFailure: { message: 'GitHub rejected the credential (401): Bad credentials.' },
    }),
    'awaitFixPrMerge attempt 7: GitHub rejected the credential (401): Bad credentials.',
  );
  assert.equal(pendingActivityLine({ activityType: { name: 'awaitFixPr' }, attempt: 3, lastFailure: null }), 'awaitFixPr attempt 3');
  assert.equal(pendingActivityLine({ attempt: 4 }), null, 'no type, no line');
});

test('a run parked for its kind says so in `steward finding status`, and no other run does', () => {
  assert.equal(waitingReasonLine({ waitsForPerson: true }), 'waits for a person: kind is not defect, so no fix was attempted');
  assert.equal(waitingReasonLine({ waitsForPerson: false }), null, 'cleared once a fix signal arrives');
  assert.equal(waitingReasonLine({}), null, 'a run recorded before the field');
});

test('a running run reads as open, and any status the server has not closed reads the same', () => {
  assert.deepEqual(runStateLines({ status: 'RUNNING' }), { closed: false, lines: ['run: open'] });
  assert.deepEqual(runStateLines({ status: 'UNKNOWN' }), { closed: false, lines: ['run: open'] });
});

test('a closed run says how and when it ended, and a failure is one line', () => {
  const closeTime = new Date('2026-10-15T17:30:00.000Z');
  assert.deepEqual(runStateLines({ status: 'CANCELLED', closeTime, failure: 'Workflow' + String.fromCharCode(10) + 'canceled  by a person' }), {
    closed: true,
    lines: ['run: cancelled at 2026-10-15T17:30:00.000Z', 'failure: Workflow canceled by a person'],
  });
  for (const [status, label] of [['FAILED', 'failed'], ['TERMINATED', 'terminated'], ['TIMED_OUT', 'timed out']] as const) {
    assert.equal(runStateLines({ status, closeTime }).lines[0], `run: ${label} at 2026-10-15T17:30:00.000Z`, status);
  }
});

test('a completed run prints its outcome, the verify workflow where there is one, and verdict for an older result', () => {
  const closeTime = new Date('2026-11-01T00:00:00.000Z');
  const resolved = runStateLines({ status: 'COMPLETED', closeTime, result: { outcome: 'resolved', verifyWorkflowId: 'verify/mattpyle-com/k' } });
  assert.deepEqual(resolved.lines, ['run: completed at 2026-11-01T00:00:00.000Z', 'outcome: resolved (verify verify/mattpyle-com/k)']);
  assert.equal(runStateLines({ status: 'COMPLETED', closeTime, result: { outcome: 'rejected' } }).lines[1], 'outcome: rejected');
  assert.equal(runStateLines({ status: 'COMPLETED', closeTime, result: {} }).lines[1], 'outcome: verdict');
  assert.equal(runStateLines({ status: 'COMPLETED', closeTime }).lines.length, 1, 'no result read, no outcome line');
});
