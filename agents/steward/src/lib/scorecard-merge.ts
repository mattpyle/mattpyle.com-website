/**
 * The rules for merging a Scorecard run's pull request. Pure: the activities
 * in `activities/scorecard.ts` fetch, and these functions decide.
 *
 * The merge path serves the pull request a run opened, which holds the run-log
 * entry and, since STW-614, that run's archive file. It is not a general merge
 * helper.
 */

/**
 * The check the `protect-master` ruleset requires. Treated as the proof that CI
 * has reported: a head with no check runs yet, or with other checks green and
 * this one absent, is not passing. Without it a poll made seconds after the push
 * reads "no pending runs" and merges early, and GitHub's refusal then raises a
 * false alarm. Rename it here when the ruleset changes.
 */
export const REQUIRED_SCORECARD_CHECK = 'Private paths not tracked';

/** Conclusions that count as a failure. `neutral` and `skipped` do not. */
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'stale', 'startup_failure']);

export interface CheckRunLike {
  name: string;
  status: string;
  conclusion: string | null;
}

export type ScorecardChecksState = 'passing' | 'pending' | 'failing';

export interface ScorecardChecksResult {
  state: ScorecardChecksState;
  failing: string[];
  pending: string[];
  /** True when the required check ran on this head and concluded `success`. */
  requiredPassed: boolean;
}

/**
 * Passing means: the required check is present and successful, no run is
 * pending, and none failed. A failure wins over pending, because waiting cannot
 * clear it.
 */
export function evaluateScorecardChecks(runs: CheckRunLike[]): ScorecardChecksResult {
  const failing = runs.filter((r) => r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion)).map((r) => r.name);
  const pending = runs.filter((r) => r.status !== 'completed').map((r) => r.name);
  const requiredPassed = runs.some(
    (r) => r.name === REQUIRED_SCORECARD_CHECK && r.status === 'completed' && r.conclusion === 'success',
  );
  if (failing.length > 0) return { state: 'failing', failing, pending, requiredPassed };
  if (pending.length > 0 || !requiredPassed) {
    const missing = runs.some((r) => r.name === REQUIRED_SCORECARD_CHECK) ? [] : [REQUIRED_SCORECARD_CHECK];
    return { state: 'pending', failing: [], pending: [...pending, ...missing], requiredPassed };
  }
  return { state: 'passing', failing: [], pending: [], requiredPassed };
}

/** Why the merge path left a pull request open. */
export type MergeRefusalCondition =
  | 'wrong-pr'
  | 'extra-files'
  | 'head-moved'
  | 'checks-failed'
  | 'checks-pending'
  | 'github-refused';

export type ScorecardMergeOutcome =
  | { merged: true; mergeSha: string }
  | { merged: false; condition: MergeRefusalCondition; detail: string };

/** The pull request fields the conditions read. */
export interface PullLike {
  state: string;
  merged: boolean;
  draft: boolean;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  headRepo: string | null;
  baseRef: string;
}

export interface MergeExpectation {
  branch: string;
  expectedHeadSha: string;
  defaultBranch: string;
  repo: string;
}

/**
 * The conditions that need only the pull request itself. Returns a refusal, or
 * `undefined` when the pull request is the one this run opened and is still
 * open and unmoved.
 */
export function checkPullIdentity(pull: PullLike, expected: MergeExpectation): ScorecardMergeOutcome | undefined {
  if (pull.headRef !== expected.branch) {
    return { merged: false, condition: 'wrong-pr', detail: `head branch is ${pull.headRef}, this run opened ${expected.branch}` };
  }
  if (pull.baseRef !== expected.defaultBranch) {
    return { merged: false, condition: 'wrong-pr', detail: `base is ${pull.baseRef}, not ${expected.defaultBranch}` };
  }
  if (pull.headRepo !== expected.repo) {
    return { merged: false, condition: 'wrong-pr', detail: `head repository is ${pull.headRepo ?? 'unknown'}, not ${expected.repo}` };
  }
  if (pull.headSha !== expected.expectedHeadSha) {
    return {
      merged: false,
      condition: 'head-moved',
      detail: `head is ${pull.headSha}, the run committed ${expected.expectedHeadSha}`,
    };
  }
  if (pull.state !== 'open') {
    return { merged: false, condition: 'wrong-pr', detail: `the pull request is ${pull.state}, not open` };
  }
  if (pull.draft) {
    return { merged: false, condition: 'wrong-pr', detail: 'the pull request is a draft' };
  }
  return undefined;
}

/** One entry of a pull request's diff, as GitHub lists it. */
export interface ChangedFile {
  filename: string;
  /** `added`, `modified`, `removed`, `renamed` and so on. */
  status?: string;
}

/** What a run's pull request may change. */
export interface AllowedDiff {
  /** The run-log file. It must be in the diff. */
  runLogPath: string;
  /**
   * The archive file this run committed beside the run-log, when it committed
   * one. It is the only other file the diff may hold.
   */
  archivePath?: string;
  /** The archive directory. `archivePath` must sit directly in it. */
  archiveDir: string;
}

/**
 * The diff is the run-log file, plus at most this run's own archive file.
 *
 * The archive file is named by the run, not matched by a pattern: another file
 * in the archive directory is refused like any other. It must be a `.json` file
 * directly in the archive directory, and GitHub must list it as added, because
 * the archive is append-only and a run that changed an earlier night's record is
 * not one Steward should merge unread.
 */
export function checkChangedFiles(files: ChangedFile[], allowed: AllowedDiff): ScorecardMergeOutcome | undefined {
  const names = files.map((f) => f.filename);
  const expected = allowed.archivePath
    ? `${allowed.runLogPath} and ${allowed.archivePath}`
    : `only ${allowed.runLogPath}`;
  const refuse = (detail: string): ScorecardMergeOutcome => ({ merged: false, condition: 'extra-files', detail });

  if (!names.includes(allowed.runLogPath)) {
    return refuse(`the diff is ${names.length === 0 ? 'empty' : names.join(', ')}, expected ${expected}`);
  }
  const others = files.filter((f) => f.filename !== allowed.runLogPath);
  if (others.length === 0) return undefined;
  if (others.length > 1 || !allowed.archivePath || others[0].filename !== allowed.archivePath) {
    return refuse(`the diff is ${names.join(', ')}, expected ${expected}`);
  }
  const archive = others[0];
  const prefix = `${allowed.archiveDir}/`;
  const name = archive.filename.startsWith(prefix) ? archive.filename.slice(prefix.length) : '';
  if (!name || name.includes('/') || !name.endsWith('.json')) {
    return refuse(`${archive.filename} is not a record directly under ${allowed.archiveDir}`);
  }
  if (archive.status !== 'added') {
    return refuse(`${archive.filename} is ${archive.status ?? 'of unknown status'} in the diff; an archive record is only ever added`);
  }
  return undefined;
}

/** Maps a failed checks read onto a refusal. */
export function checksRefusal(checks: ScorecardChecksResult): ScorecardMergeOutcome | undefined {
  if (checks.state === 'failing') {
    return { merged: false, condition: 'checks-failed', detail: `failing: ${checks.failing.join(', ')}` };
  }
  if (checks.state === 'pending') {
    return { merged: false, condition: 'checks-pending', detail: `not complete: ${checks.pending.join(', ') || 'no check runs yet'}` };
  }
  return undefined;
}

/** The number at the end of a pull request URL. */
export function pullNumberFromUrl(prUrl: string): number | undefined {
  const match = /\/pull\/(\d+)\/?$/.exec(prUrl);
  return match ? Number(match[1]) : undefined;
}
