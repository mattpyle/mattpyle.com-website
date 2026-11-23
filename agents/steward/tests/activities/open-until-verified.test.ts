import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING, DEFECT_KEY } from '../helpers/finding-fixtures.js';
import { commentOnFixPr, openFixIssue, readFinding, writeFindingFix } from '../../src/activities/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import {
  parkComment,
  parkCommentMarker,
  parkLine,
  parkMoves,
  parkTakesFix,
  setFindingFixAttempt,
  setFindingReturned,
  setFrontmatterFix,
} from '../../src/lib/findings.js';

/**
 * The activities and lib functions behind a run that stays open after its fix
 * PR (STW-653): the one comment a park posts, the re-attempt's gate and its
 * `## Fix attempts` line, and the slow phase's retryable credential. Against
 * the fake GitHub.
 */

const REPO = 'mattpyle/argus';
const SITE = 'mattpyle-com';
const FINDING = `sites/${SITE}/findings/${DEFECT_KEY}.md`;
const INDEX = `sites/${SITE}/findings/INDEX.md`;
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const OLD_PR = `https://github.com/${SITE_REPO}/pull/401`;
const NEW_PR = `https://github.com/${SITE_REPO}/pull/402`;
const INDEX_TEXT = `${DEFECT_KEY} | reopened | defect | defect-hunt | A row reads "100/100 (Fail)" | Approved by Matt.\n`;

/** The finding after a merged fix that failed its checks: `reopened`, with the fix's PR in its links. */
const REOPENED = setFrontmatterFix(DEFECT_FINDING, OLD_PR).replace('status: fixing', 'status: reopened');

let fake: FakeGitHub | undefined;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  fake?.restore();
  fake = undefined;
});

function seed(finding: string): FakeGitHub {
  fake = installFakeGitHub({ defaultBranch: 'main', seed: { [FINDING]: finding, [INDEX]: INDEX_TEXT } });
  return fake;
}

test('a park comment is posted once: a retry finds its marker and posts nothing', async () => {
  const gh = seed(DEFECT_FINDING);
  gh.pulls.push({ number: 401, head: 'claude/issue-101-x', base: 'master', title: 'Fix', body: '', draft: false });
  const marker = parkCommentMarker(SITE, DEFECT_KEY, 1, 'park-checks-failed-verify');
  const body = 'Steward verified this fix on production, and a check failed.';

  assert.deepEqual(await commentOnFixPr({ prUrl: OLD_PR, marker, body }), { posted: true });
  assert.deepEqual(await commentOnFixPr({ prUrl: OLD_PR, marker, body }), { posted: false });
  assert.equal(gh.pulls[0].comments?.length, 1);
  assert.equal(gh.pulls[0].comments?.[0], `${body}\n\n${marker}`);
});

test('the re-attempt\'s gate reads a reopened file as approved only for the PR the run named', async () => {
  seed(REOPENED);
  await assert.rejects(
    openFixIssue({ repo: REPO, site: SITE, key: DEFECT_KEY, findingPath: FINDING }),
    (err: unknown) => err instanceof ApplicationFailure && err.type === 'FindingNotFixable' && /status is reopened, not approved/.test(err.message),
  );
  await assert.rejects(
    openFixIssue({ repo: REPO, site: SITE, key: DEFECT_KEY, findingPath: FINDING, afterPr: NEW_PR }),
    (err: unknown) => err instanceof ApplicationFailure && err.type === 'FindingNotFixable',
    'another PR does not open the gate',
  );
  const issue = await openFixIssue({ repo: REPO, site: SITE, key: DEFECT_KEY, findingPath: FINDING, afterPr: OLD_PR });
  assert.equal(issue.reused, false);
});

test('a re-attempt\'s write moves a reopened file to fixing and records the earlier PR under ## Fix attempts', async () => {
  const gh = seed(setFindingReturned(REOPENED, 'https://github.com/x/y/pull/9', '2026-10-01T00:00:00.000Z').replace('status: approved', 'status: reopened'));
  const note = `${OLD_PR} merged at m1, and production failed check 1. A new fix was asked for.`;
  const input = { repo: REPO, site: SITE, key: DEFECT_KEY, findingPath: FINDING, indexPath: INDEX, prUrl: NEW_PR };

  await assert.rejects(
    writeFindingFix(input),
    (err: unknown) => err instanceof ApplicationFailure && err.type === 'FindingMoved',
    'without `earlier` a reopened file is not moved',
  );
  await writeFindingFix({ ...input, earlier: { prUrl: OLD_PR, at: '2026-10-14T09:00:00.000Z', note } });

  const text = gh.file('main', FINDING)!.text;
  const { data } = parseFrontmatter(text);
  assert.equal(data.status, 'fixing');
  assert.deepEqual(data.links, { pr: NEW_PR });
  const section = text.slice(text.indexOf('## Fix attempts'));
  assert.deepEqual(section.trim().split('\n').slice(2), [
    '- 2026-10-01T00:00:00.000Z: https://github.com/x/y/pull/9 closed unmerged. The finding is approved again.',
    `- 2026-10-14T09:00:00.000Z: ${note}`,
  ]);
  assert.match(gh.file('main', INDEX)!.text, /\| fixing \|/);

  // A retry writes the line once.
  assert.equal(setFindingFixAttempt(text, '2026-10-14T09:00:00.000Z', note), text);
});

test('a rejected credential is final for a plain read and retryable for the slow phase\'s', async () => {
  seed(DEFECT_FINDING);
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = (async (req: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof req === 'string' ? req : req instanceof URL ? req : req.url);
    if (url.includes('/contents/')) return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    return fakeFetch(req, init);
  }) as typeof fetch;

  await assert.rejects(readFinding(REPO, FINDING), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure, String(err));
    assert.equal(err.type, 'AuthError');
    assert.equal(err.nonRetryable, true);
    return true;
  });
  await assert.rejects(readFinding(REPO, FINDING, { retryAuth: true }), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure);
    assert.equal(err.type, 'AuthError');
    assert.equal(err.nonRetryable, false, 'the slow phase retries it');
    return true;
  });
});

test('a park says what moves it, and only an unmerged PR\'s park refuses a new fix', () => {
  assert.equal(parkTakesFix('merge'), false);
  assert.equal(parkTakesFix('verify'), true);
  assert.equal(parkMoves('k', 'merge'), '`steward finding resume k` waits on the merge again.');
  assert.equal(parkMoves('k', 'verify'), '`steward finding resume k` verifies again; `steward finding fix k` starts a new fix attempt.');
  assert.equal(parkLine({ kind: 'checks-broken', stage: 'verify', reason: 'Check 1 does not parse.' }), 'parked at verify (a check is broken): Check 1 does not parse.');
  const comment = parkComment({ kind: 'error', stage: 'deploy', reason: 'The deploy wait failed.', moves: parkMoves('k', 'deploy') }, 'finding/mattpyle-com/k');
  assert.match(comment, /^Steward stopped following this fix\.\n\nThe deploy wait failed\.\n\nThe finding's run `finding\/mattpyle-com\/k` is parked and stays open\. Nothing happens on a clock: /);
});
