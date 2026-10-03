/**
 * The fixer spike's pure half: what `runFixer` passes to Claude Code, what it
 * reads back, and what it writes into the PR.
 *
 * Temporal-free and I/O-free like the rest of `lib/`, so the argv, the child's
 * environment and the stream reducer are testable without spawning a model.
 */

/**
 * The tool allowlist a headless run gets.
 *
 * `--permission-mode acceptEdits` covers file edits inside the worktree and the
 * `--add-dir` directory; this list covers everything else a handoff's Verify
 * section asks for. In `-p` mode a tool outside it is denied rather than
 * prompted, and the denial is reported in the result event, so the list can
 * start narrow and grow from evidence.
 *
 * Both shells are listed because Claude Code on Windows offers both.
 */
export const FIXER_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Skill',
  'TodoWrite',
  ...['Bash', 'PowerShell'].flatMap((shell) => [
    `${shell}(npm run *)`,
    `${shell}(npx playwright *)`,
    `${shell}(npx astro *)`,
    `${shell}(node *)`,
    `${shell}(curl *)`,
    `${shell}(git status*)`,
    `${shell}(git diff*)`,
    `${shell}(git log*)`,
    `${shell}(git show*)`,
  ]),
  'Bash(SHOW_DRAFTS=true npm run *)',
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

/** The one-line opener the handoff convention uses. */
export function fixerPrompt(handoffAbsPath: string): string {
  return `Read ${handoffAbsPath} and do it.`;
}

/**
 * What a headless run has to be told that a session at a keyboard would see for
 * itself: where it is, where the vault is, and who commits.
 */
export function fixerSystemPrompt(args: { branch: string; base: string; vaultDir: string }): string {
  return [
    'You are running headless inside a Steward activity. Nobody can answer a question, so decide and record the decision.',
    `The working directory is a git worktree already on branch ${args.branch}, cut from origin/${args.base}, with dependencies installed. Make every source change here.`,
    `The private vault is outside this worktree, at ${args.vaultDir}. Every docs/ path in the handoff, the card and CLAUDE.md resolves there.`,
    'Leave your changes uncommitted. The activity commits what is in the worktree, pushes the branch and opens the PR.',
    'Stop any server you started before you finish.',
    'Your final message is published verbatim in the public PR body. Write it for a stranger: what changed, then each Verify step with the command and its result. No vault paths and no process narrative.',
  ].join('\n');
}

export function claudeArgs(args: {
  prompt: string;
  systemPrompt: string;
  addDir: string;
}): string[] {
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
    '--add-dir',
    args.addDir,
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

export interface ParsedHandoff {
  /** The H1 without its `Handoff:` label. */
  title: string;
  /** The body of `## Verify`, or null when the handoff has none. */
  verify: string | null;
}

export function parseHandoff(markdown: string): ParsedHandoff {
  const h1 = markdown.match(/^#\s+(.+?)\s*$/m);
  const title = (h1?.[1] ?? '').replace(/^Handoff:\s*/i, '').trim();
  const verify = markdown.match(/^##\s+Verify\s*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return { title, verify: verify ? verify[1].trim() : null };
}

/** Longest final message a PR body or an activity result carries. */
export const FINAL_MESSAGE_MAX = 8_000;

export function buildFixerPrBody(args: {
  verify: string | null;
  finalMessage: string | null;
  exitCode: number;
  timedOut: boolean;
}): string {
  const lines: string[] = [];
  if (args.timedOut || args.exitCode !== 0) {
    lines.push(
      `> **Incomplete run.** Claude Code ${args.timedOut ? 'was stopped at its time limit' : `exited ${args.exitCode}`}. This PR holds what it left behind.`,
      '',
    );
  }
  lines.push('## What the run reported', '');
  lines.push(
    args.finalMessage ? clip(args.finalMessage.trim(), FINAL_MESSAGE_MAX) : '_The run ended without a final message._',
    '',
  );
  if (args.verify) lines.push('## Verify steps it was given', '', args.verify, '');
  lines.push(
    '---',
    '',
    '*Written by Claude Code, headless, in a Steward activity. Steward never merges.*',
  );
  return lines.join('\n');
}
