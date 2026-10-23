import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findingWorkflowId,
  hasParkedDefect,
  isFindingSlug,
  parseFindingWorkflowId,
  parseFindingsIndex,
  pendingActivityLine,
  planReconcile,
  setFrontmatterVerdict,
  setIndexVerdict,
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
