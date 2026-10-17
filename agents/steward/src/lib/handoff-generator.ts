import { runClaude } from './claude-runner.js';
import {
  HANDOFF_GENERATOR_TOOLS,
  HANDOFF_SYSTEM_PROMPT,
  cleanHandoff,
  fixerChildEnv,
  handoffGeneratorPrompt,
  validateHandoff,
} from './fixer.js';
import {
  parseVerifyReply,
  urlLabel,
  validateGeneratedBlock,
  verifyBlockGuide,
  verifyCoverageGuide,
  type VerifyCheck,
  type VerifyCoverageEntry,
  type VerifyCheckResult,
} from './verify-checks.js';

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

/** The shape of the block generator's reply: the block and its coverage map. */
const VERIFY_REPLY_TEMPLATE = [
  'verify:',
  '  - url: <a URL on the production origin>',
  '    kind: <kind>',
  '    expect: <what the kind expects>',
  'coverage:',
  '  - surface: <a URL, endpoint, file or page the finding names>',
  '    checks: [<the number of each check that measures it>]',
  '  - surface: <a surface no check can measure>',
  '    reason: <why no check can measure it>',
];

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
    'Build the checks from the finding\'s "How to measure" and nothing else, as the handoff\'s Verify section reads it.',
    '',
    ...verifyCoverageGuide(),
    '',
    'Reply with exactly this YAML document:',
    '',
    ...VERIFY_REPLY_TEMPLATE,
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

/**
 * What the handoff's first block measured on production before the fix: every
 * check's row, or the reason the test could not finish. The regeneration is
 * told it, so it can see which checks do not show the defect.
 */
export interface VerifyBlockRejection {
  /** The block as it was run. */
  checks: VerifyCheck[];
  /** One row per check, or null when a check's own expression did not run. */
  results: VerifyCheckResult[] | null;
  /** Why the test could not finish, when it could not. */
  broken: string | null;
}

/**
 * What the block generator is sent when the handoff's block failed its
 * production test: the finding, the handoff, the first block and what each of
 * its checks measured on production before the fix.
 *
 * Unlike {@link verifyBlockPrompt}, the fix is not written yet. The checkout is
 * the commit the fix will branch from, so a check must fail against it.
 */
export function verifyBlockRetryPrompt(args: {
  key: string;
  finding: string;
  handoff: string;
  origin: string;
  rejected: VerifyBlockRejection;
}): string {
  const { rejected } = args;
  const measured = rejected.results
    ? rejected.results.map((row) => {
        const check = rejected.checks[row.n - 1];
        return `${row.n}. \`${row.kind}\` ${urlLabel(row.url)}, expect ${JSON.stringify(check?.expect)}: measured ${row.measured}. ${row.pass ? 'It PASSES before the fix, so it does not show the defect.' : 'It fails before the fix, as it should.'}`;
      })
    : rejected.checks.map((check, i) => `${i + 1}. \`${check.kind}\` ${urlLabel(check.url)}, expect ${JSON.stringify(check.expect)}`);
  return [
    'Write the checks that will show one finding is fixed on the live site.',
    `The fix is not written yet. Production at ${args.origin} still has the defect, and your working directory is a checkout of the site repository at the commit the fix will branch from. Every check must fail on production now and pass once the fix is live.`,
    '',
    'A first block was written for this handoff and run against production before the fix. It did not hold:',
    '',
    ...measured,
    ...(rejected.broken ? ['', `The test could not finish: ${rejected.broken}`] : []),
    '',
    'Write the whole block again. Keep a check that fails before the fix only if it measures the defect the finding describes. Replace every check that passes: read the page source and the code, and expect the value the fixed page will serve, which the page does not serve now.',
    '',
    ...verifyBlockGuide(args.origin),
    '',
    'Build the checks from the finding\'s "How to measure" and nothing else, as the handoff\'s Verify section reads it.',
    '',
    ...verifyCoverageGuide(),
    '',
    'Reply with exactly this YAML document:',
    '',
    ...VERIFY_REPLY_TEMPLATE,
    '',
    `The finding, \`${args.key}\`:`,
    '',
    '<finding>',
    args.finding.trim(),
    '</finding>',
    '',
    'The handoff the fix will be built from:',
    '',
    '<handoff>',
    args.handoff.trim(),
    '</handoff>',
  ].join('\n');
}

export interface VerifyBlockDraft {
  /** The validated checks, or null when the run ended without a block or with one that was refused. */
  checks: VerifyCheck[] | null;
  /** The validated coverage map, or null whenever `checks` is. */
  coverage: VerifyCoverageEntry[] | null;
  /** What {@link validateGeneratedBlock} refuses in the reply. */
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
 * writes the `verify` block for a handoff that has none, or writes it again
 * when `rejected` says the first one passed on production before the fix.
 */
export async function draftVerifyBlock(
  options: HandoffDraftOptions & { handoff: string; rejected?: VerifyBlockRejection },
): Promise<VerifyBlockDraft> {
  const prompt = { key: options.key, finding: options.findingText, handoff: options.handoff, origin: options.origin };
  const run = await runClaude({
    command: 'claude',
    argv: handoffGeneratorArgs(
      options.rejected ? verifyBlockRetryPrompt({ ...prompt, rejected: options.rejected }) : verifyBlockPrompt(prompt),
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
  const validated = reply?.present ? validateGeneratedBlock(reply.raw, reply.coverageRaw, options.origin) : null;
  const valid = validated !== null && validated.problems.length === 0;
  return {
    checks: valid ? validated.checks : null,
    coverage: valid ? validated.coverage : null,
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
