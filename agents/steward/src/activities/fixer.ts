import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';
import { FIXER_WORKTREE_DIR, GITHUB_REPO, SITE_DIR, STEWARD_DIR } from '../config.js';
import { runClaude } from '../lib/claude-runner.js';
import { parseFindingBody } from '../lib/findings.js';
import { git, needsInstall, recordInstall, worktreeExists } from '../lib/git.js';
import { openOrUpdatePr, readRepoFile, writeRepoFile } from '../lib/github-contents.js';
import { gh } from '../lib/github.js';
import { log } from '../lib/logger.js';
import { runCancellable } from '../lib/proc.js';
import {
  FINAL_MESSAGE_MAX,
  HANDOFF_SYSTEM_PROMPT,
  buildFixerPrBody,
  claudeArgs,
  cleanHandoff,
  fixerChildEnv,
  fixerPrompt,
  fixerSystemPrompt,
  handoffGeneratorPrompt,
  isIncompleteRun,
  parseFixerChecks,
  parseHandoff,
  validateHandoff,
  type FixerCheckResult,
} from '../lib/fixer.js';
import { npmCommand } from './build-audit.js';

/**
 * The fixer's three laptop activities: write the handoff, run Claude Code on
 * it, open the PR. `fixFindingWorkflow` runs them in that order between a read
 * of the finding and the write back to it.
 *
 * All three need this machine: the first two its Claude Code login, the second
 * its checkout and git credentials. They run on `steward-heavy`, which only the
 * laptop worker polls.
 *
 * `runFixer` follows `buildAndAuditDraft`, the other activity that is minutes
 * long and owns a child process: a background heartbeat pump, the child killed
 * as a tree on cancellation, cleanup in `finally`.
 */

const HEARTBEAT_MS = 5_000;

/** The findings repository's only branch. */
const FINDINGS_BRANCH = 'main';

/**
 * How long Claude Code may run. Fifteen minutes under the stub's 45, which is
 * a cold `npm ci` before it and the commit and push after it with room to spare.
 */
const CLAUDE_TIMEOUT_MS = 30 * 60_000;

/**
 * How long Claude Code may say nothing. The stream carries an event per turn
 * and none during a tool call, and one Bash call may run for ten minutes, so
 * the limit sits above that.
 */
const CLAUDE_STALL_MS = 12 * 60_000;

/** The generator is one turn with no tools: four minutes is a hung call. */
const GENERATOR_TIMEOUT_MS = 4 * 60_000;

const INSTALL_STATE = path.join(STEWARD_DIR, '.cache', 'fixer-worktree-install.json');

/** Project instructions the worktree lacks because they are gitignored. */
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'];

// ---------------------------------------------------------------------------
// generateHandoff
// ---------------------------------------------------------------------------

export interface GenerateHandoffInput {
  /** `owner/name` of the findings repository. */
  repo: string;
  key: string;
  /** The finding file as the workflow read it, frontmatter included. */
  findingText: string;
  /** `sites/<site>/handoffs/<key>.md` */
  handoffPath: string;
}

export interface GenerateHandoffResult {
  /** The handoff, as written to the findings repository. */
  handoff: string;
  title: string;
  /** The commit that wrote it, or null when the file already held this text. */
  commitSha: string | null;
  claude: { model: string | null; costUsd: number | null; durationMs: number | null };
}

/**
 * One `claude -p` call, no tools, that turns a finding into a handoff, then
 * one Contents API write of it (design decision 20).
 *
 * The call runs in an empty directory with `--safe-mode` and its own system
 * prompt, so the finding is the only document in the model's context: no
 * `CLAUDE.md`, no plugin, no hook. A reply that fails {@link validateHandoff}
 * fails the activity, and the retry asks again.
 */
