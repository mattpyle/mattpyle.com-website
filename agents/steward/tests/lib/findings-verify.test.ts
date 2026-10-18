import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVerificationSection,
  parseFindingsIndex,
  parsePrUrl,
  planReconcile,
  setFindingVerification,
  setIndexStatus,
  verifyRefusal,
  verifyRunId,
  verifySourceLabel,
  verifyStamp,
  verifyWorkflowId,
  type Verification,
} from '../../src/lib/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { DEFECT_KEY, FIXING_FINDING, FIX_PR } from '../helpers/finding-fixtures.js';

/** The verifier's pure rules: the ID, the gate, the two statuses and the edit that writes a result. */

const AT = '2026-10-13T04:12:33.527Z';
const FIXING = FIXING_FINDING;

const ROWS: Verification['rows'] = [
  {
    n: 1,
    url: 'https://www.mattpyle.com/',
    kind: 'selector',
    pass: true,
    expected: '"footer nav" has aria-label="Footer"',
    measured: '"Footer"',
  },
  {
    n: 2,
    url: 'https://www.mattpyle.com/about/',
    kind: 'text',
    pass: false,
    expected: '0 occurrences of "Social links"',
    measured: '1 occurrences',
  },
];

const verification = (status: Verification['status'], rows = ROWS): Verification => ({
  status,
  at: AT,
  workflowId: verifyWorkflowId('mattpyle-com', DEFECT_KEY, AT),
  source: 'finding',
  rows,
});

test('a verify run has its own workflow ID, stamped to the second, and a run ID in the shape Argus uses', () => {
  assert.equal(verifyStamp(AT), '2026-10-13T041233Z');
  assert.equal(verifyRunId(AT), '2026-10-13T0412Z');
  assert.equal(verifyWorkflowId('mattpyle-com', 'ux-a--about', AT), 'verify/mattpyle-com/ux-a--about/2026-10-13T041233Z');
  assert.equal(verifyStamp('2026-10-13T04:12:33Z'), '2026-10-13T041233Z', 'an instant with no milliseconds too');
});

test('the verifier takes fixing and reopened findings and names why it refuses any other', () => {
  assert.equal(verifyRefusal({ status: 'fixing', links: { pr: FIX_PR } }), null);
  assert.equal(verifyRefusal({ status: 'reopened', links: { pr: FIX_PR } }), null);
  assert.equal(verifyRefusal({ status: 'reopened' }), 'it has no links.pr to a pull request');
  assert.equal(verifyRefusal({ status: 'fixing' }), 'it has no links.pr to a pull request');
  assert.equal(verifyRefusal({ status: 'fixing', links: { pr: 'https://example.com/pull/1' } }), 'it has no links.pr to a pull request');
  assert.deepEqual(parsePrUrl(FIX_PR), { repo: 'mattpyle/mattpyle.com-website', number: 312 });
  assert.equal(parsePrUrl(`${FIX_PR}/files`), null);
  for (const status of ['approved', 'resolved', 'proposed', 'rejected']) {
    assert.equal(verifyRefusal({ status, links: { pr: FIX_PR } }), `its status is ${status}, not fixing or reopened`);
  }
  assert.match(verifyRefusal({})!, /unset/);
});

test('resolved and reopened are statuses the index parser reads; the reconciler leaves resolved alone and starts a reopened one', () => {
  const index = parseFindingsIndex(
    ['fixed-one | resolved | defect | s | Title | Approved.', 'back-one | reopened | defect | s | Title | Approved.'].join('\n'),
  );
  assert.deepEqual(index.map((line) => [line.key, line.status]), [
    ['fixed-one', 'resolved'],
    ['back-one', 'reopened'],
  ]);
  // With a workflow open for each, neither is started, signalled or sent a fix.
  assert.deepEqual(
    planReconcile('mattpyle-com', index, ['finding/mattpyle-com/fixed-one', 'finding/mattpyle-com/back-one'], true),
    { start: [], signal: [], fix: [], unchanged: 2 },
  );
  // With none, the reopened one goes back to the gate (design decision 29); resolved stays.
  const none = planReconcile('mattpyle-com', index, []);
  assert.deepEqual(none.start.map((line) => line.key), ['back-one']);
  assert.equal(none.unchanged, 1);
  assert.equal(
    setIndexStatus('back-one | fixing | defect | s | Title | Approved.', 'back-one', 'reopened'),
    'back-one | reopened | defect | s | Title | Approved.',
  );
});

