import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFF_REVIEW_MAX_CHARS,
  diffReviewArgs,
  diffReviewPrompt,
  parseDiffReviewReply,
  type FixerDiffReview,
} from '../../src/lib/diff-review.js';
import { buildFixerPrBody, opensAsDraft } from '../../src/lib/fixer.js';
import { parseFindingBody } from '../../src/lib/findings.js';
import { DEFECT_FINDING, DEFECT_KEY } from '../helpers/finding-fixtures.js';

/**
 * The diff review's pure half: the reviewer's arguments, its reply read back,
 * and what a review does to the PR.
 */

test('the reviewer has no tools, no customizations and no MCP server, and its prompt is not on the command line', () => {
  const argv = diffReviewArgs();
  const tools = argv.indexOf('--tools');
  assert.ok(tools > 0);
  assert.equal(argv[tools + 1], '', '--tools "" is no tool at all');
  assert.ok(argv.includes('--safe-mode'));
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(argv[0], '-p');
  assert.ok(!argv.some((arg) => arg.includes('<diff>')), 'the prompt rides on stdin');
});

test('the prompt carries the finding, the handoff and the diff, and nothing else from the run', () => {
  const prompt = diffReviewPrompt({ key: 'k', finding: 'FINDING', handoff: 'HANDOFF', diff: 'DIFF' });
  assert.match(prompt, /<finding>\nFINDING\n<\/finding>/);
  assert.match(prompt, /<handoff>\nHANDOFF\n<\/handoff>/);
  assert.match(prompt, /<diff>\nDIFF\n<\/diff>/);
});

test('with a coverage map, the prompt lists it and makes a changed file serving an unmapped surface unexplained', () => {
  const coverage = [
    { surface: '/llms.txt', checks: [1] },
    { surface: 'the A2A answer', reason: 'A2A is a POST.' },
  ];
  const prompt = diffReviewPrompt({ key: 'k', finding: 'FINDING', handoff: 'HANDOFF', diff: 'DIFF', coverage });
  assert.match(prompt, /A changed file that serves a surface the coverage map below does not name is also `unexplained`/);
  assert.match(prompt, /<coverage>\n- \/llms\.txt: checks 1\n- the A2A answer: no check, because A2A is a POST\.\n<\/coverage>/);
  assert.ok(prompt.indexOf('<coverage>') < prompt.indexOf('<diff>'));
  const bare = diffReviewPrompt({ key: 'k', finding: 'FINDING', handoff: 'HANDOFF', diff: 'DIFF', coverage: null });
  assert.doesNotMatch(bare, /coverage/i, 'no map, no rule and no section');
});

test('no problems: an empty list', () => {
  assert.deepEqual(parseDiffReviewReply('problems: []'), { problems: [] });
  assert.deepEqual(parseDiffReviewReply('problems:\n'), { problems: [] });
});

test('one unexplained hunk', () => {
  const reply = parseDiffReviewReply(
    'problems:\n  - file: src/pages/about.astro\n    line: 12\n    kind: unexplained\n    note: The heading is reworded; the finding names only llms.txt.',
  );
  assert.deepEqual(reply, {
    problems: [
      { file: 'src/pages/about.astro', line: 12, kind: 'unexplained', note: 'The heading is reworded; the finding names only llms.txt.' },
    ],
  });
});

test('one error, fenced as the model sometimes does', () => {
  const reply = parseDiffReviewReply(
    '```yaml\nproblems:\n  - file: src/lib/a2a-responder.mjs\n    line: 119\n    kind: error\n    note: "Missing space after the comma: \\"no product,no company\\"."\n```',
  );
  assert.deepEqual(reply, {
    problems: [
      { file: 'src/lib/a2a-responder.mjs', line: 119, kind: 'error', note: 'Missing space after the comma: "no product,no company".' },
    ],
  });
});

test('a reply that does not parse is an error, never a partial list', () => {
  for (const [raw, why] of [
    ['The diff looks fine to me.', /"problems" key/],
    ['problems: none', /not a list/],
    ['problems:\n  - file: a.ts\n    line: 3\n    kind: style\n    note: x', /kind "style"/],
    ['problems:\n  - file: a.ts\n    line: 3\n    kind: error\n    note: ok\n  - file: b.ts\n    line: -1\n    kind: error\n    note: x', /problem 2/],
    ['problems:\n  - file: a.ts\n    kind: error', /no note/],
    ['problems: [unclosed', /not YAML|"problems" key|not a list/],
  ] as const) {
    const reply = parseDiffReviewReply(raw);
    assert.ok('error' in reply, `refused: ${raw}`);
    assert.match(reply.error, why);
  }
});

test('a line may be absent, for a problem with no line in the new file', () => {
  const reply = parseDiffReviewReply('problems:\n  - file: old.ts\n    kind: unexplained\n    note: The file is deleted.');
  assert.deepEqual(reply, { problems: [{ file: 'old.ts', line: null, kind: 'unexplained', note: 'The file is deleted.' }] });
});

test('the cap is stated in characters', () => {
  assert.equal(DIFF_REVIEW_MAX_CHARS, 60_000);
});

// ---------------------------------------------------------------------------
// The PR
// ---------------------------------------------------------------------------

const RUN = { exitCode: 0, timedOut: false, checks: [] };

const body = (review: FixerDiffReview | null) =>
  buildFixerPrBody({
    key: DEFECT_KEY,
    finding: parseFindingBody(DEFECT_FINDING),
    checks: [],
    results: [],
    filesChanged: ['src/lib/a2a-responder.mjs'],
    exitCode: 0,
    timedOut: false,
    review,
  });

test('a clean review keeps the PR ready and says so under Review', () => {
  const review = { problems: [], incomplete: null };
  assert.equal(opensAsDraft({ ...RUN, review }), false);
  const text = body(review);
  assert.match(text, /## Review\n\n.*\n\nNo problems reported\./);
  assert.doesNotMatch(text, /diff review/);
});

test('any problem opens the PR as a draft and lists each one under Review', () => {
  const review: FixerDiffReview = {
    problems: [
      { file: 'src/lib/a2a-responder.mjs', line: 119, kind: 'error', note: 'Missing space: "no product,no company".' },
      { file: 'src/pages/about.astro', line: null, kind: 'unexplained', note: 'Not in the finding.' },
    ],
    incomplete: null,
  };
  assert.equal(opensAsDraft({ ...RUN, review }), true);
  const text = body(review);
  assert.match(text, /^> \*\*The diff review reported 2 problems\.\*\*/);
  assert.match(text, /- `error` `src\/lib\/a2a-responder\.mjs:119`: Missing space: "no product,no company"\./);
  assert.match(text, /- `unexplained` `src\/pages\/about\.astro`: Not in the finding\./);
});

test('a review that did not finish opens the PR as a draft with the reason', () => {
  const review = { problems: [], incomplete: "The reviewer's reply did not parse: \"problems\" is not a list." };
  assert.equal(opensAsDraft({ ...RUN, review }), true);
  const text = body(review);
  assert.match(text, /^> \*\*The diff review did not finish\.\*\* The reviewer's reply did not parse/);
  assert.match(text, /## Review[\s\S]*The review did not finish: The reviewer's reply/);
});

test('a run from before the review has no Review section', () => {
  assert.doesNotMatch(body(null), /## Review/);
  assert.equal(opensAsDraft(RUN), false);
});
