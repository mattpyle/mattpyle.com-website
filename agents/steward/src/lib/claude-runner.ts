import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTree } from './proc.js';
import { initialClaudeRunState, reduceClaudeEvent, type ClaudeRunState } from './fixer.js';

/**
 * Spawns Claude Code and folds its event stream into `ClaudeRunState`.
 *
 * Its own spawn rather than `runCancellable`, for three reasons that helper
 * does not cover: the environment is given whole rather than extended, stdout
 * is read as it arrives so the heartbeat can carry it, and stdin is closed.
 * `claude -p` reads a prompt from stdin when stdin is a pipe, and an open pipe
 * nobody writes to is a run that waits forever.
 *
 * **Three ways it ends early**, each killing the whole process tree and each
 * named in the outcome so the caller never infers one from an exit code:
 *
 * - `cancelled`: the signal aborted (the activity was cancelled).
 * - `timedOut`: the run passed `timeoutMs`. The work so far may be worth a PR.
 * - `stalled`: nothing arrived on stdout or stderr for `stallMs`. The stream
 *   emits an event per turn, so silence that long is a hung process, not a
 *   model thinking.
 *
 * `command` is a parameter so a test can put a stub process in Claude Code's
 * place and reach all three without a model.
 */

export interface ClaudeRunOptions {
  command: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  stallMs: number;
  onActivity?: (activity: string) => void;
}

export interface ClaudeOutcome {
  exitCode: number;
  cancelled: boolean;
  timedOut: boolean;
  stalled: boolean;
  state: ClaudeRunState;
  stderrTail: string;
}

export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeOutcome> {
  const child = spawn(options.command, options.argv, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let state = initialClaudeRunState();
  let stderrTail = '';
  let cancelled = false;
  let timedOut = false;
  let stalled = false;

  const kill = () => killTree(child.pid);
  const onAbort = () => {
    cancelled = true;
    kill();
  };

  let stallTimer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      kill();
    }, options.stallMs);
  };

  createInterface({ input: child.stdout! }).on('line', (line) => {
    touch();
    state = reduceClaudeEvent(state, line);
    options.onActivity?.(state.lastActivity);
  });
  child.stderr!.on('data', (c: Buffer) => {
    touch();
    stderrTail = (stderrTail + c.toString()).slice(-4000);
  });

  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  touch();

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? -1));
    });
    return { exitCode, cancelled, timedOut, stalled, state, stderrTail };
  } finally {
    clearTimeout(deadline);
    clearTimeout(stallTimer);
    options.signal.removeEventListener('abort', onAbort);
  }
}
