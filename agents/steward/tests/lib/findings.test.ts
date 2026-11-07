import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findingWorkflowId,
  fixCandidates,
  hasParkedDefect,
  isFindingSlug,
  parseFindingWorkflowId,
  parseFindingsIndex,
  pendingActivityLine,
  planReconcile,
  restartCandidates,
  runStateLines,
  type FindingsIndexLine,
  setFrontmatterVerdict,
  setIndexVerdict,
  startsParked,
  waitingReasonLine,
} from '../../src/lib/findings.js';

/** The findings store's pure rules: ID, slug guard, index format, and the reconcile decision. */

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

test('CRLF files keep CRLF', () => {
  const text = '---\r\nstatus: proposed\r\nverdict_reason:\r\nverdict_at:\r\nverdict_source:\r\n---\r\n';
  const out = setFrontmatterVerdict(text, { status: 'approved', reason: 'r', source: 'cli', at: 'T' });
  assert.ok(!/[^\r]\n/.test(out));
});

test('planReconcile starts the proposed without a workflow and signals the decided with one', () => {
  const index = parseFindingsIndex(
    [
      'new-one | proposed | t | ',
      'open-one | proposed | t | ',
      'decided-open | approved | t | Yes.',
      'decided-closed | rejected | t | No.',
      'old | resolved | t | Done.',
    ].join('\n'),
  );
  const open = ['open-one', 'decided-open'].map((k) => findingWorkflowId('s', k));
  const plan = planReconcile('s', index, open);
  assert.deepEqual(plan.start.map((l) => l.key), ['new-one']);
  assert.deepEqual(plan.signal.map((l) => [l.key, l.status, l.reason]), [['decided-open', 'approved', 'Yes.']]);
  assert.equal(plan.unchanged, 3);
});

test('planReconcile sends fix to an approved defect parked at waiting-fix with no attempt, on an auto_fix site only', () => {
  const index = parseFindingsIndex(
    [
      'One line per finding: `key | status | kind | scenario | title | verdict reason`.',
      'parked | approved | defect | s | t | Yes.',
      'opportunity | approved | opportunity | s | t | Yes.',
      'tried-once | approved | defect | s | t | Yes.',
      'in-flight | approved | defect | s | t | Yes.',
      'at-gate | approved | defect | s | t | Yes.',
      'unknown | approved | defect | s | t | Yes.',
    ].join('\n'),
  );
  assert.deepEqual(index.map((l) => l.kind), ['defect', 'opportunity', 'defect', 'defect', 'defect', 'defect']);
  assert.equal(index[0].reason, 'Yes.');
  const run = (key: string, step: string | null, fixAttempts: number | null) => ({
    workflowId: findingWorkflowId('s', key),
    step,
    fixAttempts,
  });
  const open = [
    run('parked', 'waiting-fix', 0),
    run('opportunity', 'waiting-fix', 0),
    run('tried-once', 'waiting-fix', 1),
    run('in-flight', 'waiting-merge', 1),
    run('at-gate', 'waiting-verdict', 0),
    run('unknown', null, null),
  ];
  assert.ok(hasParkedDefect('s', index, open));

  const plan = planReconcile('s', index, open, true);
  assert.deepEqual(plan.fix.map((l) => l.key), ['parked']);
  // A run at the gate, or of unknown step, still gets its verdict, as before.
  assert.deepEqual(plan.signal.map((l) => l.key), ['at-gate', 'unknown']);
  assert.deepEqual(plan.start, []);
  assert.equal(plan.unchanged, 3);

  const noFlag = planReconcile('s', index, open, false);
  assert.deepEqual(noFlag.fix, []);
  assert.equal(noFlag.unchanged, 4);

  // Bare IDs, as a history recorded before steps replays them: no fix, no flag read.
  const bare = open.map((o) => o.workflowId);
  assert.ok(!hasParkedDefect('s', index, bare));
  assert.deepEqual(planReconcile('s', index, bare, true).fix, []);
  assert.equal(planReconcile('s', index, bare, true).signal.length, 6);
});

