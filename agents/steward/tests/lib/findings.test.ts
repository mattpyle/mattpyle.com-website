import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findingWorkflowId,
  isFindingSlug,
  parseFindingWorkflowId,
  parseFindingsIndex,
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
