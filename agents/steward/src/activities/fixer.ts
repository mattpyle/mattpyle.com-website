import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { FIXER_WORKTREE_DIR, GITHUB_REPO, SITE_DIR, STEWARD_DIR } from '../config.js';
import { git, needsInstall, recordInstall, worktreeExists } from '../lib/git.js';
import { gh } from '../lib/github.js';
import { log } from '../lib/logger.js';
import { killTree, runCancellable } from '../lib/proc.js';
import {
  FINAL_MESSAGE_MAX,
  buildFixerPrBody,
  claudeArgs,
  fixerChildEnv,
  fixerPrompt,
  fixerSystemPrompt,
  initialClaudeRunState,
  parseHandoff,
  reduceClaudeEvent,
  type ClaudeRunState,
} from '../lib/fixer.js';
import { npmCommand } from './build-audit.js';

/**
 * `runFixer`: Claude Code, headless, on one handoff, in its own worktree.
 *
 * A spike. It answers what running `claude -p` inside an activity takes, and
 * the fixer workflow proper is built from what it reports, so the result
 * carries timings and the model's own account rather than only a PR URL.
 *
 * The shape follows `buildAndAuditDraft`, the other activity that is minutes
 * long and owns a child process: a background heartbeat pump, the child killed
 * as a tree on cancellation, cleanup in `finally`. It adds one thing that
 * activity does not need, a deadline of its own on the child. The model's turn
 * is the only step with no natural end, and the commit, push and PR have to
 * fit inside the activity's `startToCloseTimeout` after it.
 */

const HEARTBEAT_MS = 5_000;

/**
 * How long Claude Code may run. Fifteen minutes under the stub's 45, which is
 * a cold `npm ci` before it and the publish after it with room to spare.
 */
const CLAUDE_TIMEOUT_MS = 30 * 60_000;

const INSTALL_STATE = path.join(STEWARD_DIR, '.cache', 'fixer-worktree-install.json');

/** Project instructions the worktree lacks because they are gitignored. */
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'];

export interface RunFixerInput {
  /** Repo-relative path of the handoff, under `docs/handoffs/`. */
  handoffPath: string;
  /** The branch to create and push. */
  branch: string;
}

export interface RunFixerResult {
  prUrl: string;
  branch: string;
  commitSha: string;
  filesChanged: string[];
  claude: {
    exitCode: number;
    timedOut: boolean;
    /** What the model said it did, capped at `FINAL_MESSAGE_MAX`. */
    finalMessage: string | null;
    model: string | null;
    sessionId: string | null;
    numTurns: number | null;
    costUsd: number | null;
    permissionDenials: string[];
  };
  /** True when `npm ci` ran, false when the lockfile-hash cache held. */
  npmCi: boolean;
  timingsMs: { worktree: number; install: number; claude: number; publish: number; total: number };
}

/**
 * One run at a time. The worktree is single, and a module-level flag is a
 * correct guard for the same reason `worktree-lock.ts`'s is: every activity
 * runs in the one worker process. A second run fails rather than queues,
 * because queueing behind a 30-minute model turn inside a 45-minute timeout is
 * a timeout with extra steps.
 */
let busy: string | undefined;

/** The handoff's absolute path, refused unless it is a markdown file under `docs/handoffs/`. */
function resolveHandoff(handoffPath: string): string {
  const root = path.join(SITE_DIR, 'docs', 'handoffs');
  const abs = path.resolve(SITE_DIR, handoffPath);
  if (path.dirname(abs) !== root || path.extname(abs) !== '.md') {
    throw ApplicationFailure.nonRetryable(
      `${handoffPath} is not a markdown file directly under docs/handoffs/.`,
      'BadHandoffPath',
    );
  }
  return abs;
}

interface ClaudeOutcome {
  exitCode: number;
  timedOut: boolean;
  state: ClaudeRunState;
  stderrTail: string;
}

/**
 * Spawns Claude Code and folds its event stream into `ClaudeRunState`.
 *
 * Its own spawn rather than `runCancellable`, for three reasons that helper
 * does not cover: the environment is filtered rather than extended, stdout is
 * read as it arrives so the heartbeat can carry it, and stdin is closed.
 * `claude -p` reads a prompt from stdin when stdin is a pipe, and an open pipe
 * nobody writes to is a run that waits forever.
 */
