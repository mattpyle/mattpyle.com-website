import { ApplicationFailure, Context } from '@temporalio/activity';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { FINDINGS_DEFAULT_SITE, PROD_ORIGIN, QUEUE_FINDINGS } from '../config.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { listRepoDirectory, readRepoFile, writeRepoFile } from '../lib/github-contents.js';
import { gh } from '../lib/github.js';
import { log } from '../lib/logger.js';
import {
  compareContains,
  findingHandoffPath,
  findingWorkflowId,
  fixBranch,
  isFindingSlug,
  liveDeployment,
  parseFindingsIndex,
  parsePrUrl,
  findingsIndexPath,
  setFindingReturned,
  setFindingVerification,
  setFrontmatterFix,
  setFrontmatterVerdict,
  setIndexStatus,
  setIndexVerdict,
  type FindingVerdictSource,
  type FindingVerdictStatus,
  type FindingsIndexLine,
  type DeploymentRecord,
  type Verification,
  type VerifyBlockSource,
} from '../lib/findings.js';
import { readHandoffVerify, validateVerifyBlock, type VerifyCheck } from '../lib/verify-checks.js';
import type { FindingStopAfter, FindingWorkflowInput } from '../workflows/finding.js';

/**
 * The findings store's activities (findings-loop design, "The store and the
 * gate"): four GitHub reads and writes against the findings repository, one
 * visibility list against Temporal, and one workflow start.
 *
 * Every one of them is an API call and none opens a local file, which is the
 * property that lets the hosted worker register them (`worker-hosted.ts`). The
 * repository is a parameter on every call, never read from config here: it rides
 * in the workflow input (design rule 10), so a workflow started against one
 * repository keeps writing to it.
 *
 * All reads are at `main`, the findings repository's only branch. Argus pushes
 * there directly and so does the verdict write.
 */

const BRANCH = 'main';

/**
 * The site folders under `sites/`, as slugs. A folder whose name is not a valid
 * slug is skipped with a log line rather than failing the run: one oddly named
 * folder must not stop every other site's findings from reconciling.
 */
export async function listSites(repo: string): Promise<string[]> {
  const entries = await listRepoDirectory('sites', BRANCH, repo);
  if (!entries) {
    throw ApplicationFailure.nonRetryable(`${repo} has no sites/ directory at ${BRANCH}.`, 'StoreLayout');
  }
  const sites: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'dir') continue;
    if (!isFindingSlug(entry.name)) {
      log.warn({ activity: 'listSites', name: entry.name }, 'skipping a sites/ folder that is not a slug');
      continue;
    }
    sites.push(entry.name);
  }
  return sites.sort();
}

/**
 * One site's `INDEX.md`, parsed. A site with no index yet (a skeleton folder)
 * has no findings, which is an empty list rather than a failure.
 */
export async function readFindingsIndex(repo: string, site: string): Promise<FindingsIndexLine[]> {
  const file = await readRepoFile(findingsIndexPath(site), BRANCH, repo);
  if (!file) return [];
  return parseFindingsIndex(file.text);
}

export interface FindingFile {
  path: string;
  text: string;
  /** The blob sha, for a guarded write. */
  sha: string;
  /** The frontmatter as parsed, for a caller that wants a field. */
  data: Record<string, unknown>;
}

export async function readFinding(repo: string, path: string): Promise<FindingFile> {
  const file = await readRepoFile(path, BRANCH, repo);
  if (!file) {
    throw ApplicationFailure.nonRetryable(`${path} is not in ${repo} at ${BRANCH}.`, 'FindingMissing');
  }
  return { path, text: file.text, sha: file.sha, data: parseFrontmatter(file.text).data };
}

export interface WriteFindingVerdictInput {
  repo: string;
  site: string;
  key: string;
  findingPath: string;
  indexPath: string;
  status: FindingVerdictStatus;
  reason: string;
  at: string;
  source: FindingVerdictSource;
}

