import { createHash } from 'node:crypto';
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { readRepoFile } from '../lib/github-contents.js';
import { authRetryable } from '../lib/github.js';
import { log } from '../lib/logger.js';
import { siteConfigPath, type Verification } from '../lib/findings.js';
import { vancouverDay } from '../lib/findings-recheck.js';
import { validateVerifyBlock, type CheckRunner, type VerifyCheckResult } from '../lib/verify-checks.js';
import { siteHosts, writeFindingRecheck, type WriteFindingRecheckInput } from './findings-recheck.js';
import { watchesAfterVerdict } from './findings.js';
import { withHeartbeat } from './heartbeat.js';
import { runFindingChecks } from './verify-finding.js';

/**
 * `watchFinding` (stage 4): one measurement of an approved finding on a site
 * with no fixer, run by the finding's own workflow at step `watching` until
 * production shows the fix. Temporal's Infrequent Polling: the workflow
 * schedules it once, and each failed attempt is retried at the next daily
 * window ({@link watchRetryDelay}), so retries add no history events.
 *
 * Each attempt reads everything again, so nothing is frozen at the verdict:
 *
 * 1. The site's `config.yaml`. The site no longer watches ({@link watchesAfterVerdict}):
 *    `stopped`, and the run ends as a run that stops at the verdict ends.
 * 2. The finding file. Any status but `approved`, a `resolved_run`, or a
 *    missing file: `decided`. A file this run itself resolved (its Verification
 *    names the run) is `resolved` again, so a result lost after the commit is
 *    not misread.
 * 3. The `verify` block, validated against the origin and hosts of that config.
 * 4. Every check passes: the recheck's write resolves the file, its
 *    Verification section and its index line in one commit that names the run,
 *    and the attempt returns `resolved`.
 * 5. A check fails: the recheck's write sets `live_on` and `live_by: check` for
 *    the day, and the attempt fails as `StillPresent`, benign.
 * 6. No checks: it fails as `NoChecks`, benign. Such a finding closes only by
 *    step 2 or a message.
 * 7. A block the host rule or the schema refuses, a broken check or a broken
 *    config: it fails as `ChecksUnreadable`, not benign. It is retried like the
 *    rest, so a mended block needs no message.
 *
 * Failures 5 to 7, and any other failure marked non-retryable, carry
 * `nextRetryDelay` to the next daily window. A failure that passes by itself
 * (production answering 5xx or not at all, GitHub, a rejected credential) is
 * thrown with no delay, so the workflow's 15-minute policy applies.
 *
 * Both writes are the recheck's, which refuse unless the file still reads
 * `approved` with no `resolved_run`; a refusal is the `decided` of the next
 * attempt. A branch that moved under the commit is retried inside the attempt.
 *
 * One heartbeat covers the whole body, the GitHub reads and the commit too,
 * because the workflow's heartbeat timeout is 30 seconds.
 *
 * It runs on `steward-findings-watch`, a queue of its own with a cap of one, so
 * a verdict write on `steward-findings` never waits behind a page render. It is
 * in `BROWSER_ACTIVITY_TYPES`: the checks can launch Chromium.
 */

const BRANCH = 'main';

/** The daily window, minutes after midnight UTC: the recheck's hour, 13:20. */
export const WATCH_WINDOW_UTC_MINUTES = 13 * 60 + 20;
/** The spread of the hashed offset after the window. */
export const WATCH_SPREAD_SECONDS = 20 * 60;
/** A retry is never sooner than this after an attempt, so an attempt at 13:25 does not run again at 13:30. */
export const WATCH_MIN_GAP_MS = 60 * 60 * 1000;
/** Moved-branch retries inside one attempt. */
const BRANCH_MOVED_TRIES = 3;

export interface WatchFindingInput {
  /** `owner/name` of the findings repository. */
  repo: string;
  site: string;
  key: string;
  /** `sites/<site>/findings/<key>.md` */
  findingPath: string;
}

export type WatchFindingResult =
  | { outcome: 'resolved'; commitSha: string | null; rows: VerifyCheckResult[]; at: string | null }
  | { outcome: 'decided'; status: string | null }
  | { outcome: 'stopped' };

/** The offset of a key inside the window, 0 to 20 minutes, the same for the key every day. */
export function watchOffsetSeconds(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) % WATCH_SPREAD_SECONDS;
}

/**
 * Milliseconds from `nowMs` to the key's next daily window: 13:20 UTC plus its
 * hashed offset, on the first day that leaves at least {@link WATCH_MIN_GAP_MS}.
 */
export function watchRetryDelay(nowMs: number, key: string): number {
  const day = new Date(nowMs);
  let at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + WATCH_WINDOW_UTC_MINUTES * 60_000 + watchOffsetSeconds(key) * 1000;
  while (at < nowMs + WATCH_MIN_GAP_MS) at += 24 * 60 * 60 * 1000;
  return at - nowMs;
}

/** A failure that waits for the next window. */
function untilWindow(type: string, message: string, key: string, benign: boolean, now: number): ApplicationFailure {
  return ApplicationFailure.create({
    type,
    message,
    nonRetryable: false,
    nextRetryDelay: watchRetryDelay(now, key),
    ...(benign ? { category: ApplicationFailureCategory.BENIGN } : {}),
  });
}

