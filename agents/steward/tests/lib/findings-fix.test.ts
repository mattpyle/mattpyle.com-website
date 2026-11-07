import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defectFixRefusal,
  findingHandoffPath,
  findingPages,
  fixBranch,
  fixRefusal,
  fixWorkflowId,
  parseFindingBody,
  setFrontmatterFix,
  setIndexStatus,
  verifyChecksAreOneChange,
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
  assert.match(fixRefusal({ status: 'approved' }, defect) ?? '', /kind is unset/);
  assert.match(fixRefusal(data(DEFECT_FINDING), { ...defect, cause: null }) ?? '', /names no cause/);
  assert.match(fixRefusal(data(DEFECT_FINDING), { ...defect, measure: null }) ?? '', /no "How to measure"/);
});

/** The first real case: one link to add on one page, filed with a verify check on that page. */
const ONE_PAGE = [
  '---',
  'key: study-uncited--changelog-entry',
  'status: approved',
  'kind: opportunity',
  'verdict_reason: "approve"',
  'verify:',
  '  - url: "https://www.mattpyle.com/changelog/agent-reading-budget/"',
  '    kind: text',
  '    expect:',
  '      contains: "peec.ai"',
  '---',
  '',
  '# The entry rests every number on a study and never links to it',
  '',
  '## What happened',
  '',
  '- URL: https://www.mattpyle.com/changelog/agent-reading-budget/',
  '- What happened: the page has 0 occurrences of `peec.ai`.',
  '- Cause, from the source, if found: `src/content/changelog/agent-reading-budget.md` names the study with no link.',
  '',
  '## What would serve them',
  '',
  "Link the study in the entry's first sentence. Effort S.",
  '',
  '## How to measure',
  '',
  'The entry links to peec.ai (the verify check).',
  '',
].join('\n');

/** The same finding with its verify block cut and its "What would serve them" replaced. */
const withoutVerify = (serve: string) =>
  ONE_PAGE.replace(/verify:\n(  .*\n)+/, '').replace(/^Link the study.*$/m, serve);

test('the fixer takes an approved opportunity whose verify block names one page, with no cause asked', () => {
  const parsed = parseFindingBody(ONE_PAGE);
  assert.equal(fixRefusal(data(ONE_PAGE), parsed), null);
  assert.equal(fixRefusal(data(ONE_PAGE), { ...parsed, cause: null }), null, 'an opportunity needs no cause');
  assert.deepEqual(findingPages(data(ONE_PAGE), parsed), ['/changelog/agent-reading-budget']);
});

test('a verify block that checks one page twice, or the page with and without its slash, is still one page', () => {
  const twice = ONE_PAGE.replace(
    '      contains: "peec.ai"\n---',
    '      contains: "peec.ai"\n  - url: "https://www.mattpyle.com/changelog/agent-reading-budget"\n    kind: markdown\n    expect:\n      contains: "peec.ai"\n---',
  );
  const parsed = parseFindingBody(twice);
  assert.equal(fixRefusal(data(twice), parsed), null);
  assert.equal(findingPages(data(twice), parsed).length, 1);
});

test('an opportunity with no verify block is judged on the page path in "What would serve them"', () => {
  const one = withoutVerify('On `/about/`, link the repository from the first paragraph. Effort S.');
  assert.equal(fixRefusal(data(one), parseFindingBody(one)), null);

  const url = withoutVerify('On https://www.mattpyle.com/about/, link the repository (see src/content/x.md).');
  assert.deepEqual(findingPages(data(url), parseFindingBody(url)), ['/about']);
  assert.equal(fixRefusal(data(url), parseFindingBody(url)), null);

  const sentence = withoutVerify('Add the link to /llms.txt. Both and/or either work.');
  assert.deepEqual(findingPages(data(sentence), parseFindingBody(sentence)), ['/llms.txt']);
});

