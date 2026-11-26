import { ApplicationFailure, Context } from '@temporalio/activity';
import { WorkflowNotFoundError } from '@temporalio/client';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { branchSha, commitFiles, fastForwardBranch, readRepoFile } from '../lib/github-contents.js';
import { log } from '../lib/logger.js';
import {
  findingPath,
  findingsIndexPath,
  setFindingVerification,
  setIndexStatus,
  siteConfigPath,
  type Verification,
} from '../lib/findings.js';
import type { FindingState } from '../workflows/finding.js';
import { setFrontmatterLiveOn, type PendingWatch, type WatchRun } from '../lib/findings-recheck.js';
import { validateVerifyBlock, type VerifyCheck } from '../lib/verify-checks.js';
import { watchesAfterVerdict } from './findings.js';

/**
 * The recheck's activities (STW-543): a site's origin and declared hosts, one
 * finding's block validated against them, and one commit per changed finding.
 *
 * Like the other findings activities they are GitHub API calls against the
 * findings repository and open no local file, so the hosted worker registers
 * them on `steward-findings`. The checks themselves run through
 * `runFindingChecks`, which the verifier already registers there.
 *
 * `readWatchRun` reads Temporal instead, through the worker's own client: on a
 * site that watches, the recheck measures nothing and asks whether each
 * finding's run still does.
 */

const BRANCH = 'main';

/** A hostname as a site may declare it: lower-case labels, no scheme, port or path. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface SiteHosts {
  /** The origin of `site.url`. */
  origin: string;
  /** `site.hosts` as declared; empty when the file declares none. */
  hosts: string[];
}

/**
 * `site.url` and `site.hosts` from a site's `config.yaml`. Without `hosts`
 * the origin of `site.url` is the only place a check may go. A `hosts` entry
 * that is not a bare hostname is refused, so a typo fails loudly instead of
 * silently refusing every check on that host.
 */
export function siteHosts(configText: string, path = 'config.yaml'): SiteHosts {
  const data = (parseFrontmatter(`---\n${configText}\n---\n`).data ?? {}) as Record<string, unknown>;
  const site = (typeof data.site === 'object' && data.site !== null ? data.site : {}) as Record<string, unknown>;
  let origin: string;
  try {
    origin = new URL(String(site.url)).origin;
  } catch {
    throw ApplicationFailure.nonRetryable(`${path} has no site.url that is a full URL.`, 'SiteConfigInvalid');
  }
  const raw = site.hosts ?? [];
  if (!Array.isArray(raw)) throw ApplicationFailure.nonRetryable(`${path}: site.hosts is not a list.`, 'SiteConfigInvalid');
  const bad = raw.filter((host) => typeof host !== 'string' || !HOSTNAME.test(host));
  if (bad.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `${path}: site.hosts holds ${bad.map((host) => JSON.stringify(host)).join(', ')}, which is not a bare lower-case hostname.`,
      'SiteConfigInvalid',
    );
  }
  return { origin, hosts: raw as string[] };
}

export interface ReadSiteHostsInput {
  repo: string;
  site: string;
}

export interface ReadSiteHostsResult extends SiteHosts {
  /**
   * Whether the site watches, by `readFindingSettings`'s rule. Absent from a
   * result recorded before the recheck read it, which the workflow reads as false.
   */
  watch?: boolean;
}