export interface WriteFindingVerdictResult {
  /** The commit that changed the finding file, or null when it already carried the verdict. */
  findingCommitSha: string | null;
  /** The commit that changed the index line, or null when it already carried the verdict. */
  indexCommitSha: string | null;
  /** The last commit this call made, the one to name to Matt. Null when both were already written. */
  commitSha: string | null;
}

/**
 * Writes the verdict into the finding file, then into its index line.
 *
 * **The guard is the blob sha** (design decision 19). Each file is read, edited
 * in memory, and written back with the sha that read returned, so a commit Argus
 * pushed in between makes GitHub answer 409. `gh` raises a 409 as a plain
 * `Error`, which the activity's retry policy retries, and the retry starts from a
 * fresh read, so Argus's change is kept and the four fields are applied on top.
 * A missing file or index line is non-retryable: no retry will make it appear.
 *
 * **Idempotent across retries.** A retry after the file write landed but the
 * index write failed reads a file that already carries the verdict, skips that
 * write, and goes on to the index. An unchanged write is skipped rather than sent
 * because a Contents PUT with identical content still makes a commit.
 *
 * Commit author is the token's identity: the Contents API uses it when no
 * `committer` is sent.
 */
export async function writeFindingVerdict(input: WriteFindingVerdictInput): Promise<WriteFindingVerdictResult> {
  const verdict = { status: input.status, reason: input.reason, at: input.at, source: input.source };
  const message = `verdict ${input.key}: ${input.status}`;

  const finding = await readRepoFile(input.findingPath, BRANCH, input.repo);
  if (!finding) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} is not in ${input.repo} at ${BRANCH}, so the verdict has nowhere to go.`,
      'FindingMissing',
    );
  }
  let findingText: string;
  try {
    findingText = setFrontmatterVerdict(finding.text, verdict);
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath}: ${err instanceof Error ? err.message : String(err)}`,
      'FindingMalformed',
    );
  }
  // Read the edit back through the one parser, so a line edit that produced YAML
  // which no longer says what was meant fails here rather than in Argus's pull.
  const readBack = parseFrontmatter(findingText).data as Record<string, unknown>;
  if (readBack.status !== input.status || readBack.verdict_source !== input.source) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath}: the edited frontmatter did not read back as ${input.status}/${input.source}.`,
      'FindingMalformed',
    );
  }
  if (readBack.key !== undefined && readBack.key !== input.key) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} carries key ${String(readBack.key)}, not ${input.key}.`,
      'FindingMalformed',
    );
  }

  let findingCommitSha: string | null = null;
  if (findingText !== finding.text) {
    const written = await writeRepoFile({
      repo: input.repo,
      path: input.findingPath,
      text: findingText,
      message,
      branch: BRANCH,
      sha: finding.sha,
    });
    findingCommitSha = written.commitSha;
  }

  const index = await readRepoFile(input.indexPath, BRANCH, input.repo);
  if (!index) {
    throw ApplicationFailure.nonRetryable(`${input.indexPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  }
  let indexText: string;
  try {
    indexText = setIndexVerdict(index.text, input.key, input.status, input.reason);
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `${input.indexPath}: ${err instanceof Error ? err.message : String(err)}`,
      'FindingMissing',
    );
  }

  let indexCommitSha: string | null = null;
  if (indexText !== index.text) {
    const written = await writeRepoFile({
      repo: input.repo,
      path: input.indexPath,
      text: indexText,
      message,
      branch: BRANCH,
      sha: index.sha,
    });
    indexCommitSha = written.commitSha;
  }

  log.info(
    { activity: 'writeFindingVerdict', key: input.key, status: input.status, findingCommitSha, indexCommitSha },
    'finding verdict written',
  );
  return { findingCommitSha, indexCommitSha, commitSha: indexCommitSha ?? findingCommitSha };
}

export interface WriteFindingFixInput {
  repo: string;
  site: string;
  key: string;
  findingPath: string;
  indexPath: string;
  prUrl: string;
}

export interface WriteFindingFixResult {
  findingCommitSha: string | null;
  indexCommitSha: string | null;
  /** The last commit this call made. Null when both files already said `fixing` with this PR. */
  commitSha: string | null;
}

/**
 * Writes `status: fixing` and `links.pr` into the finding file, then `fixing`
 * into its index line, once the fixer's PR is open.
 *
 * The same guard and the same idempotence as {@link writeFindingVerdict}: each
 * file is written with the blob sha its read returned, a 409 from a concurrent
 * Argus push is a plain `Error` the retry policy retries from a fresh read, and
 * an unchanged file is skipped.
 *
 * **It moves a finding from `approved` only.** A finding that is already
 * `fixing` is the retry case and passes. Any other status means somebody else
 * moved it while the fixer ran (Argus setting `resolved`, a rejection), and the
 * write refuses rather than overrule them; the PR stays open for Matt.
 */
export async function writeFindingFix(input: WriteFindingFixInput): Promise<WriteFindingFixResult> {
  const message = `fixing ${input.key}: ${input.prUrl}`;

  const finding = await readRepoFile(input.findingPath, BRANCH, input.repo);
  if (!finding) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} is not in ${input.repo} at ${BRANCH}, so the PR link has nowhere to go.`,
      'FindingMissing',
    );
  }
  const before = parseFrontmatter(finding.text).data as Record<string, unknown>;
  if (before.status !== 'approved' && before.status !== 'fixing') {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} is ${String(before.status)}, not approved, so it is not marked fixing. The PR is ${input.prUrl}.`,
      'FindingMoved',
    );
  }
  let findingText: string;
  try {
    findingText = setFrontmatterFix(finding.text, input.prUrl);
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath}: ${err instanceof Error ? err.message : String(err)}`,
      'FindingMalformed',
    );
  }
  const readBack = parseFrontmatter(findingText).data as { status?: unknown; links?: { pr?: unknown } };
  if (readBack.status !== 'fixing' || readBack.links?.pr !== input.prUrl) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath}: the edited frontmatter did not read back as fixing with the PR link.`,
      'FindingMalformed',
    );
  }

  let findingCommitSha: string | null = null;
  if (findingText !== finding.text) {
    const written = await writeRepoFile({
      repo: input.repo,
      path: input.findingPath,
      text: findingText,
      message,
      branch: BRANCH,
      sha: finding.sha,
    });
    findingCommitSha = written.commitSha;
  }

  const index = await readRepoFile(input.indexPath, BRANCH, input.repo);
  if (!index) {
    throw ApplicationFailure.nonRetryable(`${input.indexPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  }
  let indexText: string;
  try {
    indexText = setIndexStatus(index.text, input.key, 'fixing');
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `${input.indexPath}: ${err instanceof Error ? err.message : String(err)}`,
      'FindingMissing',
    );
  }

  let indexCommitSha: string | null = null;
  if (indexText !== index.text) {
    const written = await writeRepoFile({
      repo: input.repo,
      path: input.indexPath,
      text: indexText,
      message,
      branch: BRANCH,
      sha: index.sha,
    });
    indexCommitSha = written.commitSha;
  }

  log.info(
    { activity: 'writeFindingFix', key: input.key, prUrl: input.prUrl, findingCommitSha, indexCommitSha },
    'finding marked fixing',
  );
  return { findingCommitSha, indexCommitSha, commitSha: indexCommitSha ?? findingCommitSha };
}