test('an opportunity that names several pages, or none, is refused with the reason', () => {
  const several = ONE_PAGE.replace(
    '      contains: "peec.ai"\n---',
    '      contains: "peec.ai"\n  - url: "https://www.mattpyle.com/about/"\n    kind: text\n    expect:\n      contains: "x"\n---',
  );
  assert.match(fixRefusal(data(several), parseFindingBody(several)) ?? '', /names more than one page \(\/changelog\/agent-reading-budget, \/about\)/);

  const body = withoutVerify('Link it from `/about/` and from `/writing/`.');
  assert.match(fixRefusal(data(body), parseFindingBody(body)) ?? '', /names more than one page/);

  const none = withoutVerify('A styled feed, or one line that says what to do with the link.');
  assert.match(fixRefusal(data(none), parseFindingBody(none)) ?? '', /names no page/);
  assert.match(fixRefusal(data(OPPORTUNITY_FINDING), parseFindingBody(OPPORTUNITY_FINDING)) ?? '', /names no page/);
});

interface TestCheck {
  url: string | string[];
  /** Default `text`, expecting `contains: "og:image"`. */
  kind?: string;
  /** The `expect` lines under the check, already indented by six spaces. Default the `og:image` needle. */
  expect?: string[];
  extra?: string[];
}

/** A finding file whose verify block is the given checks. */
function withChecks(...checks: (string | string[] | TestCheck)[]): string {
  const lines: string[] = ['---', 'key: share-card--steward', 'status: approved', 'kind: opportunity', 'verdict_reason: "approve"', 'verify:'];
  for (const raw of checks) {
    const check: TestCheck = typeof raw === 'string' || Array.isArray(raw) ? { url: raw } : raw;
    if (Array.isArray(check.url)) lines.push('  - url:', ...check.url.map((u) => `      - "${u}"`));
    else lines.push(`  - url: "${check.url}"`);
    lines.push(`    kind: ${check.kind ?? 'text'}`, '    expect:', ...(check.expect ?? ['      contains: "og:image"']), ...(check.extra ?? []));
  }
  lines.push('---', '', '# Three pages share one generic card', '', '## How to measure', '', 'Each page names its own card.', '');
  return lines.join('\n');
}

const O = 'https://www.mattpyle.com';
const jsCheck = (path: string, expression = 'document.title.length > 0'): TestCheck => ({
  url: `${O}${path}`,
  kind: 'js',
  expect: [`      expression: "${expression}"`, '      equals: true'],
});
const refused = (text: string) => fixRefusal(data(text), parseFindingBody(text)) ?? '';

test('one list check over three pages is one change: the gate accepts it', () => {
  const list = withChecks([`${O}/a/`, `${O}/b`, `${O}/c`]);
  const parsed = parseFindingBody(list);
  assert.deepEqual(findingPages(data(list), parsed), ['/a', '/b', '/c'], 'findingPages still lists every page, in order');
  assert.equal(verifyChecksAreOneChange(data(list)), true);
  assert.equal(fixRefusal(data(list), parsed), null);
});

test('several list checks over the same set are one change, whatever the order, slash or repeat', () => {
  const same = withChecks([`${O}/a`, `${O}/b`], [`${O}/b/`, `${O}/a`, `${O}/a`]);
  assert.equal(fixRefusal(data(same), parseFindingBody(same)), null);
});

test('a list check plus a single-page check of the same kind and expect is still one repeated check', () => {
  const mixed = withChecks([`${O}/a`, `${O}/b`, `${O}/c`], `${O}/a`);
  assert.equal(fixRefusal(data(mixed), parseFindingBody(mixed)), null);
  const two = withChecks(`${O}/a`, `${O}/b`);
  assert.equal(verifyChecksAreOneChange(data(two)), true);
  assert.equal(fixRefusal(data(two), parseFindingBody(two)), null);
});

test('three js checks identical apart from url pass: a list is refused on js, so the pages are three checks', () => {
  const js = withChecks(jsCheck('/a'), jsCheck('/b'), jsCheck('/c'));
  const parsed = parseFindingBody(js);
  assert.deepEqual(findingPages(data(js), parsed), ['/a', '/b', '/c']);
  assert.equal(fixRefusal(data(js), parsed), null);
});

test('two js checks with different expressions are refused', () => {
  const js = withChecks(jsCheck('/a', 'document.title.length > 0'), jsCheck('/b', 'document.body.scrollWidth <= innerWidth'));
  assert.match(refused(js), /names more than one page \(\/a, \/b\), so its fix is not one change/);
});