test('planReconcile with the gate sends fix to any approved parked line the gate accepts and that has no issue', () => {
  const index = parseFindingsIndex(
    [
      'One line per finding: `key | status | kind | scenario | title | verdict reason`.',
      'defect | approved | defect | s | t | Yes.',
      'opportunity | approved | opportunity | s | t | Yes.',
      'refused | approved | opportunity | s | t | Yes.',
      'direction | approved | direction | s | t | Yes.',
      'tried-gate | approved | opportunity | s | t | Yes.',
      'has-issue | approved | defect | s | t | Yes.',
      'in-flight | approved | defect | s | t | Yes.',
      'at-gate | approved | defect | s | t | Yes.',
      'unlisted | approved | defect | s | t | Yes.',
    ].join('\n'),
  );
  const run = (key: string, step: string | null, fixAttempts: number | null, issueUrl: string | null = null) => ({
    workflowId: findingWorkflowId('s', key),
    step,
    fixAttempts,
    issueUrl,
  });
  const open = [
    run('defect', 'waiting-fix', 0),
    run('opportunity', 'waiting-fix', 0),
    run('refused', 'waiting-fix', 0),
    run('direction', 'waiting-fix', 0),
    run('tried-gate', 'waiting-fix', 1),
    run('has-issue', 'waiting-fix', 1, 'https://github.com/o/r/issues/1'),
    run('in-flight', 'waiting-merge', 1, 'https://github.com/o/r/issues/2'),
    run('at-gate', 'waiting-verdict', 0),
  ];
  assert.deepEqual(
    fixCandidates('s', index, open).map((l) => l.key),
    ['defect', 'opportunity', 'refused', 'direction', 'tried-gate'],
    'an issue, a running step or no run takes a line out',
  );

  const accepted = new Set(['defect', 'opportunity', 'tried-gate', 'has-issue', 'in-flight']);
  const plan = planReconcile('s', index, open, true, accepted);
  assert.deepEqual(plan.fix.map((l) => l.key), ['defect', 'opportunity', 'tried-gate']);
  assert.deepEqual(plan.signal.map((l) => l.key), ['at-gate']);
  assert.equal(plan.unchanged, 5);

  assert.deepEqual(planReconcile('s', index, open, false, accepted).fix, [], 'a site without auto_fix');
  assert.deepEqual(planReconcile('s', index, open, true, new Set()).fix, [], 'the gate accepts none');
  // A list recorded before issueUrl existed has none, so such a run counts as having no issue.
  const old = open.map(({ workflowId, step, fixAttempts }) => ({ workflowId, step, fixAttempts }));
  assert.ok(fixCandidates('s', index, old).some((l) => l.key === 'has-issue'));
});

test('planReconcile restarts an approved line with no run when the site has auto_fix and the gate accepts it, and no other line', () => {
  const index = parseFindingsIndex(
    [
      'One line per finding: `key | status | kind | scenario | title | verdict reason`.',
      'idle | approved | opportunity | s | t | Yes.',
      'idle-defect | approved | defect | s | t | Yes.',
      'refused | approved | opportunity | s | t | Yes.',
      'fixing | fixing | defect | s | t | Yes.',
      'rejected | rejected | defect | s | t | No.',
      'proposed | proposed | defect | s | t | ',
      'resolved | resolved | defect | s | t | Yes.',
      'parked | approved | defect | s | t | Yes.',
    ].join('\n'),
  );
  const open = [{ workflowId: findingWorkflowId('s', 'parked'), step: 'waiting-fix', fixAttempts: 0, issueUrl: null }];
  assert.deepEqual(
    restartCandidates('s', index, open).map((l) => l.key),
    ['idle', 'idle-defect', 'refused'],
    'approved with no run, and nothing else',
  );

  const accepted = new Set(['idle', 'idle-defect', 'fixing', 'rejected', 'resolved', 'parked']);
  const plan = planReconcile('s', index, open, true, accepted);
  assert.deepEqual(plan.restart.map((l) => l.key), ['idle', 'idle-defect']);
  assert.deepEqual(plan.fix.map((l) => l.key), ['parked'], 'a parked run still takes fix, not a restart');
  assert.deepEqual(plan.start.map((l) => l.key), ['proposed']);
  assert.equal(plan.unchanged, 4, 'refused, fixing, rejected and resolved');

  assert.deepEqual(planReconcile('s', index, open, false, accepted).restart, [], 'a site without auto_fix');
  assert.deepEqual(planReconcile('s', index, open, true, new Set()).restart, [], 'the gate accepts none');
  assert.deepEqual(planReconcile('s', index, open, true).restart, [], 'no gate read, no restart');
});

