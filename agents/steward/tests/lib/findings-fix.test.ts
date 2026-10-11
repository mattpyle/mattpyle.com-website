import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findingHandoffPath,
  fixBranch,
  fixRefusal,
  fixWorkflowId,
  parseFindingBody,
  setFrontmatterFix,
  setIndexStatus,
} from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { DEFECT_FINDING, DEFECT_KEY, OPPORTUNITY_FINDING } from '../helpers/finding-fixtures.js';

/** The fixer's pure rules: its names, what it reads out of a finding, what it refuses, and its two line edits. */

const data = (text: string) => parseFrontmatter(text).data as Record<string, unknown>;

test('the fixer has its own workflow ID, handoff path and branch prefix', () => {
  assert.equal(fixWorkflowId('mattpyle-com', 'ux-a--about'), 'fix/mattpyle-com/ux-a--about');
  assert.equal(findingHandoffPath('mattpyle-com', 'ux-a--about'), 'sites/mattpyle-com/handoffs/ux-a--about.md');
  assert.equal(fixBranch('ux-a--about'), 'fix/finding-ux-a--about');
});

test('a defect is read as its line, its evidence, its cause and its measure', () => {
  const parsed = parseFindingBody(DEFECT_FINDING.replace(/\n/g, '\r\n'));
  assert.match(parsed.title, /^\/scorecard's run history says "Accessibility: 100\/100 \(Fail\)"/);
  assert.deepEqual(
    parsed.evidence.map((b) => b.label),
    ['URL', 'Viewport and appearance', 'What they did', 'What happened', 'Expected', 'Artifact'],
  );
  // Argus hard-wraps; a wrapped bullet is one line here.
  assert.equal(
    parsed.cause,
    '`agents/steward/src/workflows/scorecard-audit.ts` line 558, `buildCommentary()` formats every non-passing gate as `${m.name}: ${m.value}/${m.maximum} (${m.status})` and never uses `m.description`.',
  );
  assert.equal(
    parsed.measure,
    'A future run whose gate fails on axe violations shows the violation count in its row, not "100/100 (Fail)". Checkable in a unit test of `buildCommentary`.',
  );
  assert.ok(parsed.sections['what would serve them'].startsWith('Build the commentary'));
});

test('a finding with no cause bullet is read with a null cause', () => {
  const parsed = parseFindingBody(OPPORTUNITY_FINDING);
  assert.equal(parsed.cause, null);
  assert.equal(parsed.evidence.length, 3);
  assert.match(parsed.measure ?? '', /^The feed URL renders/);
});

test('the fixer takes an approved defect with a cause and a measure, and names why it refuses anything else', () => {
  const defect = parseFindingBody(DEFECT_FINDING);
  assert.equal(fixRefusal(data(DEFECT_FINDING), defect), null);
  assert.match(fixRefusal({ ...data(DEFECT_FINDING), status: 'proposed' }, defect) ?? '', /status is proposed, not approved/);
  assert.match(fixRefusal({ ...data(DEFECT_FINDING), status: 'fixing' }, defect) ?? '', /status is fixing/);
  assert.match(fixRefusal(data(OPPORTUNITY_FINDING), parseFindingBody(OPPORTUNITY_FINDING)) ?? '', /kind is opportunity, not defect/);
  assert.match(fixRefusal({ status: 'approved' }, defect) ?? '', /kind is unset/);
  assert.match(fixRefusal(data(DEFECT_FINDING), { ...defect, cause: null }) ?? '', /names no cause/);
  assert.match(fixRefusal(data(DEFECT_FINDING), { ...defect, measure: null }) ?? '', /no "How to measure"/);
});

const PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/312';

test('the fix edit sets status and adds links.pr, and every other line is byte-identical', () => {
  const edited = setFrontmatterFix(DEFECT_FINDING, PR);
  const read = data(edited) as { status: string; links: { pr: string }; verdict_reason: string };
  assert.equal(read.status, 'fixing');
  assert.deepEqual(read.links, { pr: PR });
  assert.equal(read.verdict_reason, 'Approved by Matt via steward finding approve.');

  const before = DEFECT_FINDING.split('\n');
  const after = edited.split('\n');
  assert.deepEqual(after.filter((line) => !before.includes(line)), ['status: fixing', 'links:', `  pr: ${PR}`]);
  assert.deepEqual(before.filter((line) => !after.includes(line)), ['status: approved']);
  assert.equal(after[after.indexOf('links:') + 2], '---', 'links is the last field of the block');
});

test('the fix edit is idempotent, replaces an older PR, and keeps the other links', () => {
  const once = setFrontmatterFix(DEFECT_FINDING, PR);
  assert.equal(setFrontmatterFix(once, PR), once);
  assert.deepEqual((data(setFrontmatterFix(once, `${PR}0`)) as any).links, { pr: `${PR}0` });

  const withComment = data(setFrontmatterFix(OPPORTUNITY_FINDING, PR)) as any;
  assert.deepEqual(withComment.links, { pr: PR, comment: 'https://example.com/c/1' });

  const empty = setFrontmatterFix(DEFECT_FINDING.replace('references: []', 'links: {}\nreferences: []'), PR);
  assert.deepEqual((data(empty) as any).links, { pr: PR });
});

test('the fix edit keeps CRLF and refuses a file it cannot edit safely', () => {
  const crlf = setFrontmatterFix(DEFECT_FINDING.replace(/\n/g, '\r\n'), PR);
  assert.ok(!/[^\r]\n/.test(crlf));
  assert.throws(() => setFrontmatterFix('# No frontmatter\n', PR), /no frontmatter block/);
  assert.throws(() => setFrontmatterFix('---\nkey: x\n---\n', PR), /no status field/);
  assert.throws(() => setFrontmatterFix('---\nstatus: approved\nlinks: [a]\n---\n', PR), /not a block mapping/);
});

const INDEX = [
  '# Findings index',
  '',
  'One line per finding, maintained by Argus: `key | status | kind | scenario | title | verdict reason`.',
  '',
  'ux-a--about | approved | opportunity | recruiter | A title | Fair finding.',
  `${DEFECT_KEY} | approved | defect | defect-hunt | A row reads "100/100 (Fail)" | Approved by Matt via steward finding approve.`,
  '',
].join('\n');

test('the index edit changes one status and keeps the verdict reason and every other line', () => {
  const edited = setIndexStatus(INDEX, DEFECT_KEY, 'fixing').split('\n');
  assert.equal(
    edited[5],
    `${DEFECT_KEY} | fixing | defect | defect-hunt | A row reads "100/100 (Fail)" | Approved by Matt via steward finding approve.`,
  );
  const before = INDEX.split('\n');
  assert.deepEqual(edited.filter((_, i) => i !== 5), before.filter((_, i) => i !== 5));
  assert.equal(setIndexStatus(edited.join('\n'), DEFECT_KEY, 'fixing'), edited.join('\n'));
  assert.throws(() => setIndexStatus(INDEX, 'not-there', 'fixing'), /no line for not-there/);
});