export interface FixPrState {
  prUrl: string;
  merged: boolean;
  /** ISO 8601, or null while the PR is unmerged. */
  mergedAt: string | null;
}

/**
 * Whether the fixer's PR is merged. The verifier measures production, and a
 * fix that is not merged cannot be there: without this read, a `fixing`
 * finding whose PR is still open would be measured, fail and be reopened.
 */
export async function readFixPr(prUrl: string): Promise<FixPrState> {
  const pr = parsePrUrl(prUrl);
  if (!pr) throw ApplicationFailure.nonRetryable(`${prUrl} is not a pull request URL.`, 'FindingMalformed');
  const data = await gh(`/repos/${pr.repo}/pulls/${pr.number}`);
  return { prUrl, merged: data.merged === true, mergedAt: (data.merged_at as string | null) ?? null };
}

export interface FixPrOutcome {
  prUrl: string;
  state: 'merged' | 'closed';
  /** The merge commit on the base branch, or null for a PR closed unmerged. */
  mergeSha: string | null;
  /** ISO 8601: when it merged or closed. */
  at: string | null;
}

/**
 * The merge wait: one read of the fixer's PR that fails while it is open.
 *
 * Temporal's infrequent-polling pattern (design decision 7). The workflow's
 * retry policy is the loop: a fixed interval, no attempt cap, a
 * schedule-to-close bound. Retries are not events in the history, so a PR open
 * for a month costs one action per poll and no history growth. `PrStillOpen` is
 * the retryable "not yet"; GitHub's permanent errors stay non-retryable
 * through `gh`.
 */
