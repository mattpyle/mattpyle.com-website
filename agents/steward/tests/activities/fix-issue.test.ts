import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING, DEFECT_KEY } from '../helpers/finding-fixtures.js';
import { awaitFixPr, openFixIssue, readSiteAutoFix, siteAutoFix } from '../../src/activities/findings.js';
import {
  FIX_ISSUE_HEADER,
  fixIssueBody,
  fixIssueClosingComment,
  fixIssueMarker,
  fixIssueTitle,
  fixIssueVerdictLine,
  fixPrBranchPrefix,
  parseIssueUrl,
} from '../../src/lib/findings.js';

/**
 * The fix issue (findings-loop design, decisions 26 to 28): the body
 * `claude-code-action` reads, the one-finding-one-open-issue rule, and the
 * branch-prefix match the PR wait polls on. Against the fake GitHub, which
 * answers for the findings repository and the site repository alike.
 */

const REPO = 'mattpyle/argus';
const SITE = 'mattpyle-com';
const FINDING = `sites/${SITE}/findings/${DEFECT_KEY}.md`;
const SITE_REPO = 'mattpyle/mattpyle.com-website';

let fake: FakeGitHub | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function seed(finding: string = DEFECT_FINDING, extra: Record<string, string> = {}): FakeGitHub {
  fake = installFakeGitHub({ defaultBranch: 'main', seed: { [FINDING]: finding, ...extra } });
  return fake;
}

const open = (supersedes: { url: string; reason: string } | null = null) =>
  openFixIssue({ repo: REPO, site: SITE, key: DEFECT_KEY, findingPath: FINDING, supersedes });

test('the issue body is the six-line header, the finding without its frontmatter, the verdict under the H1, and the marker last', () => {
  const body = fixIssueBody(SITE, DEFECT_KEY, DEFECT_FINDING, 'Approved by Matt via steward finding approve.');
  const lines = body.split('\n');
  assert.equal(FIX_ISSUE_HEADER.split('\n').length - 1, 6, 'six lines, the last one blank');
  assert.ok(body.startsWith(FIX_ISSUE_HEADER), 'the header first');
  assert.ok(lines[0].startsWith('@claude '), 'the mention that starts the Action');
  assert.equal(lines[4], '---');
  assert.equal(lines[6], '# /scorecard\'s run history says "Accessibility: 100/100 (Fail)", a perfect score labelled as a failure');
  assert.equal(lines[7], '');
  assert.equal(lines[8], 'Verdict: approved by Matt via steward finding approve.');
  assert.equal(lines[9], '');
  assert.equal(lines[10], '## Who wanted what');
  assert.ok(!body.includes('verdict_source:'), 'no frontmatter');
  assert.ok(body.includes('## How to measure'), 'the measure the Action is told to meet');
  assert.ok(body.trimEnd().endsWith(fixIssueMarker(SITE, DEFECT_KEY)));
  assert.equal(fixIssueMarker(SITE, DEFECT_KEY), `<!-- steward-finding: ${SITE}/${DEFECT_KEY} -->`);
});

test('the verdict line keeps a reason that opens with "Approved" and prefixes any other', () => {
  assert.equal(fixIssueVerdictLine('Approved in part: teach hoistBlockLinks.'), 'Verdict: approved in part: teach hoistBlockLinks.');
  assert.equal(fixIssueVerdictLine('Add the Link header in middleware.ts.'), 'Verdict: approved. Add the Link header in middleware.ts.');
  assert.equal(fixIssueVerdictLine(''), 'Verdict: approved.');
  assert.equal(fixIssueVerdictLine(null), 'Verdict: approved.');
});

test('the title is the H1, cut to GitHub\'s 256 characters', () => {
  assert.equal(fixIssueTitle(DEFECT_FINDING), '/scorecard\'s run history says "Accessibility: 100/100 (Fail)", a perfect score labelled as a failure');
  const long = DEFECT_FINDING.replace(/^# .*$/m, `# ${'x'.repeat(300)}`);
  assert.equal(fixIssueTitle(long).length, 256);
});

test('openFixIssue opens one issue in the site repository and returns its number and URL', async () => {
  const gh = seed();
  const issue = await open();
  assert.deepEqual(issue, { repo: SITE_REPO, number: 101, url: `https://github.com/${SITE_REPO}/issues/101`, reused: false });
  assert.equal(gh.issues.length, 1);
  assert.equal(gh.issues[0].title, fixIssueTitle(DEFECT_FINDING));
  assert.equal(gh.issues[0].body, fixIssueBody(SITE, DEFECT_KEY, DEFECT_FINDING, 'Approved by Matt via steward finding approve.'));
  const post = gh.calls.indexOf('POST /issues');
  assert.equal(gh.repos[post], SITE_REPO, 'the issue goes to the site repository');
  assert.equal(gh.repos[gh.calls.findIndex((c) => c.startsWith('GET /contents/'))], REPO, 'the finding comes from the findings repository');
});

test('a retried openFixIssue reuses the open issue that carries the key, and a PR that quotes it does not count', async () => {
  const gh = seed();
  // A PR whose body quotes the marker, as the Action's might: GitHub lists it among issues.
  gh.pulls.push({ number: 7, head: 'claude/issue-5-x', base: 'master', title: 'x', body: fixIssueMarker(SITE, DEFECT_KEY), draft: false });
  const first = await open();
  const second = await open();
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.number, first.number);
  assert.equal(gh.issues.length, 1, 'one finding, one issue');
});

