import { parseFrontmatter } from './frontmatter.js';

/**
 * The fix's diff review, pure half: what the reviewer is sent, how its reply is
 * read, and what goes into the PR.
 *
 * The fixer's checks prove the defect is gone. Nothing in them measures what
 * else the edit changed, so a second model call reads the diff against the
 * finding and the handoff and reports two kinds of problem. It sees nothing
 * from the fixer's run, has no tools, and never edits the diff: a fixer that
 * corrected its own output would be grading itself.
 */

/**
 * The longest diff the review reads, in characters. About 15,000 tokens: a
 * one-finding fix is a few hundred lines at most, and PR 336's six files were
 * 5,562 characters. A diff past this is not one finding's fix, and the PR
 * opens as a draft saying so rather than sending a model a truncated diff.
 */
export const DIFF_REVIEW_MAX_CHARS = 60_000;

export type DiffProblemKind = 'unexplained' | 'error';

export const DIFF_PROBLEM_KINDS: DiffProblemKind[] = ['unexplained', 'error'];

export interface DiffProblem {
  file: string;
  /** The line in the new file, or null when the problem has none (a deleted file). */
  line: number | null;
  kind: DiffProblemKind;
  note: string;
}

export interface FixerDiffReview {
  /** What the reviewer reported. Empty when it found nothing, or did not finish. */
  problems: DiffProblem[];
  /** Why the review did not finish, or null when it did. */
  incomplete: string | null;
}

/** The reviewer's whole system prompt. */
export const DIFF_REVIEW_SYSTEM_PROMPT =
  'You review one code change against the request that asked for it. You have no tools: everything you need is in the message. You never rewrite the change; you only report. Your final message is one YAML document and nothing else: no preamble, no code fence around it, no closing remark.';

/**
 * The reviewer's `claude -p` arguments. The prompt is not among them: it goes
 * on stdin, since a diff can outrun Windows' command-line limit.
 *
 * `--tools ""` is no tool at all, so the reviewer cannot read the checkout,
 * run a command or write a file. `--safe-mode` drops `CLAUDE.md`, plugins,
 * hooks and settings, and `--strict-mcp-config` with no config is no MCP
 * server. What it knows is what the prompt holds.
 */
export function diffReviewArgs(): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--system-prompt',
    DIFF_REVIEW_SYSTEM_PROMPT,
    '--strict-mcp-config',
    '--safe-mode',
    '--tools',
    '',
  ];
}

/** What the reviewer is sent: the finding, the handoff, the diff, and the rules. */
export function diffReviewPrompt(args: { key: string; finding: string; handoff: string; diff: string }): string {
  return [
    'Review the diff below. It is one automated fix for one finding about a website. The finding says what was wrong, and the handoff says what to change.',
    '',
    'Report two kinds of problem, and nothing else:',
    '',
    '1. `unexplained`: a hunk the finding and the handoff do not call for. A change a task in the handoff names is explained, and so is a test the handoff asks for. Judge each hunk on its own.',
    '2. `error`: a new mistake in a changed line. A typo, a missing or doubled space, a punctuation slip, broken markup, or broken syntax. Read every added line character by character, prose inside strings included. A mistake on a line the diff did not change is not reported.',
    '',
    'Do not report style preferences, better wordings, or anything the fix might also have done.',
    '',
    'Reply with exactly this YAML document:',
    '',
    'problems:',
    '  - file: <the path as the diff names it>',
    '    line: <the line number in the new file>',
    '    kind: unexplained | error',
    '    note: <one sentence: what is wrong, quoting the text>',
    '',
    'When there is no problem, reply with exactly:',
    '',
    'problems: []',
    '',
    `The finding, \`${args.key}\`:`,
    '',
    '<finding>',
    args.finding.trim(),
    '</finding>',
    '',
    'The handoff the fix was built from:',
    '',
    '<handoff>',
    args.handoff.trim(),
    '</handoff>',
    '',
    'The diff:',
    '',
    '<diff>',
    args.diff.trimEnd(),
    '</diff>',
  ].join('\n');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the reviewer's reply. A reply that is not a `problems` list of
 * well-formed entries is an error string, never a partial list: a review that
 * half-parsed would read as one that found less than it did.
 */
export function parseDiffReviewReply(raw: string): { problems: DiffProblem[] } | { error: string } {
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fenced = /^```(?:ya?ml)?\n([\s\S]*)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^---\n/, '').replace(/\n---$/, '');
  let data: unknown;
  try {
    data = parseFrontmatter(`---\n${text}\n---\n`).data;
  } catch (err) {
    return { error: `the reply is not YAML (${err instanceof Error ? err.message.split('\n')[0] : String(err)})` };
  }
  if (!isRecord(data) || !Object.prototype.hasOwnProperty.call(data, 'problems')) {
    return { error: 'the reply is not a YAML document with a "problems" key' };
  }
  const list = data.problems ?? [];
  if (!Array.isArray(list)) return { error: '"problems" is not a list' };

  const problems: DiffProblem[] = [];
  for (const [i, entry] of list.entries()) {
    const n = i + 1;
    if (!isRecord(entry)) return { error: `problem ${n} is not a mapping` };
    const { file, line, kind, note } = entry;
    if (typeof file !== 'string' || !file.trim()) return { error: `problem ${n} has no file` };
    if (line != null && !(Number.isInteger(line) && (line as number) > 0)) {
      return { error: `problem ${n} has a line that is not a positive whole number` };
    }
    if (!DIFF_PROBLEM_KINDS.includes(kind as DiffProblemKind)) {
      return { error: `problem ${n} has kind ${JSON.stringify(kind)}, not ${DIFF_PROBLEM_KINDS.join(' or ')}` };
    }
    if (typeof note !== 'string' || !note.trim()) return { error: `problem ${n} has no note` };
    problems.push({
      file: file.trim(),
      line: (line as number | null | undefined) ?? null,
      kind: kind as DiffProblemKind,
      note: note.replace(/\s+/g, ' ').trim(),
    });
  }
  return { problems };
}

/** The draft banner's sentence, or null when the review found nothing and finished. */
export function diffReviewProblem(review: FixerDiffReview): string | null {
  if (review.incomplete) return `**The diff review did not finish.** ${review.incomplete}`;
  const n = review.problems.length;
  if (n === 0) return null;
  return `**The diff review reported ${n === 1 ? 'a problem' : `${n} problems`}.** The fix may have changed more than the finding asks. They are under Review.`;
}

/** The PR body's Review section. */
export function diffReviewLines(review: FixerDiffReview): string[] {
  const lines = [
    '## Review',
    '',
    'A separate model call read this diff against the finding and the handoff, with nothing from the fixer\'s run. It reports hunks the finding does not call for (`unexplained`) and new mistakes in changed lines (`error`). It never edits the diff.',
    '',
  ];
  if (review.incomplete) {
    lines.push(`The review did not finish: ${review.incomplete}`, '');
  } else if (review.problems.length === 0) {
    lines.push('No problems reported.', '');
  } else {
    for (const problem of review.problems) {
      const where = problem.line ? `${problem.file}:${problem.line}` : problem.file;
      lines.push(`- \`${problem.kind}\` \`${where}\`: ${problem.note}`);
    }
    lines.push('');
  }
  return lines;
}