export async function awaitFixPrMerge(prUrl: string): Promise<FixPrOutcome> {
  const pr = parsePrUrl(prUrl);
  if (!pr) throw ApplicationFailure.nonRetryable(`${prUrl} is not a pull request URL.`, 'FindingMalformed');
  const data = await gh(`/repos/${pr.repo}/pulls/${pr.number}`);
  if (data.merged === true) {
    const mergeSha = (data.merge_commit_sha as string | null) ?? null;
    if (!mergeSha) throw ApplicationFailure.retryable(`${prUrl} is merged but GitHub has no merge commit yet.`, 'PrStillOpen');
    return { prUrl, state: 'merged', mergeSha, at: (data.merged_at as string | null) ?? null };
  }
  if (data.state === 'closed') {
    return { prUrl, state: 'closed', mergeSha: null, at: (data.closed_at as string | null) ?? null };
  }
  throw ApplicationFailure.retryable(`${prUrl} is still open.`, 'PrStillOpen');
}

export interface AwaitProductionDeployInput {
  /** `owner/name` of the site repository, the fixer PR's. */
  repo: string;
  /** The PR's merge commit. */
  mergeSha: string;
  /** The GitHub deployment environment Vercel posts production to. */
  environment: string;
}

export interface ProductionDeploy {
  /** The commit production serves. It contains the merge commit. */
  liveSha: string;
  deploymentId: number;
}

/**
 * The deploy wait: one read of what production serves, failing until it
 * contains the merge commit (design decision 6).
 *
 * The live commit is the newest deployment in the environment whose newest
 * status is `success`, read from GitHub's Deployments API, where Vercel's
 * integration posts it. Containment is the compare API, so a later merge whose
 * deploy superseded this one's counts: two merges close together can leave the
 * first without a production deploy of its own. `DeployNotLive` is the
 * retryable "not yet", polled on the same pattern as {@link awaitFixPrMerge}.
 */
export async function awaitProductionDeploy(input: AwaitProductionDeployInput): Promise<ProductionDeploy> {
  const list = (await gh(
    `/repos/${input.repo}/deployments?environment=${encodeURIComponent(input.environment)}&per_page=10`,
  )) as { id: number; sha: string }[];
  const records: DeploymentRecord[] = [];
  for (const deployment of list) {
    const statuses = (await gh(`/repos/${input.repo}/deployments/${deployment.id}/statuses?per_page=1`)) as {
      state: string;
    }[];
    const record = { id: deployment.id, sha: deployment.sha, state: statuses[0]?.state ?? 'none' };
    records.push(record);
    // Newest first: the first success is the live one, and nothing older matters.
    if (record.state === 'success') break;
  }
  const live = liveDeployment(records);
  if (!live) {
    throw ApplicationFailure.retryable(`No ${input.environment} deployment of ${input.repo} has succeeded yet.`, 'DeployNotLive');
  }
  if (live.sha !== input.mergeSha) {
    const compare = await gh(`/repos/${input.repo}/compare/${input.mergeSha}...${live.sha}`);
    if (!compareContains(String(compare.status))) {
      throw ApplicationFailure.retryable(
        `${input.environment} serves ${live.sha.slice(0, 7)}, which does not contain ${input.mergeSha.slice(0, 7)} (${String(compare.status)}).`,
        'DeployNotLive',
      );
    }
  }
  log.info({ activity: 'awaitProductionDeploy', mergeSha: input.mergeSha, liveSha: live.sha }, 'the merge commit is live');
  return { liveSha: live.sha, deploymentId: live.id };
}

