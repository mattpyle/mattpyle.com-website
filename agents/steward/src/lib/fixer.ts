import { diffReviewLines, diffReviewProblem, type FixerDiffReview } from './diff-review.js';
import type { ParsedFinding } from './findings.js';
import {
  readHandoffVerify,
  unmeasuredSurfaces,
  validateGeneratedBlock,
  verifyBlockGuide,
  verifyCoverageGuide,
  type VerifyCheck,
  type VerifyCheckResult,
  type VerifyCoverageEntry,
} from './verify-checks.js';

/**
 * The fixer's pure half: the handoff it asks for, what `runFixer` passes to
 * Claude Code, what it reads back, and what goes into the PR.
 *
 * Temporal-free and I/O-free like the rest of `lib/`, so the template, the
 * argv, the child's environment, the stream reducer and the PR body are
 * testable without spawning a model.
 */

// ---------------------------------------------------------------------------
// What a headless run may do
// ---------------------------------------------------------------------------

/**
 * The tool allowlist a headless run gets.
 *
 * **No bare file tools.** `Read`, `Glob`, `Grep`, `Edit` and `Write` are left
 * off on purpose: inside the worktree a read needs no rule and
 * `--permission-mode acceptEdits` covers an edit, and outside it a call with no
 * rule is denied. A bare `Read` would be a rule for every path on the machine,
 * the private vault included. Measured with a probe run on 2026-10-10: a `Read`
 * and a `Write` one directory above the working directory were both refused, as
 * was `cat` of the same file.
 *
 * **Compound commands.** Claude Code matches each part of a compound command
 * against the list separately, so `npm run build 2>&1 | tail -20` needs a rule
 * for `tail` as well as for `npm run`. The read-only filters below are what the
 * spike's refused calls piped into. The same probe ran a redirect, a pipe, an
 * environment prefix, `;`, `&&` and `cd x &&` under this list. `echo`, `ls` and
 * `cat` came from the first live run, which had four calls refused for them
 * (`npx tsc ...; echo "tsc=$?"`). A second probe confirmed that the harness
 * still refuses all three on a path outside the working directory, rule or no
 * rule, so they widen nothing beyond the worktree.
 *
 * Two PowerShell forms stay refused whatever the list says, by the harness and
 * not by a rule: a `$env:` assignment and a file redirect. The system prompt
 * sends both to Bash.
 *
 * Both shells are listed because Claude Code on Windows offers both.
 */
export const FIXER_ALLOWED_TOOLS = [
  'Skill',
  'TodoWrite',
  ...['Bash', 'PowerShell'].flatMap((shell) => [
    `${shell}(npm run *)`,
    `${shell}(npm test*)`,
    `${shell}(npx playwright *)`,
    `${shell}(npx astro *)`,
    `${shell}(npx tsc *)`,
    `${shell}(node *)`,
    `${shell}(curl *)`,
    `${shell}(git status*)`,
    `${shell}(git diff*)`,
    `${shell}(git log*)`,
    `${shell}(git show*)`,
  ]),
  'Bash(SHOW_DRAFTS=true npm run *)',
  'Bash(cd *)',
  'Bash(tail *)',
  'Bash(head *)',
  'Bash(grep *)',
  'Bash(wc *)',
  'Bash(echo *)',
  'Bash(ls *)',
  'Bash(cat *)',
  'PowerShell(Select-Object *)',
  'PowerShell(Select-String *)',
];

/**
 * Denied outright, ahead of the allowlist: the activity owns the commit, the
 * push and the PR, so the three are one unit that either all happened or did
 * not, and a branch never reaches the remote from inside the model's turn.
 */
export const FIXER_DISALLOWED_TOOLS = ['Bash', 'PowerShell'].flatMap((shell) => [
  `${shell}(git commit*)`,
  `${shell}(git push*)`,
  `${shell}(gh *)`,
]);

/** The handoff rides in the prompt itself: there is no file for the run to be pointed at. */
export function fixerPrompt(handoff: string): string {
  return `Do the handoff below. It is complete: every fact you need is in it or in this checkout.\n\n${handoff.trim()}\n`;
}

