import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { STEWARD_DIR } from '../config.js';

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The Steward's only process-spawning surface (spec §8, general rules).
 *
 * Deliberately `node:child_process.execFile` rather than `execa`: the spec named
 * execa for its Windows-safe argument handling, but `execFile` already passes
 * argv as an array with no shell involved, which is the property that actually
 * matters here. Adding a dependency to get the same guarantee the platform
 * already provides is not worth the lockfile entry — recorded as a deviation.
 *
 * `shell` is never enabled. Binary paths are absolute. `windowsHide` keeps
 * console windows from flashing on Windows.
 */
export async function run(
  binary: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
      // Vale's JSON over a long post comfortably exceeds the 1 MB default.
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    // A linter that found problems exits non-zero *and* produces the output we
    // want. Callers decide what a non-zero exit means; this wrapper only throws
    // when the process could not be run at all.
    if (typeof e.code === 'number') {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code };
    }
    throw err;
  }
}

/**
 * Like `run`, but the child is killed when `signal` aborts.
 *
 * `execFile`'s promisified form gives no handle on the child, so a cancelled
 * activity would leave an `npm run build` — and the Chrome it may have spawned —
 * running to completion with nobody to report to. The build audit is the first
 * activity long enough for that to matter, so it gets a spawn-based path.
 *
 * On Windows, killing the `npm` process does **not** kill the `node` it spawned;
 * `taskkill /T` is the only reliable way to take down the tree, and orphaned
 * builds are exactly what this leg's verification looks for.
 */
export async function runCancellable(
  binary: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    shell: false,
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));

  const onAbort = () => killTree(child.pid);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? -1));
    });
    return { stdout, stderr, exitCode };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Kills a process and everything it spawned. Best-effort; never throws. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).unref();
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

/** Absolute path to the Vale binary installed by `npm run setup:vale`. */
export function valeBinary(): string {
  return path.join(STEWARD_DIR, 'bin', process.platform === 'win32' ? 'vale.exe' : 'vale');
}

/** Absolute path to the Steward's Vale config directory. */
export function valeConfigDir(): string {
  return path.join(STEWARD_DIR, 'vale');
}