test('a pass writes resolved, resolved_run and the section, and every other line is byte-identical', () => {
  const out = setFindingVerification(FIXING, verification('resolved', [ROWS[0]]));
  const { data } = parseFrontmatter(out);
  assert.equal(data.status, 'resolved');
  assert.equal(data.resolved_run, '2026-10-13T0412Z');

  const before = FIXING.split('\n');
  const after = out.split('\n');
  const changed = before.filter((line, i) => line !== after[i]);
  assert.deepEqual(changed.slice(0, 2), ['status: fixing', 'resolved_run:'], 'only the two fields change above the section');
  assert.deepEqual(after.slice(before.length), [
    '## Verification',
    '',
    `Steward ran this finding's checks against production at ${AT}. Outcome: resolved. Workflow \`verify/mattpyle-com/${DEFECT_KEY}/2026-10-13T041233Z\`.`,
    '',
    'Checks from: finding.',
    '',
    '1. Pass, `selector` on https://www.mattpyle.com/. Expected: "footer nav" has aria-label="Footer". Measured: "Footer".',
    '',
  ]);
});

test('the section names where the checks came from, and a fallback says so', () => {
  assert.equal(verifySourceLabel('finding'), 'finding');
  assert.equal(verifySourceLabel('handoff'), 'handoff (fallback)');
  assert.equal(verifySourceLabel('generated'), 'generated (fallback)');
  assert.match(setFindingVerification(FIXING, { ...verification('resolved'), source: 'handoff' }), /\n\nChecks from: handoff \(fallback\)\.\n\n1\. /);
});

test('a fail writes reopened with the expected and the measured value, and leaves resolved_run empty', () => {
  const out = setFindingVerification(FIXING, verification('reopened'));
  const { data } = parseFrontmatter(out);
  assert.equal(data.status, 'reopened');
  assert.equal(data.resolved_run, null);
  assert.match(out, /Outcome: reopened\./);
  assert.match(out, /2\. Fail, `text` on https:\/\/www\.mattpyle\.com\/about\/\. Expected: 0 occurrences of "Social links"\. Measured: 1 occurrences\./);
  assert.match(out, /1\. Pass, `selector`/);
});