/**
 * What a headless run has to be told that a session at a keyboard would see for
 * itself: where it is, what is absent, who commits, and who runs the checks.
 */
export function fixerSystemPrompt(args: { branch: string; base: string }): string {
  return [
    'You are running headless inside a Steward activity. Nobody can answer a question, so decide and record the decision.',
    `The working directory is a git worktree already on branch ${args.branch}, cut from origin/${args.base}, with dependencies installed. Make every source change here.`,
    'The directories docs/ and steward/ are absent from this worktree on purpose. Skip any instruction in CLAUDE.md that needs them, and write no card, session note, build-log entry or changelog entry.',
    'One finding, one fix: change what the handoff names and nothing beside it.',
    'Leave your changes uncommitted. The activity commits what is in the worktree, pushes the branch and opens the PR.',
    'Use Bash for a command that sets an environment variable or redirects output to a file. PowerShell refuses both here.',
    'Stop any server you started before you finish.',
    'After your turn the activity runs the Verify commands itself and publishes their results. Run them yourself first and leave them passing.',
  ].join('\n');
}

export function claudeArgs(args: { prompt: string; systemPrompt: string }): string[] {
  return [
    '-p',
    args.prompt,
    // `stream-json` rather than `json`: one event per turn is what lets the
    // heartbeat say what the model is doing, and what leaves something to read
    // when the run is killed before it prints a result.
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--append-system-prompt',
    args.systemPrompt,
    // No MCP servers: the user-level ones cost start-up time and none of them
    // is something a handoff may reach for unattended.
    '--strict-mcp-config',
    '--allowedTools',
    FIXER_ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    FIXER_DISALLOWED_TOOLS.join(','),
  ];
}

/**
 * The environment Claude Code runs in: the worker's, minus the worker's secrets.
 *
 * `ANTHROPIC_API_KEY` is the one that changes behaviour rather than only
 * exposure. With it set, `claude -p` bills that key instead of using the
 * machine's own login, so Steward's editorial-pass key would silently pay for
 * every fixer run. The `CLAUDE*` variables go because a worker started from
 * inside a Claude Code session inherits that session's identity.
 */
const STRIPPED_ENV = /^(ANTHROPIC_|TEMPORAL_|STEWARD_|GITHUB_TOKEN$|GH_TOKEN$|CLAUDECODE$|CLAUDE_CODE_)/;

export function fixerChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !STRIPPED_ENV.test(key)));
}

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

export interface ClaudeRunState {
  /** The last thing the model did, for the heartbeat. */
  lastActivity: string;
  model: string | null;
  sessionId: string | null;
  /** Set once the `result` event arrives; null means the run never finished. */
  finalMessage: string | null;
  isError: boolean | null;
  numTurns: number | null;
  costUsd: number | null;
  durationMs: number | null;
  /** Tokens the run read and wrote, cache reads and writes counted as input. Null until the `result` event. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Tool calls the allowlist refused, as `Tool: input`. */
  permissionDenials: string[];
}