export async function generateHandoff(input: GenerateHandoffInput): Promise<GenerateHandoffResult> {
  const ctx = Context.current();
  const pump = setInterval(() => ctx.heartbeat('claude -p: writing the handoff'), HEARTBEAT_MS);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-handoff-'));
  try {
    const run = await runClaude({
      command: 'claude',
      argv: [
        '-p',
        handoffGeneratorPrompt({ key: input.key, finding: input.findingText }),
        '--output-format',
        'stream-json',
        '--verbose',
        '--system-prompt',
        HANDOFF_SYSTEM_PROMPT,
        '--strict-mcp-config',
        '--safe-mode',
        '--tools',
        '',
      ],
      cwd,
      env: fixerChildEnv(process.env),
      signal: ctx.cancellationSignal,
      timeoutMs: GENERATOR_TIMEOUT_MS,
      stallMs: GENERATOR_TIMEOUT_MS,
    });
    if (run.cancelled) throw new CancelledFailure('cancelled while the handoff was being written');
    if (run.exitCode !== 0 || !run.state.finalMessage) {
      throw new Error(
        `claude -p exited ${run.exitCode}${run.timedOut || run.stalled ? ' (stopped at its time limit)' : ''} without a handoff. stderr: ${run.stderrTail || '(empty)'}`,
      );
    }

    const handoff = cleanHandoff(run.state.finalMessage);
    const problems = validateHandoff(handoff, input.key);
    if (problems.length > 0) {
      throw ApplicationFailure.create({
        type: 'HandoffInvalid',
        message: `The generated handoff for ${input.key} was refused: ${problems.join('; ')}.`,
      });
    }

    ctx.heartbeat('writing the handoff to the findings repository');
    const existing = await readRepoFile(input.handoffPath, FINDINGS_BRANCH, input.repo);
    let commitSha: string | null = null;
    if (existing?.text !== handoff) {
      commitSha = (
        await writeRepoFile({
          repo: input.repo,
          path: input.handoffPath,
          text: handoff,
          message: `handoff ${input.key}`,
          branch: FINDINGS_BRANCH,
          sha: existing?.sha,
        })
      ).commitSha;
    }

    const claude = { model: run.state.model, costUsd: run.state.costUsd, durationMs: run.state.durationMs };
    log.info({ activity: 'generateHandoff', key: input.key, commitSha, ...claude }, 'handoff generated');
    return { handoff, title: parseHandoff(handoff).title, commitSha, claude };
  } finally {
    clearInterval(pump);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// runFixer
// ---------------------------------------------------------------------------

export interface RunFixerInput {
  key: string;
  /** The handoff markdown. It rides in the prompt; the run is given no path. */
  handoff: string;
  /** The branch to create and push. */
  branch: string;
}

export interface RunFixerResult {
  branch: string;
  /** The site repository's default branch, which the PR points at. */
  base: string;
  commitSha: string;
  filesChanged: string[];
  /** The Verify results the run reported, read strictly from its final message. */
  checks: FixerCheckResult[];
  claude: {
    exitCode: number;
    timedOut: boolean;
    /**
     * What the model said it did, capped at `FINAL_MESSAGE_MAX`. It stays here,
     * in the workflow history: nothing publishes it.
     */
    finalMessage: string | null;
    model: string | null;
    sessionId: string | null;
    numTurns: number | null;
    costUsd: number | null;
    permissionDenials: string[];
  };
  /** True when `npm ci` ran, false when the lockfile-hash cache held. */
  npmCi: boolean;
  timingsMs: { worktree: number; install: number; claude: number; push: number; total: number };
}

/**
 * One run at a time. The worktree is single, and a module-level flag is a
 * correct guard for the same reason `worktree-lock.ts`'s is: every activity
 * runs in the one worker process. A second run fails rather than queues,
 * because queueing behind a 30-minute model turn inside a 45-minute timeout is
 * a timeout with extra steps.
 */
let busy: string | undefined;

/**
 * Claude Code, headless, on one handoff, in the fixer's own worktree. It ends
 * with the branch pushed; `openFixerPr` opens the PR.
 *
 * **How a run can end**, and what the activity does with each:
 *
 * | The run | The activity |
 * |---|---|
 * | exits 0 with changes | commits, pushes, returns |
 * | exits non-zero, or is killed at 30 minutes, with changes | the same, and the result says so, which makes the PR a draft |
 * | ends any way with no changes | fails, `FixerProducedNothing` |
 * | says nothing for 12 minutes | kills it and fails, `FixerStalled` |
 * | is cancelled | kills it and reports the cancellation |
 */
export async function runFixer(input: RunFixerInput): Promise<RunFixerResult> {
  const ctx = Context.current();
  const signal = ctx.cancellationSignal;
  const started = Date.now();

  const handoff = parseHandoff(input.handoff);
  if (!handoff.title) {
    throw ApplicationFailure.nonRetryable(`The handoff for ${input.key} has no H1 to title the commit with.`, 'HandoffInvalid');
  }

  if (busy) {
    throw ApplicationFailure.nonRetryable(`The fixer worktree is in use by ${busy}.`, 'FixerBusy');
  }
  busy = input.key;

  let phase = 'starting';
  const pump = setInterval(() => ctx.heartbeat(phase), HEARTBEAT_MS);
  const step = (name: string) => {
    phase = name;
    ctx.heartbeat(name);
  };

  try {
    // --- 1. Base branch -----------------------------------------------------
    // Asked of GitHub first, which also proves the token before a model turn is
    // spent on a run that could not open its PR.
    step('reading the default branch');
    const base: string = (await gh(`/repos/${GITHUB_REPO}`)).default_branch;

    // --- 2. Worktree --------------------------------------------------------
    step('preparing the worktree');
    const worktreeStarted = Date.now();
    await git(SITE_DIR, ['fetch', 'origin', base]);
    if (!(await worktreeExists(SITE_DIR, FIXER_WORKTREE_DIR))) {
      await fs.rm(FIXER_WORKTREE_DIR, { recursive: true, force: true });
      await git(SITE_DIR, ['worktree', 'add', '--detach', FIXER_WORKTREE_DIR, `origin/${base}`]);
    }
    // `-B` and `--force`: a re-run starts from the base again, whatever an
    // earlier run left in the tree. `clean` without `-x` keeps `node_modules`.
    await git(FIXER_WORKTREE_DIR, ['checkout', '--force', '-B', input.branch, `origin/${base}`]);
    await git(FIXER_WORKTREE_DIR, ['clean', '-fd']);
    for (const name of INSTRUCTION_FILES) {
      await fs.copyFile(path.join(SITE_DIR, name), path.join(FIXER_WORKTREE_DIR, name)).catch(() => {});
    }
    const worktreeMs = Date.now() - worktreeStarted;

    // --- 3. Dependencies ----------------------------------------------------
    step('checking dependencies');
    const installStarted = Date.now();
    const install = await needsInstall(FIXER_WORKTREE_DIR, INSTALL_STATE);
    if (install.needed) {
      step('npm ci');
      const ci = npmCommand(['ci']);
      const res = await runCancellable(ci.binary, ci.args, { cwd: FIXER_WORKTREE_DIR, signal });
      if (signal.aborted) throw new CancelledFailure('cancelled during npm ci');
      if (res.exitCode !== 0) {
        throw new Error(`npm ci failed (exit ${res.exitCode}):\n${res.stderr.slice(-4000)}`);
      }
      await recordInstall(INSTALL_STATE, install.hash);
    }
    const installMs = Date.now() - installStarted;

    // --- 4. Claude Code -----------------------------------------------------
    step('claude -p: starting');
    const claudeStarted = Date.now();
    const run = await runClaude({
      command: 'claude',
      argv: claudeArgs({
        prompt: fixerPrompt(input.handoff),
        systemPrompt: fixerSystemPrompt({ branch: input.branch, base }),
      }),
      cwd: FIXER_WORKTREE_DIR,
      env: fixerChildEnv(process.env),
      signal,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      stallMs: CLAUDE_STALL_MS,
      onActivity: (activity) => {
        phase = `claude -p: ${activity}`;
      },
    });
    const claudeMs = Date.now() - claudeStarted;
    const finalMessage = run.state.finalMessage?.slice(0, FINAL_MESSAGE_MAX) ?? null;
    const claude: RunFixerResult['claude'] = {
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      finalMessage,
      model: run.state.model,
      sessionId: run.state.sessionId,
      numTurns: run.state.numTurns,
      costUsd: run.state.costUsd,
      permissionDenials: run.state.permissionDenials,
    };
    log.info(
      { activity: 'runFixer', key: input.key, claudeMs, cancelled: run.cancelled, stalled: run.stalled, ...claude, finalMessage: undefined },
      'claude -p exited',
    );
    if (run.cancelled) throw new CancelledFailure('cancelled while Claude Code was running');
    if (run.stalled) {
      throw ApplicationFailure.nonRetryable(
        `Claude Code said nothing for ${CLAUDE_STALL_MS / 60_000} minutes and was stopped. ` +
          `It was last seen at: ${run.state.lastActivity}. The worktree holds what it left.`,
        'FixerStalled',
      );
    }

    // --- 5. Commit ----------------------------------------------------------
    step('committing');
    const pushStarted = Date.now();
    // `add -A` is safe here and nowhere else: this tree was reset to the base a
    // moment ago, so everything unignored in it is the run's own work.
    await git(FIXER_WORKTREE_DIR, ['add', '-A']);
    const staged = await git(FIXER_WORKTREE_DIR, ['diff', '--cached', '--name-only']);
    if (staged) {
      await git(FIXER_WORKTREE_DIR, ['commit', '-m', handoff.title, '-m', `Finding: ${input.key}`]);
    }
    // Compared against the base rather than read off `staged`, so a run that
    // committed for itself despite the deny rule still counts as having worked.
    const filesChanged = (await git(FIXER_WORKTREE_DIR, ['diff', '--name-only', `origin/${base}`, 'HEAD']))
      .split('\n')
      .filter(Boolean);
    if (filesChanged.length === 0) {
      throw ApplicationFailure.nonRetryable(
        `Claude Code exited ${run.exitCode}${run.timedOut ? ' (stopped at its time limit)' : ''} and changed nothing. ` +
          `Final message: ${finalMessage ?? '(none)'}\nstderr: ${run.stderrTail || '(empty)'}`,
        'FixerProducedNothing',
      );
    }
    const commitSha = await git(FIXER_WORKTREE_DIR, ['rev-parse', 'HEAD']);

    // --- 6. Push, then let go of the branch ----------------------------------
    step('pushing');
    await git(FIXER_WORKTREE_DIR, ['push', '--force-with-lease', '-u', 'origin', input.branch]);
    // Same reason `publishPost` detaches: a branch checked out in any worktree
    // cannot be deleted, including by the human cleaning up after the merge.
    await git(FIXER_WORKTREE_DIR, ['checkout', '--detach']).catch(() => {});
    const pushMs = Date.now() - pushStarted;

    return {
      branch: input.branch,
      base,
      commitSha,
      filesChanged,
      checks: parseFixerChecks(finalMessage, handoff.checks.length),
      claude,
      npmCi: install.needed,
      timingsMs: {
        worktree: worktreeMs,
        install: installMs,
        claude: claudeMs,
        push: pushMs,
        total: Date.now() - started,
      },
    };
  } finally {
    clearInterval(pump);
    busy = undefined;
  }
}

// ---------------------------------------------------------------------------
// openFixerPr
// ---------------------------------------------------------------------------

export interface OpenFixerPrInput {
  key: string;
  /** The finding file, frontmatter included: the body is written from it. */
  findingText: string;
  /** The handoff, for its title and its Verify checks. */
  handoff: string;
  branch: string;
  base: string;
  filesChanged: string[];
  checks: FixerCheckResult[];
  exitCode: number;
  timedOut: boolean;
}

export interface OpenFixerPrResult {
  prUrl: string;
  /** True when the run was incomplete and the PR was opened as a draft. */
  draft: boolean;
}

/**
 * Opens the PR for a pushed fixer branch, or updates the one already open
 * against it, with the body {@link buildFixerPrBody} writes from the finding.
 *
 * An incomplete run (a non-zero exit, or the 30-minute kill) opens a draft and
 * says so in the body's first line. Steward never merges either kind.
 */
export async function openFixerPr(input: OpenFixerPrInput): Promise<OpenFixerPrResult> {
  const handoff = parseHandoff(input.handoff);
  const draft = isIncompleteRun(input);
  const body = buildFixerPrBody({
    key: input.key,
    finding: parseFindingBody(input.findingText),
    checks: handoff.checks,
    results: input.checks,
    filesChanged: input.filesChanged,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
  });
  const title = handoff.title.charAt(0).toUpperCase() + handoff.title.slice(1);
  const prUrl = await openOrUpdatePr({ branch: input.branch, base: input.base, title, body, draft });
  log.info({ activity: 'openFixerPr', key: input.key, prUrl, draft }, 'fixer PR open');
  return { prUrl, draft };
}