test('planReconcile closes a resolved or rejected line whose run waits at waiting-fix, and only with closeParked', () => {
  const index = parseFindingsIndex(
    [
      'One line per finding: `key | status | kind | scenario | title | verdict reason`.',
      'done-parked | resolved | defect | s | t | Verified.',
      'no-go-parked | rejected | direction | s | t | No.',
      'no-go-verdict | rejected | defect | s | t | No.',
      'done-fixing | resolved | defect | s | t | Verified.',
      'done-unknown | resolved | defect | s | t | Verified.',
      'done-no-run | resolved | defect | s | t | Verified.',
      'yes-parked | approved | defect | s | t | Yes.',
      'fixing-parked | fixing | defect | s | t | Yes.',
    ].join('\n'),
  );
  const run = (key: string, step: string | null) => ({ workflowId: findingWorkflowId('s', key), step, fixAttempts: 0, issueUrl: null });
  const open = [
    run('done-parked', 'waiting-fix'),
    run('no-go-parked', 'waiting-fix'),
    run('no-go-verdict', 'waiting-verdict'),
    run('done-fixing', 'waiting-merge'),
    run('done-unknown', null),
    run('yes-parked', 'waiting-fix'),
    run('fixing-parked', 'waiting-fix'),
  ];

  const plan = planReconcile('s', index, open, false, undefined, true);
  assert.deepEqual(plan.close.map((l) => l.key), ['done-parked', 'no-go-parked']);
  assert.deepEqual(plan.signal.map((l) => l.key), ['no-go-verdict'], 'a rejected line at waiting-verdict keeps its signal and is not closed twice');
  assert.deepEqual(plan.fix, []);
  assert.equal(plan.unchanged, 5, 'a run past its fix, an unknown step, no run, an approved parked run, a fixing line');

  const without = planReconcile('s', index, open, false);
  assert.deepEqual(without.close, [], 'a history without the marker closes nothing');
  assert.equal(without.unchanged, 7, 'the parked lines count as unchanged, as they did');
  assert.deepEqual(without.signal.map((l) => l.key), ['no-go-verdict']);
});

test('planReconcile starts a reopened line with no workflow, as it does a proposed one, and leaves one with a workflow', () => {
  const index = parseFindingsIndex(
    ['back | reopened | t | ', 'back-open | reopened | t | ', 'fixing-one | fixing | t | Yes.'].join('\n'),
  );
  const plan = planReconcile('s', index, [findingWorkflowId('s', 'back-open')]);
  assert.deepEqual(plan.start.map((l) => [l.key, l.status]), [['back', 'reopened']]);
  assert.deepEqual(plan.signal, []);
  assert.equal(plan.unchanged, 2);
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

test('a started run parks without the automatic attempt when its line names a kind other than defect', () => {
  const line = (kind: string): FindingsIndexLine => ({ key: 'k', status: 'proposed', kind, reason: '', lineNumber: 0, columns: [] });
  assert.equal(startsParked(line('direction')), true);
  assert.equal(startsParked(line('opportunity')), false, 'it attempts at the verdict and the gate decides');
  assert.equal(startsParked(line('defect')), false);
  assert.equal(startsParked(line('')), false, 'an index with no kind column starts as it always did');
});

test('a running run reads as open, and any status the server has not closed reads the same', () => {
  assert.deepEqual(runStateLines({ status: 'RUNNING' }), { closed: false, lines: ['run: open'] });
  assert.deepEqual(runStateLines({ status: 'UNKNOWN' }), { closed: false, lines: ['run: open'] });
});

test('a closed run says how and when it ended, and a failure is one line', () => {
  const closeTime = new Date('2026-10-15T17:30:00.000Z');
  assert.deepEqual(runStateLines({ status: 'CANCELLED', closeTime, failure: 'Workflow' + String.fromCharCode(10) + 'canceled  by the reconciler' }), {
    closed: true,
    lines: ['run: cancelled at 2026-10-15T17:30:00.000Z', 'failure: Workflow canceled by the reconciler'],
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