export function initialClaudeRunState(): ClaudeRunState {
  return {
    lastActivity: 'starting',
    model: null,
    sessionId: null,
    finalMessage: null,
    isError: null,
    numTurns: null,
    costUsd: null,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    permissionDenials: [],
  };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function describeToolUse(block: { name?: string; input?: Record<string, unknown> }): string {
  const input = block.input ?? {};
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.skill ?? '';
  return clip(`${block.name ?? 'tool'} ${String(detail)}`.trim(), 160);
}

/** The `result` event's input side: fresh, cache-read and cache-written tokens together. */
function inputTokensOf(usage: any): number | null {
  if (!usage || typeof usage.input_tokens !== 'number') return null;
  const n = (value: unknown) => (typeof value === 'number' ? value : 0);
  return usage.input_tokens + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
}

/**
 * Folds one line of `--output-format stream-json` into the run state.
 *
 * A line that is not JSON is ignored rather than thrown on: the stream is a
 * progress feed, and a stray line of hook output must not fail a run whose
 * result event still arrives.
 */
export function reduceClaudeEvent(state: ClaudeRunState, line: string): ClaudeRunState {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return state;
  }
  if (!event || typeof event !== 'object') return state;

  if (event.type === 'system' && event.subtype === 'init') {
    return { ...state, model: event.model ?? null, sessionId: event.session_id ?? null };
  }
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    const tool = event.message.content.findLast((b: any) => b?.type === 'tool_use');
    const text = event.message.content.findLast((b: any) => b?.type === 'text');
    if (tool) return { ...state, lastActivity: describeToolUse(tool) };
    if (text) return { ...state, lastActivity: clip(`said: ${String(text.text).replace(/\s+/g, ' ')}`, 160) };
    return state;
  }
  if (event.type === 'result') {
    return {
      ...state,
      lastActivity: 'finished',
      finalMessage: typeof event.result === 'string' ? event.result : null,
      isError: event.is_error === true,
      numTurns: event.num_turns ?? null,
      costUsd: event.total_cost_usd ?? null,
      durationMs: event.duration_ms ?? null,
      inputTokens: inputTokensOf(event.usage),
      outputTokens: typeof event.usage?.output_tokens === 'number' ? event.usage.output_tokens : null,
      sessionId: event.session_id ?? state.sessionId,
      permissionDenials: Array.isArray(event.permission_denials)
        ? event.permission_denials.map((d: any) =>
            describeToolUse({ name: d?.tool_name, input: d?.tool_input }),
          )
        : [],
    };
  }
  return state;
}

/** Longest final message an activity result carries. */
export const FINAL_MESSAGE_MAX = 8_000;

// ---------------------------------------------------------------------------
// The handoff, generated from a finding
// ---------------------------------------------------------------------------

/** The sections a generated handoff has, in order. Nothing else is allowed at `##`. */
export const HANDOFF_SECTIONS = ['Goal', 'What happened', 'Cause', 'Cases', 'Tasks', 'Verify', 'Out of scope'] as const;

/** The longest title a generated handoff may carry: it becomes the commit subject and the PR title. */
export const HANDOFF_TITLE_MAX = 72;

export interface RepoCommand {
  /** The command as a handoff writes it, and as the PR body shows it. */
  command: string;
  binary: 'npm' | 'npx';
  args: string[];
  about: string;
}

/**
 * The repository's own commands: the ones a generated Verify section may name,
 * and the only ones Steward runs after the model's turn. Fixed here, so what is
 * spawned is this list's argv and never a line a model wrote.
 */
export const REPO_COMMANDS: RepoCommand[] = [
  { command: 'npm run build', binary: 'npm', args: ['run', 'build'], about: 'the production site build, with its validators.' },
  { command: 'npm test', binary: 'npm', args: ['test'], about: 'the site tests under `tests/`.' },
  { command: 'npm run check', binary: 'npm', args: ['run', 'check'], about: '`astro check`.' },
  { command: 'npm run a11y', binary: 'npm', args: ['run', 'a11y'], about: 'the build, then the Playwright accessibility suite.' },
  {
    command: 'npm test -w @mattpyle/steward',
    binary: 'npm',
    args: ['test', '-w', '@mattpyle/steward'],
    about: 'the tests for code under `agents/steward/`.',
  },
  {
    command: 'npx tsc --noEmit -p agents/steward',
    binary: 'npx',
    args: ['tsc', '--noEmit', '-p', 'agents/steward'],
    about: 'the type check for code under `agents/steward/`.',
  },
];

/** The tools the generator gets: it reads the checkout and changes nothing. */
export const HANDOFF_GENERATOR_TOOLS = ['Read', 'Grep', 'Glob'];

/** The generator's whole system prompt. It replaces Claude Code's own. */
export const HANDOFF_SYSTEM_PROMPT =
  'You write build handoffs for a coding agent. You read the code first, with the read-only tools you have. Your final message is the handoff in markdown and nothing else: no preamble, no code fence around it, no closing remark.';

