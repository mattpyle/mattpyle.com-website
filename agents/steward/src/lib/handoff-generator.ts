import { runClaude } from './claude-runner.js';
import {
  HANDOFF_GENERATOR_TOOLS,
  HANDOFF_SYSTEM_PROMPT,
  cleanHandoff,
  fixerChildEnv,
  handoffGeneratorPrompt,
  validateHandoff,
} from './fixer.js';
import { parseVerifyReply, validateVerifyBlock, verifyBlockGuide, type VerifyCheck } from './verify-checks.js';

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
  /** The production origin the handoff's verify checks name. */
  origin: string;
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

export function handoffGeneratorArgs(prompt: string, systemPrompt: string = HANDOFF_SYSTEM_PROMPT): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--system-prompt',
    systemPrompt,
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
    argv: handoffGeneratorArgs(handoffGeneratorPrompt({ key: options.key, finding: options.findingText, origin: options.origin })),
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
    problems: handoff ? validateHandoff(handoff, options.key, options.origin) : [],
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

/** The block generator's whole system prompt. */
export const VERIFY_BLOCK_SYSTEM_PROMPT =
  'You turn a finding about a website into checks a program runs against the live site. You read the code first, with the read-only tools you have. Your final message is one YAML document and nothing else: no preamble, no code fence around it, no closing remark.';

/**
 * What the block generator is sent: a finding whose fix is live, the handoff
 * the fix was built from, and the rules of the block.
 */
export function verifyBlockPrompt(args: { key: string; finding: string; handoff: string; origin: string }): string {
  return [
    'Write the checks that show one fixed finding is fixed on the live site.',
    `The fix is merged and deployed at ${args.origin}. Your working directory is a checkout of the site repository with the fix in it. Read the code the handoff changed, so each check expects what the site now serves.`,
    '',
    ...verifyBlockGuide(args.origin),
    '',
    'Reply with exactly this YAML document:',
    '',
    'verify:',
    '  - url: <a URL on the production origin>',
    '    kind: <kind>',
    '    expect: <what the kind expects>',
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
  ].join('\n');
}

export interface VerifyBlockDraft {
  /** The validated checks, or null when the run ended without a block or with one that was refused. */
  checks: VerifyCheck[] | null;
  /** What {@link validateVerifyBlock} refuses in the reply. */
  problems: string[];
  cancelled: boolean;
  exitCode: number;
  timedOut: boolean;
  stalled: boolean;
  stderrTail: string;
  claude: HandoffDraft['claude'];
}

/**
 * One `claude -p` run, with the handoff generator's tools and limits, that
 * writes the `verify` block for a handoff that has none.
 */
export async function draftVerifyBlock(
  options: HandoffDraftOptions & { handoff: string },
): Promise<VerifyBlockDraft> {
  const run = await runClaude({
    command: 'claude',
    argv: handoffGeneratorArgs(
      verifyBlockPrompt({ key: options.key, finding: options.findingText, handoff: options.handoff, origin: options.origin }),
      VERIFY_BLOCK_SYSTEM_PROMPT,
    ),
    cwd: options.cwd,
    env: fixerChildEnv(process.env),
    signal: options.signal,
    timeoutMs: GENERATOR_TIMEOUT_MS,
    stallMs: GENERATOR_STALL_MS,
    onActivity: options.onActivity,
  });
  const reply = run.exitCode === 0 && run.state.finalMessage ? parseVerifyReply(run.state.finalMessage) : null;
  const validated = reply ? (reply.present ? validateVerifyBlock(reply.raw, options.origin) : null) : null;
  return {
    checks: validated && validated.problems.length === 0 ? validated.checks : null,
    problems: reply && !reply.present ? ['the reply is not a YAML document with a "verify" key'] : (validated?.problems ?? []),
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
