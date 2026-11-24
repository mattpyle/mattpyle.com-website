import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING, DEFECT_KEY, OPPORTUNITY_FINDING, OPPORTUNITY_KEY } from '../helpers/finding-fixtures.js';
import {
  awaitFixPr,
  openFixIssue,
  readFindingSettings,
  readSiteAutoFix,
  siteAutoFix,
  siteStopAfter,
} from '../../src/activities/findings.js';
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

test('a bare "approve" adds nothing, and a reason over several lines stays one line', () => {
  assert.equal(fixIssueVerdictLine('approve'), 'Verdict: approved.');
  assert.equal(fixIssueVerdictLine('Approved.'), 'Verdict: approved.');
  assert.equal(
    fixIssueVerdictLine('Approved in part: link the study.\n  Rejected: the rewrite of the second paragraph.'),
    'Verdict: approved in part: link the study. Rejected: the rewrite of the second paragraph.',
  );
});

test('a partial approval reaches the Action word for word, as the line under the H1, and the header makes it the scope', () => {
  const reason = 'Approved in part: link the study in the first sentence; rejected: rewriting the second paragraph.';
  const body = fixIssueBody(SITE, OPPORTUNITY_KEY, OPPORTUNITY_FINDING, reason);
  const lines = body.split('\n');
  const h1 = lines.findIndex((line) => line.startsWith('# '));
  assert.equal(lines[h1 + 2], 'Verdict: approved in part: link the study in the first sentence; rejected: rewriting the second paragraph.');
  assert.match(lines[2], /The Verdict line below is the scope: a part it rejects is out of scope\./);
  assert.equal(FIX_ISSUE_HEADER.split('\n').length - 1, 6, 'the header keeps its six lines');
});