/**
 * The fixed template `generateHandoff` sends, with one finding in it.
 *
 * The model sees the finding and a checkout of the commit the fix branches
 * from, and the handoff it writes is the only document the fixer is given, so
 * the template asks for a handoff that stands alone and refuses the sections a
 * vault handoff carries (`Read first`, `Document`, `Close`).
 * {@link validateHandoff} holds the model to it.
 *
 * The frontmatter's `verify` list is the finding's measure as data, for
 * `verifyFindingWorkflow` to run against production once the fix is live.
 *
 * Cases exists because a finding quotes one example and the code under change
 * handles several: the first generated handoff fixed the example and broke a
 * case the finding never showed.
 */
export function handoffGeneratorPrompt(args: { key: string; finding: string; origin: string }): string {
  return [
    'Write a handoff for a headless coding session that will fix one approved finding on a website.',
    'Your working directory is a checkout of the site repository at the commit the fix will branch from. The session sees your handoff and that same checkout. It sees nothing else, and nobody can answer a question.',
    '',
    'Before you write, read the code the finding\'s cause names: the function, its callers and its tests. A finding quotes one example. The code handles more cases than that one, and the handoff must be right for all of them.',
    '',
    'Rules:',
    '',
    '1. The handoff stands alone. State every fact the builder needs. Name the files, lines and functions as you read them in the checkout. Point at no other document.',
    `2. The title is an imperative phrase of at most ${HANDOFF_TITLE_MAX - 2} characters that names the fix.`,
    '3. Goal: one or two sentences. What a visitor gets once this is fixed.',
    '4. What happened: the finding\'s observation, with the URL and the evidence it quotes.',
    '5. Cause: the cause as the code shows it, with the file path and the function. Correct the finding where the code disagrees with it.',
    '6. Cases: a list of every case the code under change handles, one line each: the case, then its behaviour after the fix. Include the cases that must not change, and say so on their lines.',
    '7. Tasks: numbered. The smallest change that fixes the cause and holds for every line of Cases. One finding, one fix, no adjacent tidying. Add a test when the finding\'s measure names one, and have it cover the cases that must not change.',
    '8. Verify: numbered checks, built from the finding\'s "How to measure". Each check is one command in backticks and its expected result. Then add the test command and the type check for the code the cause is in.',
    '9. Out of scope: what the finding says to leave alone, then merging and deploying.',
    '10. Plain short sentences. Use commas and colons, never an em dash.',
    '11. The handoff opens with YAML frontmatter that holds two keys, `verify` and `verify_coverage`: the checks Steward runs against production after the fix is deployed, and the surfaces the finding names with the checks that measure each. The session that does the handoff ignores both.',
    '',
    'The `verify` list:',
    '',
    ...verifyBlockGuide(args.origin),
    '',
    'Build the checks from the finding\'s "How to measure" and nothing else, the same measure as the Verify section.',
    '',
    'The `verify_coverage` list:',
    '',
    ...verifyCoverageGuide().map((line) => line.replace('write `coverage`', 'write `verify_coverage`')),
    '',
    'Commands that exist in the repository. Write one exactly as it is here, with nothing piped onto it:',
    '',
    ...REPO_COMMANDS.map((entry) => `- \`${entry.command}\`: ${entry.about}`),
    '',
    'Use exactly this structure, with these headings and no others:',
    '',
    '---',
    'verify:',
    '  - url: <a URL on the production origin>',
    '    kind: <kind>',
    '    expect: <what the kind expects>',
    'verify_coverage:',
    '  - surface: <a URL, endpoint, file or page the finding names>',
    '    checks: [<the number of each check that measures it>]',
    '  - surface: <a surface no check can measure>',
    '    reason: <why no check can measure it>',
    '---',
    '',
    '# Handoff: <title>',
    '',
    `Finding: \`${args.key}\``,
    '',
    ...HANDOFF_SECTIONS.flatMap((name) => [`## ${name}`, '']),
    'The finding:',
    '',
    '<finding>',
    args.finding.trim(),
    '</finding>',
  ].join('\n');
}