test('a second result replaces the first section, and the same result twice changes nothing', () => {
  const reopened = setFindingVerification(FIXING, verification('reopened'));
  assert.equal(setFindingVerification(reopened, verification('reopened')), reopened);

  const later: Verification = { ...verification('resolved', [ROWS[0]]), at: '2026-10-14T05:00:00.000Z' };
  const resolved = setFindingVerification(reopened.replace('status: reopened', 'status: fixing'), later);
  assert.equal(resolved.match(/^## Verification$/gm)?.length, 1);
  assert.doesNotMatch(resolved, /Outcome: reopened/);
  assert.equal(parseFrontmatter(resolved).data.resolved_run, '2026-10-14T0500Z');
});

test('the section keeps a later section Argus appended, and the edit keeps CRLF', () => {
  const withRecheck = `${setFindingVerification(FIXING, verification('reopened'))}\n## Re-check 2026-10-14T0730Z\n\n- Outcome: still open\n`;
  const out = setFindingVerification(withRecheck.replace('status: reopened', 'status: fixing'), verification('resolved', [ROWS[0]]));
  assert.match(out, /## Re-check 2026-10-14T0730Z\n\n- Outcome: still open\n\n## Verification\n/);

  const crlf = setFindingVerification(FIXING.replace(/\n/g, '\r\n'), verification('resolved'));
  assert.ok(!/[^\r]\n/.test(crlf));
  assert.throws(() => setFindingVerification('# no frontmatter\n', verification('resolved')), /no frontmatter block/);
  assert.throws(() => setFindingVerification('---\nkey: k\n---\nbody\n', verification('resolved')), /no status field/);
});

test('a browser check names the viewport it ran at, and a fetch check names none', () => {
  const rows: Verification['rows'] = [{ ...ROWS[0], kind: 'js', viewport: '390x844' }, ROWS[1]];
  const section = buildVerificationSection(verification('resolved', rows));
  assert.match(section, /\n1\. Pass, `js` on https:\/\/www\.mattpyle\.com\/ at 390x844\. Expected: /);
  assert.match(section, /\n2\. Fail, `text` on https:\/\/www\.mattpyle\.com\/about\/\. Expected: /);
});

test('a list check names its count and every URL, and the failed URLs in its measured value', () => {
  const urls = ['https://www.mattpyle.com/writing/a/', 'https://www.mattpyle.com/writing/b/'];
  const row = { n: 1, url: urls, kind: 'header', pass: false, expected: 'link contains "text/markdown"', measured: `1 of 2 pass; failed: ${urls[1]} (absent)` };
  assert.ok(
    buildVerificationSection(verification('reopened', [row])).includes(
      `1. Fail, \`header\` on 2 URLs (${urls.join(', ')}). Expected: link contains "text/markdown". Measured: 1 of 2 pass; failed: ${urls[1]} (absent).`,
    ),
  );
});

test('a finding with no resolved_run field gets one, inside the frontmatter', () => {
  const out = setFindingVerification('---\nkey: k\nstatus: fixing\n---\n\n# Title\n', verification('resolved', [ROWS[0]]));
  assert.ok(out.startsWith('---\nkey: k\nstatus: resolved\nresolved_run: 2026-10-13T0412Z\n---\n\n# Title\n\n## Verification\n'));
  assert.match(buildVerificationSection(verification('resolved', [ROWS[0]])), /^## Verification\n\nSteward ran/);
});

const DEPLOY = { prUrl: FIX_PR, mergeSha: 'a'.repeat(40), liveSha: 'b'.repeat(40) };

test('a deploy-resolved finding is resolved_by deploy, and its section has no rows and names the PR, the merge and the live commit', () => {
  const out = setFindingVerification(FIXING, { ...verification('resolved', []), deploy: DEPLOY });
  const { data } = parseFrontmatter(out);
  assert.equal(data.status, 'resolved');
  assert.equal(data.resolved_run, '2026-10-13T0412Z');
  assert.equal(data.resolved_by, 'deploy');
  assert.match(out, /\nresolved_run: 2026-10-13T0412Z\nresolved_by: deploy\n/);
  const before = FIXING.split('\n');
  assert.deepEqual(out.split('\n').slice(before.length + 1), [
    '## Verification',
    '',
    `Steward confirmed this finding's fix by its deploy at ${AT}. Outcome: confirmed. Workflow \`verify/mattpyle-com/${DEFECT_KEY}/2026-10-13T041233Z\`.`,
    '',
    `No check could measure the fix: the finding has no verify block. ${FIX_PR} merged as \`${DEPLOY.mergeSha}\`, and production serves \`${DEPLOY.liveSha}\`, which contains it.`,
    '',
  ]);
});

test('a measured result drops an earlier resolved_by, and a measured resolved never writes one', () => {
  const deployed = setFindingVerification(FIXING, { ...verification('resolved', []), deploy: DEPLOY });
  const reopened = setFindingVerification(deployed.replace('status: resolved', 'status: fixing'), verification('reopened'));
  assert.equal(parseFrontmatter(reopened).data.resolved_by, undefined);
  assert.equal(reopened.match(/^resolved_by:/gm), null);
  assert.equal(setFindingVerification(FIXING, verification('resolved', [ROWS[0]])).match(/^resolved_by:/gm), null);
  // The same deploy result twice is one line, not two.
  const again = setFindingVerification(deployed, { ...verification('resolved', []), deploy: DEPLOY });
  assert.equal(again, deployed);
});

test('--reason adds one line attributed to the CLI, after the rows or the deploy sentence', () => {
  const measured = buildVerificationSection({ ...verification('resolved', [ROWS[0]]), reason: 'Read the footer by hand.' });
  assert.match(measured, /Measured: "Footer"\.\n\nFrom the CLI: Read the footer by hand\.$/);
  const deployed = buildVerificationSection({ ...verification('resolved', []), deploy: DEPLOY, reason: 'Fixed by PR 356 outside the run.' });
  assert.match(deployed, /which contains it\.\n\nFrom the CLI: Fixed by PR 356 outside the run\.$/);
});