export async function readSiteHosts(input: ReadSiteHostsInput): Promise<ReadSiteHostsResult> {
  const path = siteConfigPath(input.site);
  const file = await readRepoFile(path, BRANCH, input.repo);
  if (!file) throw ApplicationFailure.nonRetryable(`${path} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  return { ...siteHosts(file.text, path), watch: watchesAfterVerdict(input.site, file.text) };
}

export interface ReadWatchRunInput {
  /** `finding/<site>/<key>` */
  workflowId: string;
}

/**
 * One finding's workflow, asked for by ID, not found in a list, which can lag.
 * The pending `watchFinding` is the one not being cancelled: after a
 * `measure-now` the old attempt can stay listed until its worker hears the
 * cancel. With none pending, the run's `state` query names its step.
 */
export async function readWatchRun(input: ReadWatchRunInput): Promise<WatchRun> {
  const client = Context.current().client;
  let described;
  try {
    described = await client.workflow.getHandle(input.workflowId).describe();
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return { state: 'no run' };
    throw err;
  }
  if (described.status.name !== 'RUNNING') return { state: 'no run' };

  const info = (described.raw.pendingActivities ?? []).find(
    (activity) => activity.activityType?.name === 'watchFinding' && activity.state !== PENDING_CANCEL_REQUESTED,
  );
  if (info) {
    const failure = info.lastFailure;
    const pending: PendingWatch = {
      attempt: info.attempt ?? 1,
      lastStartedAt: isoOf(info.lastStartedTime),
      lastCompletedAt: isoOf(info.lastAttemptCompleteTime),
      scheduledAt: isoOf(info.scheduledTime),
      failureType: failure ? failure.applicationFailureInfo?.type || (failure.timeoutFailureInfo ? 'Timeout' : 'Failure') : null,
      failureMessage: failure?.message ?? null,
    };
    return { state: 'open', pending, step: null };
  }

  let step: string | null = null;
  try {
    // By name: importing `findingStateQuery` would load the workflow module here.
    step = (await client.workflow.getHandle(input.workflowId, described.runId).query<FindingState>('state')).step ?? null;
  } catch (err) {
    log.warn({ activity: 'readWatchRun', workflowId: input.workflowId, error: err instanceof Error ? err.message : String(err) }, 'state query failed');
  }
  return { state: 'open', pending: null, step };
}

/** `PENDING_ACTIVITY_STATE_CANCEL_REQUESTED` in the server's enum. */
const PENDING_CANCEL_REQUESTED = 3;

/** A server timestamp as ISO 8601, or null when the server sent none. */
function isoOf(time: { seconds?: number | { toNumber(): number } | null; nanos?: number | null } | null | undefined): string | null {
  const raw = time?.seconds;
  if (raw === undefined || raw === null) return null;
  const seconds = typeof raw === 'number' ? raw : raw.toNumber();
  return new Date(seconds * 1000 + Math.floor((time?.nanos ?? 0) / 1e6)).toISOString();
}

export interface ReadRecheckBlockInput {
  repo: string;
  site: string;
  key: string;
  origin: string;
  hosts: string[];
}

export type ReadRecheckBlockResult =
  | { state: 'skip'; keyShort?: string; reason: string }
  | { state: 'none'; keyShort?: string }
  | { state: 'refused'; keyShort?: string; problems: string[] }
  | { state: 'checks'; keyShort?: string; checks: VerifyCheck[] };

/**
 * One finding's `verify` block, read for a recheck. A finding that is not
 * `approved`, or has a `resolved_run`, is skipped: the index line was stale.
 * No key or an empty list is `none`. A block the host rule or the schema
 * refuses is `refused`, with every problem, rather than a failure, so one bad
 * block cannot stop the site's run.
 */
export async function readRecheckBlock(input: ReadRecheckBlockInput): Promise<ReadRecheckBlockResult> {
  const path = findingPath(input.site, input.key);
  const file = await readRepoFile(path, BRANCH, input.repo);
  if (!file) return { state: 'skip', reason: `${path} is not in the repository` };
  const data = (parseFrontmatter(file.text).data ?? {}) as Record<string, unknown>;
  const keyShort = typeof data.key_short === 'string' && data.key_short ? { keyShort: data.key_short } : {};
  if (data.status !== 'approved') return { state: 'skip', ...keyShort, reason: `the file says ${String(data.status ?? 'no status')}` };
  if (data.resolved_run) return { state: 'skip', ...keyShort, reason: `the file has resolved_run ${String(data.resolved_run)}` };
  if (!Object.prototype.hasOwnProperty.call(data, 'verify')) return { state: 'none', ...keyShort };
  if (Array.isArray(data.verify) && data.verify.length === 0) return { state: 'none', ...keyShort };
  const { checks, problems } = validateVerifyBlock(data.verify, input.origin, input.hosts);
  if (problems.length > 0) return { state: 'refused', ...keyShort, problems };
  return { state: 'checks', ...keyShort, checks };
}

export interface WriteFindingRecheckInput {
  repo: string;
  site: string;
  key: string;
  /** Set for a problem still present: the day it was seen. */
  liveOn?: string;
  /** Set for a finding whose checks all passed: `status: 'resolved'`. */
  verification?: Verification;
  /**
   * The finding run that measured, when its own run writes (stage 4's
   * `watchFinding`): the commit message then reads `watch <key>: ... (<run>)`,
   * so the file's history names the run. Absent for the recheck.
   */
  by?: string;
}

export interface WriteFindingRecheckResult {
  /** Null when the files already held this result. */
  commitSha: string | null;
}

/**
 * The recheck's one write per changed finding, as one commit on `main`.
 *
 * `liveOn` edits the finding file alone. `verification` resolves it: the file
 * gets `status: resolved`, `resolved_run` and its Verification section through
 * `setFindingVerification`, and its INDEX.md line reads `resolved`, both in the
 * same commit.
 *
 * The file must still read `approved` with no `resolved_run`. A file that
 * already holds this exact result is the retry case and writes nothing. Any
 * other state means somebody moved the finding while the checks ran, and the
 * write refuses. A branch that moved between the read and the commit is
 * retried by the activity's retry policy.
 */
export async function writeFindingRecheck(input: WriteFindingRecheckInput): Promise<WriteFindingRecheckResult> {
  if (Boolean(input.liveOn) === Boolean(input.verification)) {
    throw ApplicationFailure.nonRetryable('A recheck write takes liveOn or verification, not both or neither.', 'BadInput');
  }
  const path = findingPath(input.site, input.key);
  const indexPath = findingsIndexPath(input.site);
  // The head first, then the files at the branch: a commit that moved the
  // branch in between makes the files newer than `head`, and the fast-forward
  // below then refuses, so the retry builds on the new head.
  const head = await branchSha(BRANCH, input.repo);
  const finding = await readRepoFile(path, BRANCH, input.repo);
  if (!finding) throw ApplicationFailure.nonRetryable(`${path} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  const before = (parseFrontmatter(finding.text).data ?? {}) as Record<string, unknown>;

  const files: { path: string; text: string }[] = [];
  let message: string;
  if (input.liveOn) {
    if (before.status !== 'approved' || before.resolved_run) {
      throw ApplicationFailure.nonRetryable(`${path} is no longer approved and unresolved, so live_on is not written.`, 'FindingMoved');
    }
    const text = setFrontmatterLiveOn(finding.text, input.liveOn);
    if (text !== finding.text) files.push({ path, text });
    message = input.by ? `watch ${input.key}: live on ${input.liveOn} (${input.by})` : `recheck ${input.key}: live on ${input.liveOn}`;
  } else {
    const verification = input.verification!;
    const retry = before.status === 'resolved' && finding.text.includes(verification.workflowId);
    if (!retry && (before.status !== 'approved' || before.resolved_run)) {
      throw ApplicationFailure.nonRetryable(`${path} is no longer approved and unresolved, so it is not resolved.`, 'FindingMoved');
    }
    const text = retry ? finding.text : setFindingVerification(finding.text, verification);
    const readBack = (parseFrontmatter(text).data ?? {}) as Record<string, unknown>;
    if (readBack.status !== 'resolved' || !readBack.resolved_run) {
      throw ApplicationFailure.nonRetryable(`${path}: the edited frontmatter did not read back as resolved.`, 'FindingMalformed');
    }
    if (text !== finding.text) files.push({ path, text });
    const index = await readRepoFile(indexPath, BRANCH, input.repo);
    if (!index) throw ApplicationFailure.nonRetryable(`${indexPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
    const indexText = setIndexStatus(index.text, input.key, 'resolved');
    if (indexText !== index.text) files.push({ path: indexPath, text: indexText });
    message = input.by ? `watch ${input.key}: resolved (${input.by})` : `recheck ${input.key}: resolved`;
  }

  if (files.length === 0) return { commitSha: null };
  const commit = await commitFiles({ repo: input.repo, parent: head, message, files });
  if (!(await fastForwardBranch(BRANCH, commit, input.repo))) {
    // Retryable: the next attempt reads the new head and builds on it.
    throw ApplicationFailure.retryable(`${BRANCH} moved while ${input.key} was written; retrying on the new head.`, 'BranchMoved');
  }
  log.info({ activity: 'writeFindingRecheck', key: input.key, commit, files: files.map((f) => f.path) }, 'recheck written');
  return { commitSha: commit };
}