test('checks that differ in kind, expect, viewport or status are several changes and stay refused', () => {
  const kind = withChecks(
    { url: `${O}/a`, kind: 'markdown', expect: ['      contains: "og:image"'] },
    { url: `${O}/b`, kind: 'text', expect: ['      contains: "og:image"'] },
  );
  assert.match(refused(kind), /names more than one page/);
  const expect = withChecks([`${O}/a`, `${O}/b`], { url: `${O}/c`, expect: ['      contains: "og:title"'] });
  assert.match(refused(expect), /names more than one page \(\/a, \/b, \/c\)/);
  const viewport = withChecks(
    { ...jsCheck('/a'), extra: ['    viewport: "390x844"'] },
    { ...jsCheck('/b'), extra: ['    viewport: "1280x800"'] },
  );
  assert.match(refused(viewport), /names more than one page/);
  const noViewport = withChecks({ ...jsCheck('/a'), extra: ['    viewport: "390x844"'] }, jsCheck('/b'));
  assert.match(refused(noViewport), /names more than one page/);
  const status = withChecks(
    { url: `${O}/a`, extra: ['    status: 404'] },
    { url: `${O}/b`, extra: ['    status: 200'] },
  );
  assert.match(refused(status), /names more than one page/);
  const sameViewport = withChecks(
    { ...jsCheck('/a'), extra: ['    viewport: "390x844"'] },
    { ...jsCheck('/b'), extra: ['    viewport: "390x844"'] },
  );
  assert.equal(fixRefusal(data(sameViewport), parseFindingBody(sameViewport)), null);
});

test('a deep-equal expect passes whatever its key order', () => {
  const a = withChecks(
    { url: `${O}/a`, kind: 'header', expect: ['      name: "link"', '      contains: "rel"'] },
    { url: `${O}/b`, kind: 'header', expect: ['      contains: "rel"', '      name: "link"'] },
  );
  assert.equal(fixRefusal(data(a), parseFindingBody(a)), null);
});

test('pages told from the prose, with no verify check, are never one repeated check', () => {
  const prose = withoutVerify('Link it from `/about/` and from `/writing/`.');
  assert.equal(verifyChecksAreOneChange(data(prose)), false);
  assert.equal(verifyChecksAreOneChange({ verify: [] }), false);
  assert.equal(verifyChecksAreOneChange({ verify: [{ url: 42, kind: 'text', expect: {} }] }), false);
  assert.equal(verifyChecksAreOneChange({ verify: [{ url: [], kind: 'text', expect: {} }] }), false);
  assert.match(refused(prose), /names more than one page/);
});

test('a single-page opportunity passes as before', () => {
  assert.equal(verifyChecksAreOneChange(data(ONE_PAGE)), true);
  assert.equal(fixRefusal(data(ONE_PAGE), parseFindingBody(ONE_PAGE)), null);
});

test('an opportunity still needs approval, a title and a measure', () => {
  const parsed = parseFindingBody(ONE_PAGE);
  assert.match(fixRefusal({ ...data(ONE_PAGE), status: 'proposed' }, parsed) ?? '', /status is proposed, not approved/);
  assert.match(fixRefusal(data(ONE_PAGE), { ...parsed, measure: null }) ?? '', /no "How to measure"/);
  assert.match(fixRefusal(data(ONE_PAGE), { ...parsed, title: '' }) ?? '', /no title line/);
});

test('the fixer refuses a direction, even one that names a single page', () => {
  const direction = ONE_PAGE.replace('kind: opportunity', 'kind: direction');
  assert.match(fixRefusal(data(direction), parseFindingBody(direction)) ?? '', /kind is direction, not defect or opportunity/);
});

test('the custom fixer keeps the defect-only gate', () => {
  const parsed = parseFindingBody(ONE_PAGE);
  assert.equal(fixRefusal(data(ONE_PAGE), parsed), null);
  assert.match(defectFixRefusal(data(ONE_PAGE), parsed) ?? '', /kind is opportunity, not defect/);
  const defect = parseFindingBody(DEFECT_FINDING);
  assert.equal(defectFixRefusal(data(DEFECT_FINDING), defect), null);
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
