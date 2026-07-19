import path from 'node:path';
import { execFile } from 'node:child_process';
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

/** Absolute path to the Vale binary installed by `npm run setup:vale`. */
export function valeBinary(): string {
  return path.join(STEWARD_DIR, 'bin', process.platform === 'win32' ? 'vale.exe' : 'vale');
}

/** Absolute path to the Steward's Vale config directory. */
export function valeConfigDir(): string {
  return path.join(STEWARD_DIR, 'vale');
}
