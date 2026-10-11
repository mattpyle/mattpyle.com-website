import type { ParsedFinding } from './findings.js';

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
 * environment prefix, `;`, `&&` and `cd x &&` under this list.
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
 * itself: where it is, what is absent, who commits, and how to report.
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
    'End your final message with one fenced json block that reports every numbered Verify check, in this shape: {"checks":[{"n":1,"status":"pass","command":"npm test"}]}. "status" is pass, fail or not-run. "command" is the one command whose result decided it.',
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
    permissionDenials: [],
  };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function describeToolUse(block: { name?: string; input?: Record<string, unknown> }): string {
  const input = block.input ?? {};
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.skill ?? '';
  return clip(`${block.name ?? 'tool'} ${String(detail)}`.trim(), 160);
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
export const HANDOFF_SECTIONS = ['Goal', 'What happened', 'Cause', 'Tasks', 'Verify', 'Out of scope'] as const;

/** The longest title a generated handoff may carry: it becomes the commit subject and the PR title. */
export const HANDOFF_TITLE_MAX = 72;

/**
 * The commands a generated Verify section may name. Fixed here, because the
 * generator sees the finding and nothing of the repository.
 */
const REPO_COMMANDS = [
  '`npm run build`: the production site build, with its validators.',
  '`npm test`: the site tests under `tests/`.',
  '`npm run check`: `astro check`.',
  '`npm run a11y`: the build, then the Playwright accessibility suite.',
  '`npm test -w @mattpyle/steward`: the tests for code under `agents/steward/`.',
  '`npx tsc --noEmit -p agents/steward`: the type check for code under `agents/steward/`.',
];

/** The generator's whole system prompt. It replaces Claude Code's own. */
export const HANDOFF_SYSTEM_PROMPT =
  'You write build handoffs for a coding agent. You reply with the handoff in markdown and nothing else: no preamble, no code fence around it, no closing remark.';

/**
 * The fixed template `generateHandoff` sends, with one finding in it.
 *
 * The finding is the only document the model sees, and the handoff it writes is
 * the only document the fixer sees, so the template asks for a handoff that
 * stands alone and refuses the sections a vault handoff carries (`Read first`,
 * `Document`, `Close`). {@link validateHandoff} holds the model to it.
 */
export function handoffGeneratorPrompt(args: { key: string; finding: string }): string {
  return [
    'Write a handoff for a headless coding session that will fix one approved finding on a website.',
    'The session sees your handoff and a checkout of the site repository. It sees nothing else, and nobody can answer a question.',
    '',
    'Rules:',
    '',
    '1. The handoff stands alone. State every fact the builder needs. Name the files, lines and functions the finding names. Point at no other document.',
    `2. The title is an imperative phrase of at most ${HANDOFF_TITLE_MAX - 2} characters that names the fix.`,
    '3. Goal: one or two sentences. What a visitor gets once this is fixed.',
    '4. What happened: the finding\'s observation, with the URL and the evidence it quotes.',
    '5. Cause: the cause the finding names, with the file path and the function.',
    '6. Tasks: numbered. The smallest change that fixes the cause. One finding, one fix, no adjacent tidying. Add a test when the finding\'s measure names one.',
    '7. Verify: numbered checks, built from the finding\'s "How to measure". Each check is one command and its expected result. Then add the test command and the type check for the code the cause is in.',
    '8. Out of scope: what the finding says to leave alone, then merging and deploying.',
    '9. Plain short sentences. Use commas and colons, never an em dash.',
    '',
    'Commands that exist in the repository:',
    '',
    ...REPO_COMMANDS.map((line) => `- ${line}`),
    '',
    'Use exactly this structure, with these headings and no others:',
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
}

export function parseHandoff(markdown: string): ParsedHandoff {
  const h1 = markdown.match(/^#\s+(.+?)\s*$/m);
  const title = (h1?.[1] ?? '').replace(/^Handoff:\s*/i, '').trim();
  const verify = markdown.match(/^##\s+Verify\s*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  const body = verify ? verify[1].trim() : null;
  const checks: string[] = [];
  for (const line of (body ?? '').split(/\r?\n/)) {
    const item = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
    if (item) checks.push(item[1].trim());
    else if (checks.length > 0 && /^\s+\S/.test(line)) checks[checks.length - 1] += ` ${line.trim()}`;
  }
  return { title, verify: body, checks };
}

/**
 * What is wrong with a generated handoff, as one line each; empty when it may
 * go to the fixer. A handoff that fails here is never written or run.
 */
export function validateHandoff(markdown: string, key: string): string[] {
  const problems: string[] = [];
  const lines = markdown.split(/\r?\n/);
  const parsed = parseHandoff(markdown);

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
  if (parsed.checks.length === 0) problems.push('the Verify section has no numbered check');
  // The fixer's worktree has neither directory, and a path into one is a
  // pointer at a document the handoff was told to stand without.
  if (/(^|[\s`'"(])(docs|steward)\/[\w.-]/m.test(markdown)) {
    problems.push('it points into docs/ or steward/, which the fixer cannot see');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// What the run reported
// ---------------------------------------------------------------------------

export type FixerCheckStatus = 'pass' | 'fail' | 'not-run';

export interface FixerCheckResult {
  /** 1-based, the number of the Verify check in the handoff. */
  n: number;
  status: FixerCheckStatus;
  /** The command that decided it, on one line, or null. */
  command: string | null;
}

/**
 * The check results in the model's final message: the last fenced json block,
 * read strictly. Anything that is not a known status on a real check number is
 * dropped, and a command is cut to one short line with no backticks.
 *
 * This is the only part of the final message that reaches the PR, and it is
 * three narrow fields rather than prose, so the message's own framing (and its
 * attribution line, which the spike published) stays in the activity result.
 */
export function parseFixerChecks(finalMessage: string | null, checkCount: number): FixerCheckResult[] {
  if (!finalMessage) return [];
  const blocks = [...finalMessage.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n\s*```/g)];
  for (const block of blocks.reverse()) {
    let parsed: any;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed?.checks)) continue;
    const results = new Map<number, FixerCheckResult>();
    for (const entry of parsed.checks) {
      const n = Number(entry?.n);
      if (!Number.isInteger(n) || n < 1 || n > checkCount) continue;
      if (entry.status !== 'pass' && entry.status !== 'fail' && entry.status !== 'not-run') continue;
      const command =
        typeof entry.command === 'string' && entry.command.trim()
          ? clip(entry.command.replace(/[`\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim(), 160)
          : null;
      results.set(n, { n, status: entry.status, command });
    }
    return [...results.values()].sort((a, b) => a.n - b.n);
  }
  return [];
}

// ---------------------------------------------------------------------------
// The PR
// ---------------------------------------------------------------------------

/** One line of prose for a table cell. */
const cell = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();

export interface FixerPrBodyInput {
  key: string;
  finding: ParsedFinding;
  /** The handoff's Verify checks, in order. */
  checks: string[];
  results: FixerCheckResult[];
  filesChanged: string[];
  exitCode: number;
  timedOut: boolean;
}

/** True when the run did not end the way a finished one does: killed at its limit, or a non-zero exit. */
export function isIncompleteRun(run: { exitCode: number; timedOut: boolean }): boolean {
  return run.timedOut || run.exitCode !== 0;
}

/**
 * The PR body, written from the finding (the card's decision 5).
 *
 * Every sentence in it comes from the finding, the handoff's Verify list or
 * git. The model's final message is not an input.
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
  lines.push('| Check | Result | Command |', '|---|---|---|');
  input.checks.forEach((check, i) => {
    const result = input.results.find((r) => r.n === i + 1);
    lines.push(
      `| ${i + 1}. ${cell(check)} | ${result ? result.status : 'not reported'} | ${result?.command ? `\`${result.command}\`` : ''} |`,
    );
  });
  lines.push('');

  lines.push(
    `Finding: \`${input.key}\``,
    '',
    '---',
    '',
    "*Opened by Steward's fixer: Claude Code, headless, on one approved finding. Steward never merges.*",
  );
  return lines.join('\n');
}