test('a closed issue is never reused, and the second attempt closes the first with a comment naming the PR', async () => {
  const gh = seed();
  const first = await open();
  const prUrl = `https://github.com/${SITE_REPO}/pull/402`;
  const second = await open({ url: first.url, reason: `${prUrl} closed unmerged` });

  assert.equal(second.reused, false);
  assert.notEqual(second.number, first.number);
  assert.equal(gh.issues[0].state, 'closed');
  assert.equal(gh.issues[0].stateReason, 'not_planned');
  assert.deepEqual(gh.issues[0].comments, [
    `Closed by Steward: ${prUrl} closed unmerged. The next fix attempt opens a new issue.`,
  ]);
  assert.equal(gh.issues[1].state, 'open');

  // A retry of that second call: the old issue is already closed, so no second comment.
  const retry = await open({ url: first.url, reason: `${prUrl} closed unmerged` });
  assert.equal(retry.number, second.number);
  assert.equal(retry.reused, true);
  assert.equal(gh.issues[0].comments.length, 1);
});

test('the closing comment reads as one sentence whatever the reason ends with', () => {
  assert.equal(fixIssueClosingComment('No PR from x within 60 minutes.'), 'Closed by Steward: No PR from x within 60 minutes. The next fix attempt opens a new issue.');
  assert.equal(fixIssueClosingComment(''), 'Closed by Steward: the attempt ended without a merged fix. The next fix attempt opens a new issue.');
});

test('a finding the fixer would refuse opens no issue', async () => {
  const gh = seed(DEFECT_FINDING.replace('kind: defect', 'kind: opportunity'));
  await assert.rejects(open(), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure);
    assert.equal(err.type, 'FindingNotFixable');
    assert.equal(err.nonRetryable, true);
    return true;
  });
  assert.equal(gh.issues.length, 0);
});

test('a site with no known repository is refused before anything is read', async () => {
  const gh = seed();
  await assert.rejects(
    openFixIssue({ repo: REPO, site: 'temporal-io', key: DEFECT_KEY, findingPath: FINDING }),
    (err: unknown) => err instanceof ApplicationFailure && err.type === 'UnknownSite',
  );
  assert.deepEqual(gh.calls, []);
});

test('awaitFixPr matches the head branch prefix claude/issue-<n>- exactly, and says "not yet" until it is there', async () => {
  const gh = seed();
  assert.equal(fixPrBranchPrefix(101), 'claude/issue-101-');
  // Neither of these is issue 101's: a longer number, and a person's branch.
  gh.pulls.push({ number: 1, head: 'claude/issue-1010-20261016-0338', base: 'master', title: 'a', body: '', draft: false });
  gh.pulls.push({ number: 2, head: 'fix/issue-101', base: 'master', title: 'b', body: 'Fixes #101', draft: false });

  await assert.rejects(awaitFixPr({ repo: SITE_REPO, issueNumber: 101 }), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure);
    assert.equal(err.type, 'FixPrNotOpen');
    assert.equal(err.nonRetryable, false, 'retryable: the workflow polls on it');
    return true;
  });

  gh.pulls.push({ number: 3, head: 'claude/issue-101-20261016-0338', base: 'master', title: 'c', body: '', draft: false });
  assert.deepEqual(await awaitFixPr({ repo: SITE_REPO, issueNumber: 101 }), {
    prUrl: `https://github.com/${SITE_REPO}/pull/3`,
    branch: 'claude/issue-101-20261016-0338',
  });
});

test('auto_fix is the literal true at the top of the site config, and a site with no config has none', async () => {
  assert.equal(siteAutoFix('site:\n  name: x\nauto_fix: true\n'), true);
  assert.equal(siteAutoFix('auto_fix: "true"\n'), false);
  assert.equal(siteAutoFix('site:\n  auto_fix: true\n'), false);
  assert.equal(siteAutoFix('# comments only\n'), false);

  seed(DEFECT_FINDING, { [`sites/${SITE}/config.yaml`]: 'site:\n  name: mattpyle.com\nauto_fix: true\n' });
  assert.equal(await readSiteAutoFix({ repo: REPO, site: SITE }), true);
  assert.equal(await readSiteAutoFix({ repo: REPO, site: 'temporal-io' }), false);
});

test('parseIssueUrl reads an issue URL and nothing else', () => {
  assert.deepEqual(parseIssueUrl(`https://github.com/${SITE_REPO}/issues/101`), { repo: SITE_REPO, number: 101 });
  assert.equal(parseIssueUrl(`https://github.com/${SITE_REPO}/pull/101`), null);
});