export interface AwaitPreviewDeployInput {
  /** `owner/name` of the site repository, the fixer PR's. */
  repo: string;
  /** The PR's head commit. */
  sha: string;
  /** The GitHub deployment environment Vercel posts previews to. */
  environment: string;
}

export interface PreviewDeploy {
  /** The preview's origin, `https://<deployment>.vercel.app`. */
  origin: string;
  deploymentId: number;
}

/**
 * The preview wait: one read of the PR head's preview deployment, failing until
 * Vercel reports it ready.
 *
 * Read from GitHub's Deployments API, as {@link awaitProductionDeploy} reads
 * production: the newest deployment of `sha` in the environment, and its newest
 * status. `success` carries the preview's URL. `failure` or `error` is a build
 * that will not become ready, `PreviewFailed`, and no retry mends it. Anything
 * else, or no deployment yet, is the retryable `PreviewNotReady`.
 */
export async function awaitPreviewDeploy(input: AwaitPreviewDeployInput): Promise<PreviewDeploy> {
  const list = (await gh(
    `/repos/${input.repo}/deployments?sha=${encodeURIComponent(input.sha)}&environment=${encodeURIComponent(input.environment)}&per_page=1`,
  )) as { id: number }[];
  const deployment = list[0];
  if (!deployment) {
    throw ApplicationFailure.retryable(`No ${input.environment} deployment of ${input.sha.slice(0, 7)} yet.`, 'PreviewNotReady');
  }
  const statuses = (await gh(`/repos/${input.repo}/deployments/${deployment.id}/statuses?per_page=1`)) as {
    state: string;
    environment_url?: string;
  }[];
  const state = statuses[0]?.state ?? 'none';
  if (state === 'failure' || state === 'error') {
    throw ApplicationFailure.nonRetryable(
      `The ${input.environment} deployment of ${input.sha.slice(0, 7)} ended ${state}.`,
      'PreviewFailed',
    );
  }
  if (state !== 'success') {
    throw ApplicationFailure.retryable(`The ${input.environment} deployment of ${input.sha.slice(0, 7)} is ${state}.`, 'PreviewNotReady');
  }
  let origin: string;
  try {
    origin = new URL(String(statuses[0].environment_url)).origin;
  } catch {
    throw ApplicationFailure.nonRetryable(
      `The ${input.environment} deployment of ${input.sha.slice(0, 7)} succeeded with no URL.`,
      'PreviewFailed',
    );
  }
  log.info({ activity: 'awaitPreviewDeploy', sha: input.sha, origin }, 'the preview is ready');
  return { origin, deploymentId: deployment.id };
}

export interface WriteFindingReturnedInput {
  repo: string;
  site: string;
  key: string;
  findingPath: string;
  indexPath: string;
  /** The fixer PR that closed unmerged. */
  prUrl: string;
  /** ISO 8601, the workflow's time, for the note. */
  at: string;
}

export interface WriteFindingReturnedResult {
  findingCommitSha: string | null;
  indexCommitSha: string | null;
  /** The last commit this call made. Null when both files already held the return. */
  commitSha: string | null;
}

/**
 * Writes `status: approved` back, with a one-line note naming the closed PR,
 * into the finding file and then its index line, after the fixer's PR closed
 * unmerged. The finding returns to the queue for the next `fix`.
 *
 * The same guard and idempotence as {@link writeFindingVerdict}. It moves a
 * finding from `fixing` only; an `approved` file that already carries this
 * PR's note is the retry case.
 */
