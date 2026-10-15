import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewDiff } from '../../src/activities/fixer.js';
import { DIFF_REVIEW_MAX_CHARS } from '../../src/lib/diff-review.js';

/**
 * `reviewDiff` against a stub in Claude Code's place: the reply it gets back,
 * read into a review, for each case the handoff names. No model is called.
 */

const STUB = fileURLToPath(new URL('../fixtures/claude-stub.mjs', import.meta.url));

/** PR 336's hunk in `src/lib/a2a-responder.mjs`: the space after the comma is gone. */
const DIFF = [
  'diff --git a/src/lib/a2a-responder.mjs b/src/lib/a2a-responder.mjs',
  '--- a/src/lib/a2a-responder.mjs',
  '+++ b/src/lib/a2a-responder.mjs',
  '@@ -116,7 +116,7 @@ function describe(digest, { unrecognised = false } = {}) {',
  "-      'the site is a personal blog and project portfolio with no product, no company, and nothing for sale. ' +",
  "+      'the site is a personal blog and his hobby projects, with no product,no company, and nothing for sale. ' +",
].join('\n');

function review(reply: string | null, diff = DIFF) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-'));
  const file = path.join(dir, 'reply.txt');
  if (reply !== null) fs.writeFileSync(file, reply);
  return {
    file,
    result: reviewDiff({
      key: 'content-agent-surfaces--llms-txt',
      findingText: 'THE FINDING',
      handoff: 'THE HANDOFF',
      diff,
      cwd: dir,
      signal: new AbortController().signal,
      reviewer: { command: process.execPath, argv: [STUB, 'reply', file] },
    }),
  };
}

test('no problems: a finished review with an empty list, and its tokens counted', { timeout: 30_000 }, async () => {
  const { file, result } = review('problems: []');
  const reviewed = await result;
  assert.deepEqual(reviewed.problems, []);
  assert.equal(reviewed.incomplete, null);
  assert.equal(reviewed.diffChars, DIFF.length);
  assert.deepEqual(reviewed.claude, { model: 'stub-model', costUsd: 0.02, durationMs: 10, inputTokens: 4503, outputTokens: 120 });
  // The prompt went in on stdin, with the finding, the handoff and the diff.
  const prompt = fs.readFileSync(`${file}.stdin`, 'utf8');
  assert.match(prompt, /THE FINDING/);
  assert.match(prompt, /THE HANDOFF/);
  assert.ok(prompt.includes('no product,no company'));
});

test('one unexplained hunk is reported', { timeout: 30_000 }, async () => {
  const reviewed = await review(
    'problems:\n  - file: src/lib/a2a-responder.mjs\n    line: 119\n    kind: unexplained\n    note: The clause is reworded; the finding asks only that llms.txt call the site a portfolio.',
  ).result;
  assert.equal(reviewed.incomplete, null);
  assert.deepEqual(reviewed.problems.map((p) => [p.file, p.line, p.kind]), [['src/lib/a2a-responder.mjs', 119, 'unexplained']]);
});

test('one error is reported', { timeout: 30_000 }, async () => {
  const reviewed = await review(
    'problems:\n  - file: src/lib/a2a-responder.mjs\n    line: 119\n    kind: error\n    note: "A space is missing after the comma: \\"no product,no company\\"."',
  ).result;
  assert.equal(reviewed.incomplete, null);
  assert.equal(reviewed.problems.length, 1);
  assert.equal(reviewed.problems[0].kind, 'error');
  assert.match(reviewed.problems[0].note, /no product,no company/);
});

test('an unparsable reply is an unfinished review with the reason, not a failure', { timeout: 30_000 }, async () => {
  const reviewed = await review('Looks good to me!').result;
  assert.deepEqual(reviewed.problems, []);
  assert.match(String(reviewed.incomplete), /^The reviewer's reply did not parse: the reply is not a YAML document with a "problems" key\.$/);
  assert.equal(reviewed.claude?.model, 'stub-model', 'the call still counts');
  assert.equal(reviewed.reply, 'Looks good to me!', 'the reply is kept as it came');
});

test('a reviewer that exits without a reply is an unfinished review', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-'));
  const reviewed = await reviewDiff({
    key: 'k',
    findingText: 'f',
    handoff: 'h',
    diff: DIFF,
    cwd: dir,
    signal: new AbortController().signal,
    reviewer: { command: process.execPath, argv: [STUB, 'no-such-mode'] },
  });
  assert.equal(reviewed.incomplete, 'The reviewer exited 2 without a reply.');
});

test('an oversized diff is an unfinished review, and no model is called', { timeout: 30_000 }, async () => {
  const big = DIFF + '\n+' + 'x'.repeat(DIFF_REVIEW_MAX_CHARS);
  const { file, result } = review(null, big);
  const reviewed = await result;
  assert.equal(reviewed.claude, null);
  assert.equal(reviewed.diffChars, big.length);
  assert.match(String(reviewed.incomplete), /^The diff is 60,\d{3} characters, over the review's cap of 60,000\.$/);
  assert.ok(!fs.existsSync(`${file}.stdin`), 'the stub never ran');
});