test('the header widens the fix to every place that states the fact and nothing else, says where facts hide, and makes an aimed look part of done', () => {
  const rules = FIX_ISSUE_HEADER.split('\n')[2];
  assert.match(rules, /The fix covers every place that states the fact, unless the Verdict line below rejects it; the finding's Fix may not name them all\./);
  assert.ok(!rules.includes('no adjacent tidying'), 'the old narrowing sentence is gone');
  assert.ok(!rules.includes('Change only what the finding needs'), 'the old narrowing sentence is gone');
  assert.match(rules, /The row "A changed fact about the site or its author" in `CHANGE-KINDS\.md` lists where facts hide\./);
  assert.match(rules, /Search the whole tree for the old words; the list says where to start\./);
  assert.match(rules, /Change nothing that is not this fact\./);
  assert.match(rules, /Done is the "How to measure" check passing on the Vercel preview and a look with `npm run look` at every page your change reaches, aimed with `--find` at the changed text/);
  assert.match(rules, /for every change read the text, the rendered HTML, the markdown twin and the two aimed pictures it leaves;/);
  assert.ok(!rules.includes('layout or style'), 'the pictures are read on every change');
  assert.match(rules, /for a file with no page such as `agents\.md`, read the served file\./);
  assert.match(rules, /The PR says what you looked at and at which widths\./);
  assert.equal(FIX_ISSUE_HEADER.split('\n').length - 1, 6, 'still six lines');
});

test('openFixIssue opens an issue for an approved one-page opportunity, with its verdict reason as the scope', async () => {
  const key = 'content-reading-budget-study-uncited--changelog-agent-reading-budget';
  const finding = [
    '---',
    `key: ${key}`,
    'status: approved',
    'kind: opportunity',
    'verdict_reason: "Approved in part: link the study; rejected: restyle the entry."',
    'verify:',
    '  - url: "https://www.mattpyle.com/changelog/agent-reading-budget/"',
    '    kind: text',
    '    expect:',
    '      contains: "peec.ai"',
    '---',
    '',
    '# The entry never links to its study',
    '',
    '## What would serve them',
    '',
    'Link the study in the first sentence.',
    '',
    '## How to measure',
    '',
    'The entry links to peec.ai.',
    '',
  ].join('\n');
  const path = `sites/${SITE}/findings/${key}.md`;
  const gh = seed(finding, { [path]: finding });
  const issue = await openFixIssue({ repo: REPO, site: SITE, key, findingPath: path, supersedes: null });
  assert.equal(issue.reused, false);
  assert.equal(gh.issues.length, 1);
  const body = gh.issues[0].body;
  assert.ok(body.includes('\nVerdict: approved in part: link the study; rejected: restyle the entry.\n'), 'the scope line, read back');
  assert.ok(body.includes('## How to measure'));
  assert.ok(body.trimEnd().endsWith(fixIssueMarker(SITE, key)));
});

test('openFixIssue opens one issue for a list check over three pages, and the body names every page', async () => {
  const key = 'seo-share-card-generic--three-pages';
  const pages = ['/a', '/b', '/c'];
  const finding = [
    '---',
    `key: ${key}`,
    'status: approved',
    'kind: opportunity',
    'verdict_reason: "approve"',
    'verify:',
    '  - url:',
    ...pages.map((p) => `      - "https://www.mattpyle.com${p}/"`),
    '    kind: text',
    '    expect:',
    '      contains: "og:image"',
    '---',
    '',
    '# Three pages share one generic card',
    '',
    '## How to measure',
    '',
    'Each page names its own card.',
    '',
  ].join('\n');
  const path = `sites/${SITE}/findings/${key}.md`;
  const gh = seed(finding, { [path]: finding });
  const issue = await openFixIssue({ repo: REPO, site: SITE, key, findingPath: path, supersedes: null });
  assert.equal(issue.reused, false);
  assert.equal(gh.issues.length, 1);
  const body = gh.issues[0].body;
  let from = 0;
  for (const p of pages) {
    const at = body.indexOf(`https://www.mattpyle.com${p}/`, from);
    assert.ok(at >= 0, `the issue body names ${p}, in list order`);
    from = at;
  }
});

test('a direction opens no issue', async () => {
  const gh = seed(DEFECT_FINDING.replace('kind: defect', 'kind: direction'));
  await assert.rejects(open(), (err: unknown) => err instanceof ApplicationFailure && err.type === 'FindingNotFixable');
  assert.equal(gh.issues.length, 0);
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

test('readFindingSettings reads the stop point, the flag and the gate from the site config and the finding file as they stand', async () => {
  assert.equal(siteStopAfter('stop_after: verdict\n'), 'verdict');
  assert.equal(siteStopAfter('site:\n  name: temporal.io\n  stop_after: verdict\n'), 'verdict', 'nested under site, as temporal-io writes it');
  assert.equal(siteStopAfter('auto_fix: true\n'), null);

  const config = `sites/${SITE}/config.yaml`;
  const read = () => readFindingSettings({ repo: REPO, site: SITE, key: DEFECT_KEY, findingPath: FINDING });

  // A site that fixes findings, with the flag on and a defect the gate accepts.
  seed(DEFECT_FINDING, { [config]: 'site:\n  name: mattpyle.com\nauto_fix: true\n' });
  assert.deepEqual(await read(), {
    stopAfter: 'resolved',
    origin: 'https://www.mattpyle.com',
    autoFix: true,
    status: 'approved',
    kind: 'defect',
    refusal: null,
  });

  // The site's own stop point, at either level, ends a run at the verdict; the origin is still known.
  for (const text of ['auto_fix: true\nstop_after: verdict\n', 'auto_fix: true\nsite:\n  stop_after: verdict\n']) {
    fake?.restore();
    seed(DEFECT_FINDING, { [config]: text });
    const stopped = await read();
    assert.equal(stopped.stopAfter, 'verdict');
    assert.equal(stopped.origin, 'https://www.mattpyle.com');
  }

  // No config.yaml: no flag, and no stop point of the site's own.
  fake?.restore();
  seed(DEFECT_FINDING);
  const bare = await read();
  assert.equal(bare.autoFix, false);
  assert.equal(bare.stopAfter, 'resolved');

  // A site the worker knows no production origin for stops at the verdict, whatever its config says.
  fake?.restore();
  seed(DEFECT_FINDING, { 'sites/temporal-io/config.yaml': 'auto_fix: true\n', 'sites/temporal-io/findings/x.md': DEFECT_FINDING });
  const unknown = await readFindingSettings({ repo: REPO, site: 'temporal-io', key: 'x', findingPath: 'sites/temporal-io/findings/x.md' });
  assert.equal(unknown.stopAfter, 'verdict');
  assert.equal(unknown.origin, null);
  assert.equal(unknown.refusal, 'Steward knows no site repository for temporal-io');
});

test('readFindingSettings returns the gate\'s refusal, and a missing or unparsable finding as a refusal, never a failure', async () => {
  const read = () => readFindingSettings({ repo: REPO, site: SITE, key: DEFECT_KEY, findingPath: FINDING });

  seed(DEFECT_FINDING.replace('kind: defect', 'kind: direction'));
  const direction = await read();
  assert.equal(direction.kind, 'direction');
  assert.equal(direction.refusal, 'its kind is direction, not defect or opportunity');

  fake?.restore();
  seed(DEFECT_FINDING.replace('status: approved', 'status: resolved'));
  const resolved = await read();
  assert.equal(resolved.status, 'resolved', 'the status a parked run closes on');
  assert.equal(resolved.refusal, 'its status is resolved, not approved');

  fake?.restore();
  fake = installFakeGitHub({ defaultBranch: 'main', seed: { 'sites/other.md': 'x' } });
  const missing = await read();
  assert.equal(missing.status, null);
  assert.equal(missing.refusal, `${FINDING} is not in ${REPO}`);

  fake?.restore();
  seed('---\nstatus: [approved\n---\n\n# Broken\n');
  const broken = await read();
  assert.equal(broken.status, null);
  assert.match(broken.refusal ?? '', /^its file does not parse: /);
});

test('parseIssueUrl reads an issue URL and nothing else', () => {
  assert.deepEqual(parseIssueUrl(`https://github.com/${SITE_REPO}/issues/101`), { repo: SITE_REPO, number: 101 });
  assert.equal(parseIssueUrl(`https://github.com/${SITE_REPO}/pull/101`), null);
});