export async function writeFindingReturned(input: WriteFindingReturnedInput): Promise<WriteFindingReturnedResult> {
  const message = `returned ${input.key}: ${input.prUrl} closed unmerged`;

  const finding = await readRepoFile(input.findingPath, BRANCH, input.repo);
  if (!finding) {
    throw ApplicationFailure.nonRetryable(`${input.findingPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  }
  const before = parseFrontmatter(finding.text).data as Record<string, unknown>;
  const retry = before.status === 'approved' && finding.text.includes(`${input.prUrl} closed unmerged`);
  if (before.status !== 'fixing' && !retry) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} is ${String(before.status)}, not fixing, so it is not returned to approved.`,
      'FindingMoved',
    );
  }
  let findingText: string;
  try {
    findingText = setFindingReturned(finding.text, input.prUrl, input.at);
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath}: ${err instanceof Error ? err.message : String(err)}`,
      'FindingMalformed',
    );
  }
  if ((parseFrontmatter(findingText).data as Record<string, unknown>).status !== 'approved') {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath}: the edited frontmatter did not read back as approved.`,
      'FindingMalformed',
    );
  }

  let findingCommitSha: string | null = null;
  if (findingText !== finding.text) {
    const written = await writeRepoFile({
      repo: input.repo,
      path: input.findingPath,
      text: findingText,
      message,
      branch: BRANCH,
      sha: finding.sha,
    });
    findingCommitSha = written.commitSha;
  }

  const index = await readRepoFile(input.indexPath, BRANCH, input.repo);
  if (!index) {
    throw ApplicationFailure.nonRetryable(`${input.indexPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  }
  let indexText: string;
  try {
    indexText = setIndexStatus(index.text, input.key, 'approved');
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `${input.indexPath}: ${err instanceof Error ? err.message : String(err)}`,
      'FindingMissing',
    );
  }

  let indexCommitSha: string | null = null;
  if (indexText !== index.text) {
    const written = await writeRepoFile({
      repo: input.repo,
      path: input.indexPath,
      text: indexText,
      message,
      branch: BRANCH,
      sha: index.sha,
    });
    indexCommitSha = written.commitSha;
  }

  log.info(
    { activity: 'writeFindingReturned', key: input.key, prUrl: input.prUrl, findingCommitSha, indexCommitSha },
    'finding returned to approved',
  );
  return { findingCommitSha, indexCommitSha, commitSha: indexCommitSha ?? findingCommitSha };
}

export interface ReadVerifyBlockInput {
  repo: string;
  /** `sites/<site>/findings/<key>.md`, named when the finding's block is refused. */
  findingPath: string;
  /** The finding as `readFinding` returned it. Its `verify` key, when present, is the block. */
  findingText: string;
  /** `sites/<site>/handoffs/<key>.md` */
  handoffPath: string;
  /** The production origin every check must name. */
  origin: string;
}

export interface ReadVerifyBlockResult {
  /** The handoff as it is in the findings repository, or null when the finding's block made it unread. */
  handoff: string | null;
  /** False when neither the finding nor the handoff has a `verify` key: the workflow generates one. */
  hasBlock: boolean;
  checks: VerifyCheck[];
  /**
   * Where the checks come from, decided here so the workflow's branch replays
   * from history (design rule 10). `generated` means none exists yet. Absent
   * from histories written before the finding's block was read.
   */
  source?: VerifyBlockSource;
}

/**
 * A finding's `verify` block: the finding's own when its frontmatter has the
 * key, else the one in its generated handoff.
 *
 * The finding's key wins whatever it holds. A list of checks runs; an empty
 * list is the finder judging the measure unmeasurable, and the handoff is not
 * read. A finding's block that fails {@link validateVerifyBlock} is a failure
 * naming the finding, never a fall back: a typo would hand the definition of
 * fixed back to the fixer.
 *
 * With no key on the finding, the handoff decides. A handoff with no `verify`
 * key is a result, not a failure: the workflow generates the block. A block
 * that is there and fails {@link validateVerifyBlock} is a failure, since a
 * block Steward would not have written is one it does not run.
 */
export async function readVerifyBlock(input: ReadVerifyBlockInput): Promise<ReadVerifyBlockResult> {
  const own = (parseFrontmatter(input.findingText).data ?? {}) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(own, 'verify')) {
    const { checks, problems } = validateVerifyBlock(own.verify, input.origin);
    if (problems.length > 0) {
      throw ApplicationFailure.nonRetryable(
        `The verify block in ${input.findingPath} was refused: ${problems.join('; ')}.`,
        'VerifyBlockInvalid',
      );
    }
    return { handoff: null, hasBlock: true, checks, source: 'finding' };
  }

  const file = await readRepoFile(input.handoffPath, BRANCH, input.repo);
  if (!file) {
    throw ApplicationFailure.nonRetryable(
      `${input.handoffPath} is not in ${input.repo} at ${BRANCH}. The verifier reads a finding's checks from its generated handoff.`,
      'HandoffMissing',
    );
  }
  const verify = readHandoffVerify(file.text);
  if (!verify.present) return { handoff: file.text, hasBlock: false, checks: [], source: 'generated' };
  const { checks, problems } = validateVerifyBlock(verify.raw, input.origin);
  if (problems.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `The verify block in ${input.handoffPath} was refused: ${problems.join('; ')}.`,
      'VerifyBlockInvalid',
    );
  }
  return { handoff: file.text, hasBlock: true, checks, source: 'handoff' };
}