/** The model's reply as a handoff: an outer code fence and stray blank lines removed. */
export function cleanHandoff(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fenced = /^```(?:markdown|md)?\n([\s\S]*)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  return `${text}\n`;
}

export interface ParsedHandoff {
  /** The H1 without its `Handoff:` label. */
  title: string;
  /** The body of `## Verify`, or null when the handoff has none. */
  verify: string | null;
  /** The numbered items of the Verify section, in order, each on one line. */
  checks: string[];
  /** The list items of the Cases section, in order, each on one line. */
  cases: string[];
}

/** The body of one `##` section, or null when the handoff has none. */
function sectionBody(markdown: string, name: string): string | null {
  const section = markdown.match(new RegExp(`^##\\s+${name}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm'));
  return section ? section[1].trim() : null;
}

/** A section's list items, each on one line with its wrapped lines joined. */
function listItems(body: string | null, marker: RegExp): string[] {
  const items: string[] = [];
  for (const line of (body ?? '').split(/\r?\n/)) {
    const item = marker.exec(line);
    if (item) items.push(item[1].trim());
    else if (items.length > 0 && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

export function parseHandoff(handoff: string): ParsedHandoff {
  const markdown = readHandoffVerify(handoff).body;
  const h1 = markdown.match(/^#\s+(.+?)\s*$/m);
  const title = (h1?.[1] ?? '').replace(/^Handoff:\s*/i, '').trim();
  const verify = sectionBody(markdown, 'Verify');
  return {
    title,
    verify,
    checks: listItems(verify, /^\s{0,3}\d+[.)]\s+(.*)$/),
    cases: listItems(sectionBody(markdown, 'Cases'), /^\s{0,3}(?:\d+[.)]|[-*])\s+(.*)$/),
  };
}

/**
 * What is wrong with a generated handoff, as one line each; empty when it may
 * go to the fixer. A handoff that fails here is never written or run.
 *
 * `origin` is the production origin its `verify` checks must name. The list
 * may be empty; the key may not be missing.
 */
export function validateHandoff(handoff: string, key: string, origin: string): string[] {
  const problems: string[] = [];
  const verify = readHandoffVerify(handoff);
  const markdown = verify.body;
  const lines = markdown.split(/\r?\n/);
  const parsed = parseHandoff(handoff);

  if (!verify.present) problems.push('the frontmatter has no "verify" list');
  else problems.push(...validateGeneratedBlock(verify.raw, verify.coverageRaw, origin).problems);

  if (!/^# Handoff: \S/.test(lines[0] ?? '')) problems.push('the first line is not "# Handoff: <title>"');
  if (parsed.title.length > HANDOFF_TITLE_MAX) {
    problems.push(`the title is ${parsed.title.length} characters, over ${HANDOFF_TITLE_MAX}`);
  }
  if (!markdown.includes(`Finding: \`${key}\``)) problems.push('the "Finding:" line with the key is missing');

  const headings = lines.filter((line) => /^##\s/.test(line)).map((line) => line.replace(/^##\s+/, '').trim());
  if (headings.join(' | ') !== HANDOFF_SECTIONS.join(' | ')) {
    problems.push(`the sections are "${headings.join(', ')}", not "${HANDOFF_SECTIONS.join(', ')}"`);
  }
  if (lines.filter((line) => /^#\s/.test(line)).length !== 1) problems.push('there is not exactly one H1');
  if (parsed.cases.length === 0) problems.push('the Cases section lists no case');
  if (parsed.checks.length === 0) problems.push('the Verify section has no numbered check');
  // The fixer's worktree has neither directory, and a path into one is a
  // pointer at a document the handoff was told to stand without.
  if (/(^|[\s`'"(])(docs|steward)\/[\w.-]/m.test(markdown)) {
    problems.push('it points into docs/ or steward/, which the fixer cannot see');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The checks Steward runs
// ---------------------------------------------------------------------------

export type FixerCheckStatus = 'pass' | 'fail' | 'not-run';

export interface FixerCheckResult {
  /** 1-based, the number of the Verify check in the handoff. */
  n: number;
  status: FixerCheckStatus;
  /** The repository command Steward ran, or null when it ran none. */
  command: string | null;
  /** Why a check was not run. */
  reason?: string;
}

/** Why a check outside {@link REPO_COMMANDS} has no result on the PR. */
export const NOT_RUN_REASON = 'not a repository command';

/**
 * The repository command a Verify check names: the first backtick span that is
 * one of {@link REPO_COMMANDS}, whole. A command with anything added to it (a
 * pipe, a flag, a second command) is not one of them.
 */
export function repoCommandFor(check: string): RepoCommand | null {
  for (const span of check.matchAll(/`([^`]+)`/g)) {
    const text = span[1].replace(/\s+/g, ' ').trim();
    const found = REPO_COMMANDS.find((entry) => entry.command === text);
    if (found) return found;
  }
  return null;
}

/**
 * Runs a handoff's Verify checks through `exec` and reads pass or fail off the
 * exit code.
 *
 * Only a check that names one of {@link REPO_COMMANDS} reaches `exec`, and what
 * it is handed is that entry, not the handoff's text: a command a model wrote
 * is never run. Every other check is `not-run`, since a check against the live
 * site cannot pass before the fix is deployed. A command two checks name runs
 * once.
 */
export async function runVerifyChecks(
  checks: string[],
  exec: (command: RepoCommand) => Promise<number>,
): Promise<FixerCheckResult[]> {
  const exits = new Map<string, number>();
  const results: FixerCheckResult[] = [];
  for (const [i, check] of checks.entries()) {
    const entry = repoCommandFor(check);
    if (!entry) {
      results.push({ n: i + 1, status: 'not-run', command: null, reason: NOT_RUN_REASON });
      continue;
    }
    if (!exits.has(entry.command)) exits.set(entry.command, await exec(entry));
    results.push({ n: i + 1, status: exits.get(entry.command) === 0 ? 'pass' : 'fail', command: entry.command });
  }
  return results;
}

// ---------------------------------------------------------------------------
// The PR
// ---------------------------------------------------------------------------

/**
 * The `verify` block's two tests: on production before the fixer runs, where
 * every check must fail, and on the PR's preview after it opens, where every
 * check must pass.
 */
export interface FixerSiteChecks {
  /** Whose block: the finding's own, or the handoff's. */
  source: 'finding' | 'handoff';
  /** True when the handoff's block was written again after it passed on production. */
  regenerated: boolean;
  /** Why writing the handoff's block again failed, when it did. The first block stands. */
  regenerateError: string | null;
  /** The block as run, on the production origin. Empty when no check can measure the finding. */
  block: VerifyCheck[];
  /**
   * Each surface the finding names, with the checks that measure it or why
   * none can. Null for a finding's own block, and for a handoff that predates
   * the map; absent from a run that predates it.
   */
  coverage?: VerifyCoverageEntry[] | null;
  /** Each check on production before the fix, or null when the test did not run. */
  production: VerifyCheckResult[] | null;
  /** Why the production test has no rows. */
  productionNote: string | null;
  /** Each check on the preview, or null until it has run. */
  preview: VerifyCheckResult[] | null;
  /** Why the preview test has no rows. */
  previewNote: string | null;
}

export interface FixerPrBodyInput {
  key: string;
  finding: ParsedFinding;
  /** The handoff's Verify checks, in order. */
  checks: string[];
  results: FixerCheckResult[];
  filesChanged: string[];
  exitCode: number;
  timedOut: boolean;
  /** The `verify` block's tests. Absent from a run that predates them. */
  site?: FixerSiteChecks | null;
  /** The diff review. Absent from a run that predates it. */
  review?: FixerDiffReview | null;
}

/** True when the run did not end the way a finished one does: killed at its limit, or a non-zero exit. */
export function isIncompleteRun(run: { exitCode: number; timedOut: boolean }): boolean {
  return run.timedOut || run.exitCode !== 0;
}

/** "Check 2", "Checks 1 and 3", "Checks 1, 2 and 4". */
function checksLabel(numbers: number[]): string {
  if (numbers.length === 1) return `Check ${numbers[0]}`;
  return `Checks ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

/**
 * What the `verify` block's tests found wrong, one bold-led sentence each,
 * after one for the surfaces its coverage map gives no check. Empty when every
 * surface has a check, every check failed on production and passed on the
 * preview or the preview has not run yet.
 */
export function siteCheckProblems(site: FixerSiteChecks): string[] {
  const problems: string[] = [];
  const unmeasured = unmeasuredSurfaces(site.coverage ?? []);
  if (unmeasured.length > 0) {
    const one = unmeasured.length === 1;
    problems.push(
      `**${one ? 'A surface' : `${unmeasured.length} surfaces`} the finding names ${one ? 'has' : 'have'} no check.** ${one ? 'Its reason is' : 'Their reasons are'} under Verify; a person decides whether the fix holds there.`,
    );
  }
  if (site.block.length === 0) return problems;
  if (site.productionNote) problems.push(`**The production test did not run.** ${site.productionNote}`);
  const passing = (site.production ?? []).filter((row) => row.pass).map((row) => row.n);
  if (passing.length > 0) {
    const one = passing.length === 1;
    problems.push(
      `**${checksLabel(passing)} already ${one ? 'passes' : 'pass'} on production.** Before the fix, so ${one ? 'it does' : 'they do'} not show the defect.`,
    );
  }
  if (site.previewNote) problems.push(`**The preview was not measured.** ${site.previewNote}`);
  const failing = (site.preview ?? []).filter((row) => !row.pass).map((row) => row.n);
  if (failing.length > 0) {
    problems.push(`**${checksLabel(failing)} ${failing.length === 1 ? 'fails' : 'fail'} on the preview.** The fix does not hold there.`);
  }
  return problems;
}

/**
 * True when the PR opens as a draft, or is turned into one: the run was
 * incomplete, a check Steward ran failed, the `verify` block's tests found a
 * problem, or the diff review reported one or did not finish.
 */
export function opensAsDraft(run: {
  exitCode: number;
  timedOut: boolean;
  checks: FixerCheckResult[];
  site?: FixerSiteChecks | null;
  review?: FixerDiffReview | null;
}): boolean {
  return (
    isIncompleteRun(run) ||
    run.checks.some((check) => check.status === 'fail') ||
    (run.site ? siteCheckProblems(run.site).length > 0 : false) ||
    (run.review ? diffReviewProblem(run.review) !== null : false)
  );
}

/** The coverage map's part of the Verify section. */
function coverageLines(site: FixerSiteChecks): string[] {
  if (!site.coverage) {
    return [
      site.source === 'finding'
        ? "Coverage not mapped (the finding's own block)."
        : 'Coverage not mapped (the handoff predates the map).',
      '',
    ];
  }
  const lines = ['The surfaces the finding names, and the checks on the site that measure each:', ''];
  for (const entry of site.coverage) {
    lines.push(
      'checks' in entry
        ? `- \`${entry.surface}\`: ${checksLabel(entry.checks).replace(/^C/, 'c')}.`
        : `- \`${entry.surface}\`: no check. ${entry.reason}`,
    );
  }
  lines.push('');
  return lines;
}

/** The `verify` block's part of the Verify section. */
function siteCheckLines(site: FixerSiteChecks): string[] {
  if (site.block.length === 0) {
    return [
      'No check on the site can measure this finding: its `verify` block is empty. The fix is unverifiable by checks.',
      '',
      ...coverageLines(site),
    ];
  }
  let whose = site.source === 'finding' ? "the finding's own `verify` block" : "the handoff's `verify` block";
  if (site.regenerated) whose += ', written a second time because the first one passed on production before the fix';
  const lines = [
    `The checks on the site, from ${whose}. Each runs on production before the fix, where it must fail, and on this PR's preview, where it must pass.`,
  ];
  if (site.regenerateError) lines.push('', `Writing the block a second time failed, so the first one stands: ${site.regenerateError}`);
  lines.push('');
  site.block.forEach((check, i) => {
    const n = i + 1;
    const production = site.production?.find((row) => row.n === n);
    const preview = site.preview?.find((row) => row.n === n);
    lines.push(`${n}. \`${check.kind}\` ${check.url}`);
    const expected = production?.expected ?? preview?.expected;
    if (expected) lines.push(`   - Expects: ${expected}`);
    lines.push(
      production
        ? `   - Production, before the fix: ${production.measured}. ${production.pass ? 'Passes, so it does not show the defect.' : 'Fails, as it should.'}`
        : '   - Production, before the fix: not measured.',
    );
    lines.push(
      preview
        ? `   - Preview: ${preview.measured}. ${preview.pass ? 'Pass.' : 'Fail.'}`
        : `   - Preview: ${site.previewNote ? 'not measured.' : 'not measured yet.'}`,
    );
  });
  lines.push('', ...coverageLines(site));
  return lines;
}

/**
 * The PR body, written from the finding (the card's decision 5).
 *
 * Every sentence in it comes from the finding, the handoff's Verify list, the
 * checks Steward ran or git. The model's final message is not an input.
 */
export function buildFixerPrBody(input: FixerPrBodyInput): string {
  const { finding } = input;
  const lines: string[] = [];
  if (isIncompleteRun(input)) {
    lines.push(
      `> **Incomplete run.** Claude Code ${input.timedOut ? 'was stopped at its time limit' : `exited ${input.exitCode}`}. This PR holds what it left behind.`,
      '',
    );
  }
  const failed = input.results.filter((result) => result.status === 'fail').length;
  if (failed > 0) {
    lines.push(
      `> **${failed === 1 ? 'A check failed' : `${failed} checks failed`}.** Steward ran the Verify commands on this branch after the run. The results are under Verify.`,
      '',
    );
  }
  for (const problem of input.site ? siteCheckProblems(input.site) : []) lines.push(`> ${problem}`, '');
  const reviewProblem = input.review ? diffReviewProblem(input.review) : null;
  if (reviewProblem) lines.push(`> ${reviewProblem}`, '');
  lines.push(`Fixes one finding from Argus, the site's inspector: ${finding.title}`, '');

  lines.push('## Evidence', '');
  for (const bullet of finding.evidence) {
    lines.push(bullet.label ? `- ${bullet.label}: ${bullet.text}` : `- ${bullet.text}`);
  }
  lines.push('');

  lines.push('## Cause', '', finding.cause ?? '_The finding names no cause._', '');

  lines.push('## Changed', '');
  for (const file of input.filesChanged) lines.push(`- \`${file}\``);
  lines.push('');

  lines.push('## Verify', '');
  if (finding.measure) lines.push(`The finding's measure: ${finding.measure}`, '');
  // A list rather than a table: a check or a command may carry a pipe, and a
  // list needs nothing escaped.
  input.checks.forEach((check, i) => {
    const result = input.results.find((r) => r.n === i + 1);
    lines.push(`${i + 1}. ${check.replace(/[\r\n]+/g, ' ').trim()}`);
    const status = result?.status ?? 'not-run';
    lines.push(`   - Result: ${result?.reason ? `${status} (${result.reason})` : status}`);
    if (result?.command) lines.push(`   - Command: \`${result.command}\``);
  });
  lines.push('');
  if (input.site) lines.push(...siteCheckLines(input.site));
  if (input.review) lines.push(...diffReviewLines(input.review));

  lines.push(
    `Finding: \`${input.key}\``,
    '',
    '---',
    '',
    "*Opened by Steward's fixer: Claude Code, headless, on one approved finding. Steward never merges.*",
  );
  return lines.join('\n');
}
