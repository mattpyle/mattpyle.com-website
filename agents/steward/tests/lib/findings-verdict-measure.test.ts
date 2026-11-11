import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';
import { writeFindingVerdictMeasure } from '../../src/activities/findings-verdict-measure.js';
import {
  VERDICT_RESOLVED_LINE,
  buildVerdictMeasureSection,
  buildVerificationSection,
  parseFindingsIndex,
  parseVerdictMeasureSection,
  parseVerificationSection,
  setFindingVerdictMeasure,
  setFindingVerification,
  verdictMeasureLine,
  verdictMeasurePassed,
  type VerdictMeasure,
  type Verification,
  type VerificationRow,
} from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';

/**
 * The measurement at the approved verdict (STW-589): the section's text, its
 * place in the file and its read-back, and the one-commit write against the
 * fake GitHub.
 */

const SITE = 'mattpyle-com';
const REPO = 'mattpyle/argus';
const DIR = `sites/${SITE}/findings`;
const FINDING_PATH = `${DIR}/${DEFECT_KEY}.md`;
const INDEX_PATH = `${DIR}/INDEX.md`;
const RUN = `finding/${SITE}/${DEFECT_KEY}`;
const AT = '2026-11-11T09:00:00.000Z';

const FAIL: VerificationRow = { n: 1, url: `${ORIGIN}/llms.txt`, kind: 'status', pass: false, expected: '200', measured: '404' };
const PASS: VerificationRow = { n: 2, url: `${ORIGIN}/scorecard/`, kind: 'text', pass: true, expected: 'no "100/100 (Fail)"', measured: '0 matches' };

const measured = (rows: VerificationRow[]): VerdictMeasure => ({ at: AT, workflowId: RUN, rows, reason: null });
const unmeasured = (reason: string): VerdictMeasure => ({ at: AT, workflowId: RUN, rows: null, reason });
const resolvedAtVerdict = (rows: VerificationRow[]): Verification => ({
  status: 'resolved',
  at: AT,
  workflowId: RUN,
  source: 'finding',
  rows,
  atVerdict: true,
});

let github: FakeGitHub | undefined;
afterEach(() => {
  github?.restore();
  github = undefined;
});

function stage(finding = DEFECT_FINDING): FakeGitHub {
  const index = ['# Findings index', '', `${DEFECT_KEY} | approved | defect | s | title | reason`, ''].join('\n');
  github = installFakeGitHub({ defaultBranch: 'main', seed: { [FINDING_PATH]: finding, [INDEX_PATH]: index } });
  return github;
}
const file = (gh: FakeGitHub, path: string) => gh.branches.get('main')!.get(path)!.text;

test('the section holds each check in the Verification line shape, and reads back', () => {
  const text = buildVerdictMeasureSection(measured([FAIL, PASS]));
  assert.equal(
    text,
    [
      '## Measured at the verdict',
      '',
      `Steward ran this finding's checks against production at ${AT}, at its approved verdict. Workflow \`${RUN}\`.`,
      '',
      `1. Fail, \`status\` on ${ORIGIN}/llms.txt. Expected: 200. Measured: 404.`,
      `2. Pass, \`text\` on ${ORIGIN}/scorecard/. Expected: no "100/100 (Fail)". Measured: 0 matches.`,
    ].join('\n'),
  );
  // The same check lines as the Verification section, so one parser reads both.
  const verification = buildVerificationSection({ ...resolvedAtVerdict([FAIL, PASS]), atVerdict: false });
  assert.ok(verification.includes(text.split('\n')[4]) && verification.includes(text.split('\n')[5]));

  const parsed = parseVerdictMeasureSection(`---\nstatus: approved\n---\n\n# T\n\n${text}\n`);
  assert.deepEqual(parsed, {
    at: AT,
    workflowId: RUN,
    measured: true,
    reason: null,
    checks: [
      { n: 1, pass: false, kind: 'status', url: `${ORIGIN}/llms.txt`, viewport: null, expected: '200', measured: '404' },
      { n: 2, pass: true, kind: 'text', url: `${ORIGIN}/scorecard/`, viewport: null, expected: 'no "100/100 (Fail)"', measured: '0 matches' },
    ],
    unparsed: [],
  });
});

test('an unmeasured finding gets the reason and no check lines', () => {
  const text = buildVerdictMeasureSection(unmeasured('the finding has no checks'));
  assert.equal(
    text,
    `## Measured at the verdict\n\nSteward did not measure this finding at its approved verdict, ${AT}: the finding has no checks. Workflow \`${RUN}\`.`,
  );
  const parsed = parseVerdictMeasureSection(`---\n---\n\n${text}\n`);
  assert.equal(parsed?.measured, false);
  assert.equal(parsed?.reason, 'the finding has no checks');
  assert.equal(parsed?.workflowId, RUN);
  assert.equal(parseVerdictMeasureSection('---\n---\n\n# T\n'), null);
});

test('the status line and the all-pass rule', () => {
  assert.equal(verdictMeasureLine(measured([FAIL, PASS])), 'check 1 of 2 fails on production');
  assert.equal(verdictMeasureLine(measured([PASS])), '1 of 1 checks pass on production');
  assert.equal(verdictMeasureLine(measured([FAIL, { ...FAIL, n: 2 }])), 'checks 1, 2 of 2 fail on production');
  assert.equal(verdictMeasureLine(unmeasured('production did not answer')), 'unmeasured: production did not answer');
  assert.equal(verdictMeasurePassed(measured([PASS])), true);
  assert.equal(verdictMeasurePassed(measured([FAIL, PASS])), false);
  assert.equal(verdictMeasurePassed(unmeasured('no checks')), false);
  // An empty list passes nothing: "all pass" over zero checks is vacuous.
  assert.equal(verdictMeasurePassed(measured([])), false);
});