export interface WatchFindingDeps {
  /** Replaced by the tests, which have no browser and a mock origin. */
  runner?: Partial<CheckRunner>;
  /** The clock for the window. */
  now?: () => number;
}

export async function watchFinding(input: WatchFindingInput, deps: WatchFindingDeps = {}): Promise<WatchFindingResult> {
  const now = deps.now ?? (() => Date.now());
  return withHeartbeat(`watching ${input.key}`, async () => {
    try {
      return await attempt(input, deps.runner ?? {}, now);
    } catch (err) {
      throw asRetry(err, input.key, now());
    }
  });
}

async function attempt(input: WatchFindingInput, runner: Partial<CheckRunner>, now: () => number): Promise<WatchFindingResult> {
  const workflowId = Context.current().info.workflowExecution?.workflowId ?? `finding/${input.site}/${input.key}`;
  const configPath = siteConfigPath(input.site);
  const config = await authRetryable(() => readRepoFile(configPath, BRANCH, input.repo));
  if (!watchesAfterVerdict(input.site, config?.text ?? null)) {
    log.info({ activity: 'watchFinding', key: input.key }, 'the site no longer watches');
    return { outcome: 'stopped' };
  }
  let hosts;
  try {
    hosts = siteHosts((config as { text: string }).text, configPath);
  } catch (err) {
    throw untilWindow('ChecksUnreadable', `The site config does not read: ${messageOf(err)}`, input.key, false, now());
  }

  const file = await authRetryable(() => readRepoFile(input.findingPath, BRANCH, input.repo));
  if (!file) return { outcome: 'decided', status: null };
  const data = (parseFrontmatter(file.text).data ?? {}) as Record<string, unknown>;
  const status = typeof data.status === 'string' ? data.status : null;
  if (status === 'resolved' && file.text.includes(workflowId)) {
    // This run resolved it on an earlier attempt whose result was lost.
    return { outcome: 'resolved', commitSha: null, rows: [], at: null };
  }
  if (status !== 'approved' || data.resolved_run) return { outcome: 'decided', status };

  const raw = data.verify;
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    throw untilWindow('NoChecks', `${input.key} has no verify checks; it closes when its file is decided.`, input.key, true, now());
  }
  const { checks, problems } = validateVerifyBlock(raw, hosts.origin, hosts.hosts);
  if (problems.length > 0) {
    throw untilWindow('ChecksUnreadable', `The verify block was refused: ${problems.join('; ')}`, input.key, false, now());
  }

  let run;
  try {
    run = await runFindingChecks({ key: input.key, checks }, runner);
  } catch (err) {
    if (err instanceof ApplicationFailure && err.type === 'VerifyCheckBroken') {
      throw untilWindow('ChecksUnreadable', `A check does not run: ${err.message}`, input.key, false, now());
    }
    throw err;
  }

  if (run.passed) {
    const verification: Verification = { status: 'resolved', at: run.ranAt, workflowId, source: 'finding', rows: run.results };
    const written = await write({ repo: input.repo, site: input.site, key: input.key, verification, by: workflowId });
    log.info({ activity: 'watchFinding', key: input.key, commit: written.commitSha }, 'resolved');
    return { outcome: 'resolved', commitSha: written.commitSha, rows: run.results, at: run.ranAt };
  }
  const day = vancouverDay(run.ranAt);
  await write({ repo: input.repo, site: input.site, key: input.key, liveOn: day, by: workflowId });
  const failed = run.results.filter((row) => !row.pass).map((row) => `check ${row.n}: ${row.measured}`);
  throw untilWindow('StillPresent', `Still present on ${day}: ${failed.join('; ')}`, input.key, true, now());
}

/** The recheck's write, with a moved branch retried inside the attempt. */
async function write(input: WriteFindingRecheckInput) {
  for (let tries = 1; ; tries++) {
    try {
      return await writeFindingRecheck(input);
    } catch (err) {
      if (tries < BRANCH_MOVED_TRIES && err instanceof ApplicationFailure && err.type === 'BranchMoved') continue;
      throw err;
    }
  }
}

/**
 * Keeps the activity retrying for ever. The attempt's own failures pass
 * through. A cancellation passes through. Any other failure marked
 * non-retryable (a moved finding, a missing index, a permanent GitHub answer)
 * becomes retryable at the next window, its type kept and not benign, so a
 * failure that needs a person is retried daily and seen; a rejected credential
 * and a moved finding are retried on the policy's interval: a token rotation
 * passes in minutes, and the next attempt reads a moved file as `decided`.
 * Everything else is thrown as it is, retryable on the policy's interval.
 */
function asRetry(err: unknown, key: string, now: number): unknown {
  if (err instanceof CancelledFailure) return err;
  if (!(err instanceof ApplicationFailure) || !err.nonRetryable) return err;
  // A moved finding is read again at once: the next attempt answers `decided`.
  if (err.type === 'AuthError' || err.type === 'FindingMoved') return ApplicationFailure.create({ type: err.type, message: err.message, nonRetryable: false });
  return untilWindow(err.type ?? 'WatchFailed', err.message, key, false, now);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
