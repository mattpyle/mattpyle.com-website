import { git } from '../lib/git.js';

/** What the console says about the code it runs. */
export interface ConsoleCommit {
  /** Short sha of the checkout's `HEAD` when the console started, or `unknown` when git cannot say. */
  commit: string;
  /** True when `master` in the same checkout names a different commit. A restart alone cannot fix it: `steward update` pulls. */
  behindMaster: boolean;
}

/** Reads `HEAD` and `master` in `repoDir`. Never throws: a missing git or ref reads as `unknown` and not behind. */
export async function readConsoleCommit(repoDir: string): Promise<ConsoleCommit> {
  const short = async (ref: string): Promise<string | null> => {
    try {
      return (await git(repoDir, ['rev-parse', '--short', ref])) || null;
    } catch {
      return null;
    }
  };
  const [head, master] = await Promise.all([short('HEAD'), short('master')]);
  return { commit: head ?? 'unknown', behindMaster: head !== null && master !== null && head !== master };
}