test('the section goes above a Verification section, and a later measurement replaces it', () => {
  const verified = setFindingVerification(DEFECT_FINDING.replace('status: approved', 'status: fixing'), {
    status: 'reopened',
    at: '2026-11-01T00:00:00.000Z',
    workflowId: 'verify/x',
    source: 'finding',
    rows: [FAIL],
  });
  const first = setFindingVerdictMeasure(verified, measured([FAIL]));
  assert.ok(first.indexOf('## Measured at the verdict') < first.indexOf('## Verification'));
  assert.equal(parseVerificationSection(first)?.outcome, 'reopened', 'the Verification section is untouched');

  const later = setFindingVerdictMeasure(first, { ...measured([PASS]), at: '2026-11-12T00:00:00.000Z' });
  assert.equal(later.match(/## Measured at the verdict/g)?.length, 1);
  assert.equal(parseVerdictMeasureSection(later)?.at, '2026-11-12T00:00:00.000Z');
  assert.ok(later.indexOf('## Measured at the verdict') < later.indexOf('## Verification'));
  assert.doesNotMatch(later, /\n\n\n/, 'no doubled blank lines');

  // With no Verification section it goes at the end, and every other byte stays.
  const plain = setFindingVerdictMeasure(DEFECT_FINDING, measured([FAIL]));
  assert.ok(plain.startsWith(DEFECT_FINDING.trimEnd()));
  assert.ok(plain.endsWith(`${buildVerdictMeasureSection(measured([FAIL]))}\n`));
});

test('a failing check writes the section alone, and the finding stays approved', async () => {
  const gh = stage();
  const written = await writeFindingVerdictMeasure({
    repo: REPO,
    key: DEFECT_KEY,
    findingPath: FINDING_PATH,
    indexPath: INDEX_PATH,
    measure: measured([FAIL]),
  });
  assert.ok(written.commitSha);
  const text = file(gh, FINDING_PATH);
  assert.equal((parseFrontmatter(text).data as Record<string, unknown>).status, 'approved');
  assert.equal(parseVerdictMeasureSection(text)?.checks[0]?.measured, '404');
  assert.equal(parseVerificationSection(text), null);
  assert.equal(parseFindingsIndex(file(gh, INDEX_PATH))[0]?.status, 'approved');

  // A retry of the same write finds it there and writes nothing.
  const again = await writeFindingVerdictMeasure({
    repo: REPO,
    key: DEFECT_KEY,
    findingPath: FINDING_PATH,
    indexPath: INDEX_PATH,
    measure: measured([FAIL]),
  });
  assert.equal(again.commitSha, null);
});

test('every check passing resolves the finding in the same commit, with a Verification section that says so', async () => {
  const gh = stage();
  const input = {
    repo: REPO,
    key: DEFECT_KEY,
    findingPath: FINDING_PATH,
    indexPath: INDEX_PATH,
    measure: measured([PASS]),
    verification: resolvedAtVerdict([PASS]),
  };
  const before = gh.calls.length;
  const written = await writeFindingVerdictMeasure(input);
  assert.ok(written.commitSha);
  assert.equal(gh.calls.slice(before).filter((call) => call.startsWith('PATCH ') && call.includes('/git/refs/')).length, 1, 'one fast-forward');

  const text = file(gh, FINDING_PATH);
  const data = parseFrontmatter(text).data as Record<string, unknown>;
  assert.equal(data.status, 'resolved');
  assert.ok(data.resolved_run, 'resolved_run is set');
  assert.equal(parseVerdictMeasureSection(text)?.checks.length, 1);
  assert.equal(parseVerificationSection(text)?.outcome, 'resolved');
  assert.ok(text.includes(VERDICT_RESOLVED_LINE));
  assert.ok(text.indexOf('## Measured at the verdict') < text.indexOf('## Verification'));
  assert.equal(parseFindingsIndex(file(gh, INDEX_PATH))[0]?.status, 'resolved');

  assert.equal((await writeFindingVerdictMeasure(input)).commitSha, null, 'the retry writes nothing');
});

test('a finding moved while it was measured refuses with FindingMoved', async () => {
  for (const moved of ['status: fixing', 'status: rejected']) {
    stage(DEFECT_FINDING.replace('status: approved', moved));
    await assert.rejects(
      writeFindingVerdictMeasure({ repo: REPO, key: DEFECT_KEY, findingPath: FINDING_PATH, indexPath: INDEX_PATH, measure: measured([FAIL]) }),
      (err: { type?: string; message: string }) => err.type === 'FindingMoved' && /not approved and unresolved/.test(err.message),
    );
    github?.restore();
  }
  // A re-approval of a finding with an earlier run's section is a new write, not a retry.
  const gh = stage(setFindingVerdictMeasure(DEFECT_FINDING, { ...measured([FAIL]), at: '2026-11-01T00:00:00.000Z' }));
  const written = await writeFindingVerdictMeasure({
    repo: REPO,
    key: DEFECT_KEY,
    findingPath: FINDING_PATH,
    indexPath: INDEX_PATH,
    measure: measured([FAIL]),
  });
  assert.ok(written.commitSha);
  assert.equal(parseVerdictMeasureSection(file(gh, FINDING_PATH))?.at, AT);
});
