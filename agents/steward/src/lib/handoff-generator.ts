import { runClaude } from './claude-runner.js';
import {
  HANDOFF_GENERATOR_TOOLS,
  HANDOFF_SYSTEM_PROMPT,
  cleanHandoff,
  fixerChildEnv,
  handoffGeneratorPrompt,
  validateHandoff,
} from './fixer.js';

/**
 * One `claude -p` run that turns a finding into a handoff, reading the checkout
 * it is started in.
 *
 * **What the model can reach.** `--tools` names `Read`, `Grep` and `Glob` and
 * nothing else, so it has no shell and no write tool. `--strict-mcp-config`
 * with no config is no MCP server. `--safe-mode` drops every customization
 * (`CLAUDE.md`, plugins, hooks, settings files) and confines the file tools to
 * the working directory, so the checkout and the finding are all it reads.
 *
 * Apart from the activity so a handoff can be regenerated against any checkout
 * without a write to the findings repository.
 */

/** A dozen reads and one long reply: ten minutes is a hung run. */
export const GENERATOR_TIMEOUT_MS = 10 * 60_000;

/** The stream carries an event per turn, and a read returns in seconds. */
export const GENERATOR_STALL_MS = 4 * 60_000;

export interface HandoffDraftOptions {
  key: string;
  /** The finding file, frontmatter included. */
  findingText: string;
  /** A checkout of the commit the fix will branch from. */
  cwd: string;
  signal: AbortSignal;
  onActivity?: (activity: string) => void;
}

export interface HandoffDraft {
  /** The cleaned reply, or null when the run ended without one. */
  handoff: string | null;
  /** What {@link validateHandoff} refuses in it; empty when it may go to the fixer. */
  problems: string[];
  cancelled: boolean;
  exitCode: number;
  timedOut: boolean;
  stalled: boolean;
  stderrTail: string;
  claude: { model: string | null; costUsd: number | null; durationMs: number | null; numTurns: number | null };
}

export function handoffGeneratorArgs(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--system-prompt',
    HANDOFF_SYSTEM_PROMPT,
    '--strict-mcp-config',
    '--safe-mode',
    // One argument: the flag is variadic and would take whatever followed.
    '--tools',
    HANDOFF_GENERATOR_TOOLS.join(','),
  ];
}

export async function draftHandoff(options: HandoffDraftOptions): Promise<HandoffDraft> {
  const run = await runClaude({
    command: 'claude',
    argv: handoffGeneratorArgs(handoffGeneratorPrompt({ key: options.key, finding: options.findingText })),
    cwd: options.cwd,
    env: fixerChildEnv(process.env),
    signal: options.signal,
    timeoutMs: GENERATOR_TIMEOUT_MS,
    stallMs: GENERATOR_STALL_MS,
    onActivity: options.onActivity,
  });
  const handoff = run.exitCode === 0 && run.state.finalMessage ? cleanHandoff(run.state.finalMessage) : null;
  return {
    handoff,
    problems: handoff ? validateHandoff(handoff, options.key) : [],
    cancelled: run.cancelled,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    stalled: run.stalled,
    stderrTail: run.stderrTail,
    claude: {
      model: run.state.model,
      costUsd: run.state.costUsd,
      durationMs: run.state.durationMs,
      numTurns: run.state.numTurns,
    },
  };
}