async function runClaude(args: {
  argv: string[];
  cwd: string;
  signal: AbortSignal;
  onActivity: (activity: string) => void;
}): Promise<ClaudeOutcome> {
  const child = spawn('claude', args.argv, {
    cwd: args.cwd,
    env: fixerChildEnv(process.env),
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let state = initialClaudeRunState();
  let stderrTail = '';
  let timedOut = false;

  createInterface({ input: child.stdout! }).on('line', (line) => {
    state = reduceClaudeEvent(state, line);
    args.onActivity(state.lastActivity);
  });
  child.stderr!.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString()).slice(-4000);
  });

  const kill = () => killTree(child.pid);
  args.signal.addEventListener('abort', kill, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    kill();
  }, CLAUDE_TIMEOUT_MS);

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? -1));
    });
    return { exitCode, timedOut, state, stderrTail };
  } finally {
    clearTimeout(deadline);
    args.signal.removeEventListener('abort', kill);
  }
}

export async function runFixer(input: RunFixerInput): Promise<RunFixerResult> {
  const ctx = Context.current();
  const signal = ctx.cancellationSignal;
  const started = Date.now();
  const handoffAbs = resolveHandoff(input.handoffPath);

  let handoffRaw: string;
  try {
    handoffRaw = await fs.readFile(handoffAbs, 'utf8');
  } catch {
    throw ApplicationFailure.nonRetryable(`${input.handoffPath} does not exist.`, 'BadHandoffPath');
  }
  const handoff = parseHandoff(handoffRaw);
  if (!handoff.title) {
    throw ApplicationFailure.nonRetryable(`${input.handoffPath} has no H1 to title the PR with.`, 'BadHandoffPath');
  }

  if (busy) {
    throw ApplicationFailure.nonRetryable(`The fixer worktree is in use by ${busy}.`, 'FixerBusy');
  }
  busy = input.handoffPath;

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
      if (res.exitCode !== 0) {
        throw new Error(`npm ci failed (exit ${res.exitCode}):\n${res.stderr.slice(-4000)}`);
      }
      await recordInstall(INSTALL_STATE, install.hash);
    }
    const installMs = Date.now() - installStarted;

    // --- 4. Claude Code -----------------------------------------------------
    step('claude -p: starting');
    const claudeStarted = Date.now();
    const vaultDir = path.join(SITE_DIR, 'docs');
    const run = await runClaude({
      argv: claudeArgs({
        prompt: fixerPrompt(handoffAbs),
        systemPrompt: fixerSystemPrompt({ branch: input.branch, base, vaultDir }),
        addDir: vaultDir,
      }),
      cwd: FIXER_WORKTREE_DIR,
      signal,
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
    log.info({ activity: 'runFixer', handoff: input.handoffPath, claudeMs, ...claude }, 'claude -p exited');
    if (signal.aborted) throw new Error('cancelled while Claude Code was running');

    // --- 5. Commit ----------------------------------------------------------
    step('committing');
    const publishStarted = Date.now();
    // `add -A` is safe here and nowhere else: this tree was reset to the base a
    // moment ago, so everything unignored in it is the run's own work.
    await git(FIXER_WORKTREE_DIR, ['add', '-A']);
    const staged = await git(FIXER_WORKTREE_DIR, ['diff', '--cached', '--name-only']);
    if (staged) {
      await git(FIXER_WORKTREE_DIR, ['commit', '-m', handoff.title]);
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

    // --- 7. The PR ----------------------------------------------------------
    step('opening the PR');
    const incomplete = run.timedOut || run.exitCode !== 0;
    const body = buildFixerPrBody({
      verify: handoff.verify,
      finalMessage,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
    });
    const title = handoff.title.charAt(0).toUpperCase() + handoff.title.slice(1);
    const owner = GITHUB_REPO.split('/')[0];
    const existing = await gh(
      `/repos/${GITHUB_REPO}/pulls?head=${encodeURIComponent(`${owner}:${input.branch}`)}&state=open`,
    );
    let prUrl: string;
    if (Array.isArray(existing) && existing.length > 0) {
      prUrl = (
        await gh(`/repos/${GITHUB_REPO}/pulls/${existing[0].number}`, {
          method: 'PATCH',
          body: JSON.stringify({ title, body }),
        })
      ).html_url;
    } else {
      prUrl = (
        await gh(`/repos/${GITHUB_REPO}/pulls`, {
          method: 'POST',
          body: JSON.stringify({ title, body, head: input.branch, base, draft: incomplete }),
        })
      ).html_url;
    }
    const publishMs = Date.now() - publishStarted;

    return {
      prUrl,
      branch: input.branch,
      commitSha,
      filesChanged,
      claude,
      npmCi: install.needed,
      timingsMs: {
        worktree: worktreeMs,
        install: installMs,
        claude: claudeMs,
        publish: publishMs,
        total: Date.now() - started,
      },
    };
  } finally {
    clearInterval(pump);
    busy = undefined;
  }
}