export interface WriteFindingVerificationInput {
  repo: string;
  site: string;
  key: string;
  findingPath: string;
  indexPath: string;
  verification: Verification;
}

export interface WriteFindingVerificationResult {
  findingCommitSha: string | null;
  indexCommitSha: string | null;
  /** The last commit this call made. Null when both files already held this result. */
  commitSha: string | null;
}

/**
 * Writes the verifier's result into the finding file, then into its index
 * line: `resolved` with `resolved_run`, or `reopened`, and the `## Verification`
 * section with each measured value.
 *
 * The same guard and the same idempotence as {@link writeFindingVerdict}.
 *
 * **It moves a finding from `fixing` only.** A file that already holds this
 * run's status is the retry case and passes. Any other status means somebody
 * moved the finding while the checks ran, and the write refuses.
 */
export async function writeFindingVerification(
  input: WriteFindingVerificationInput,
): Promise<WriteFindingVerificationResult> {
  const { status } = input.verification;
  const message = `verify ${input.key}: ${status}`;

  const finding = await readRepoFile(input.findingPath, BRANCH, input.repo);
  if (!finding) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} is not in ${input.repo} at ${BRANCH}, so the result has nowhere to go.`,
      'FindingMissing',
    );
  }
  const before = parseFrontmatter(finding.text).data as Record<string, unknown>;
  const retry = before.status === status && finding.text.includes(input.verification.workflowId);
  if (before.status !== 'fixing' && !retry) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} is ${String(before.status)}, not fixing, so it is not marked ${status}.`,
      'FindingMoved',
    );
  }
  let findingText: string;
  try {
    findingText = setFindingVerification(finding.text, input.verification);
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath}: ${err instanceof Error ? err.message : String(err)}`,
      'FindingMalformed',
    );
  }
  const readBack = parseFrontmatter(findingText).data as Record<string, unknown>;
  if (readBack.status !== status || (readBack.key !== undefined && readBack.key !== input.key)) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath}: the edited frontmatter did not read back as ${status} for ${input.key}.`,
      'FindingMalformed',
    );
  }

  let findingCommitSha: string | null = null;
  if (findingText !== finding.text) {
    const written = await writeRepoFile({
      repo: input.repo,
      path: input.findingPath,
      text: findingText,
      message,
      branch: BRANCH,
      sha: finding.sha,
    });
    findingCommitSha = written.commitSha;
  }

  const index = await readRepoFile(input.indexPath, BRANCH, input.repo);
  if (!index) {
    throw ApplicationFailure.nonRetryable(`${input.indexPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  }
  let indexText: string;
  try {
    indexText = setIndexStatus(index.text, input.key, status);
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `${input.indexPath}: ${err instanceof Error ? err.message : String(err)}`,
      'FindingMissing',
    );
  }

  let indexCommitSha: string | null = null;
  if (indexText !== index.text) {
    const written = await writeRepoFile({
      repo: input.repo,
      path: input.indexPath,
      text: indexText,
      message,
      branch: BRANCH,
      sha: index.sha,
    });
    indexCommitSha = written.commitSha;
  }

  log.info(
    { activity: 'writeFindingVerification', key: input.key, status, findingCommitSha, indexCommitSha },
    'finding verification written',
  );
  return { findingCommitSha, indexCommitSha, commitSha: indexCommitSha ?? findingCommitSha };
}

export interface StartFindingWorkflowInput {
  site: string;
  key: string;
  repo: string;
  findingPath: string;
  indexPath: string;
  stopAfter: FindingStopAfter;
}

/**
 * The production origin a site's checks must name, or undefined for a site
 * this worker does not know. One site today, as `steward finding verify` says.
 */
function productionOrigin(site: string): string | undefined {
  return site === FINDINGS_DEFAULT_SITE ? PROD_ORIGIN : undefined;
}

/**
 * Starts one `findingWorkflow`, or reports that it is already running.
 *
 * **An activity, not a child workflow** (the reconciler's docblock has the
 * account). A child with no execution timeout of its own inherits its parent's,
 * and the reconciler runs under the Schedule's 15-minute timeout, so a child
 * would be timed out long before Matt gave a verdict. A top-level start has no
 * parent and no timeout.
 *
 * **The `resolved` stop point needs three more fields**: the handoff path, the
 * fix branch and the production origin. They are resolved here, from config,
 * and frozen into the started workflow's input (design rule 10), so the
 * reconciler's own input stays `{repo}`. A site with no known origin starts at
 * `verdict`, with a log line: a lifecycle that cannot verify does not start.
 *
 * `ALLOW_DUPLICATE_FAILED_ONLY`: a finding whose workflow completed at a verdict
 * is never reopened by a stale index line, while one that failed or was
 * terminated can be started again. A retry after a start that landed returns
 * `already-started`, so the activity is safe to retry.
 */
export async function startFindingWorkflow(
  input: StartFindingWorkflowInput,
): Promise<'started' | 'already-started'> {
  const client = Context.current().client;
  let args: FindingWorkflowInput = { ...input };
  if (input.stopAfter === 'resolved') {
    const origin = productionOrigin(input.site);
    if (origin) {
      args = { ...args, handoffPath: findingHandoffPath(input.site, input.key), branch: fixBranch(input.key), origin };
    } else {
      log.warn({ activity: 'startFindingWorkflow', site: input.site }, 'no production origin for this site; starting at verdict');
      args = { ...args, stopAfter: 'verdict' };
    }
  }
  try {
    await client.workflow.start('findingWorkflow', {
      workflowId: findingWorkflowId(input.site, input.key),
      taskQueue: QUEUE_FINDINGS,
      args: [args],
      workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
    });
    return 'started';
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return 'already-started';
    throw err;
  }
}

/**
 * The IDs of every running `findingWorkflow`, from the visibility store.
 *
 * Through the worker's own client (`Context.current().client`), so the activity
 * holds no second connection or credential. Visibility is eventually consistent,
 * so a workflow started seconds ago may be missing from this list; the
 * reconciler tolerates that by treating "already started" as unchanged.
 */
export async function listOpenFindingWorkflows(): Promise<string[]> {
  const client = Context.current().client;
  const ids: string[] = [];
  for await (const info of client.workflow.list({
    query: "WorkflowType='findingWorkflow' AND ExecutionStatus='Running'",
  })) {
    ids.push(info.workflowId);
  }
  return ids.sort();
}
