import { ApplicationFailure, Context } from '@temporalio/activity';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { FINDINGS_DEFAULT_SITE, GITHUB_REPO, PROD_ORIGIN, QUEUE_FINDINGS } from '../config.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { listRepoDirectory, readRepoFile, writeRepoFile } from '../lib/github-contents.js';
import { gh } from '../lib/github.js';
import { log } from '../lib/logger.js';
import {
  compareContains,
  findingHandoffPath,
  findingWorkflowId,
  fixBranch,
  fixIssueBody,
  fixIssueClosingComment,
  fixIssueMarker,
  fixIssueTitle,
  fixPrBranchPrefix,
  fixRefusal,
  isFindingSlug,
  liveDeployment,
  parseFindingBody,
  parseFindingsIndex,
  parseIssueUrl,
  parsePrUrl,
  findingsIndexPath,
  setFindingReturned,
  setFindingVerification,
  setFrontmatterFix,
  setFrontmatterVerdict,
  setIndexStatus,
  setIndexVerdict,
  siteConfigPath,
  type FindingVerdictSource,
  type FindingVerdictStatus,
  type FindingsIndexLine,
  type OpenFindingWorkflow,
  type DeploymentRecord,
  type Verification,
  type VerifyBlockSource,
} from '../lib/findings.js';
import { validateVerifyBlock, type VerifyCheck } from '../lib/verify-checks.js';
import type { FindingState, FindingStopAfter, FindingWorkflowInput } from '../workflows/finding.js';

/**
 * The findings store's activities (findings-loop design, "The store and the
 * gate"): four GitHub reads and writes against the findings repository, one
 * visibility list against Temporal, and one workflow start.
 *
 * Every one of them is an API call and none opens a local file, which is the
 * property that lets the hosted worker register them (`worker-hosted.ts`). The
 * repository is a parameter on every call, never read from config here: it rides
 * in the workflow input (design rule 10), so a workflow started against one
 * repository keeps writing to it. The one exception is the site repository
 * `openFixIssue` writes to, resolved like the production origin and returned
 * in its result, so the history holds it from there on.
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

/**
 * The site repository a site's fix issues go to, or undefined for a site this
 * worker does not know. One site today, as {@link productionOrigin} says.
 */
function siteRepository(site: string): string | undefined {
  return site === FINDINGS_DEFAULT_SITE ? GITHUB_REPO : undefined;
}

/**
 * Whether a site's `config.yaml` says `auto_fix: true` (design decision 28).
 * Only the literal `true` counts. Parsed through the frontmatter parser,
 * Steward's one YAML reader, by wrapping the file as a frontmatter block.
 */
export function siteAutoFix(configText: string): boolean {
  const data = parseFrontmatter(`---\n${configText}\n---\n`).data as Record<string, unknown>;
  return data.auto_fix === true;
}

export interface ReadSiteAutoFixInput {
  /** `owner/name` of the findings repository. */
  repo: string;
  site: string;
}

/**
 * The site's `auto_fix` flag, read once when an approved verdict lands. A site
 * with no `config.yaml` has no flag. The answer is an activity result, so the
 * workflow's branch on it replays from history.
 */
export async function readSiteAutoFix(input: ReadSiteAutoFixInput): Promise<boolean> {
  const file = await readRepoFile(siteConfigPath(input.site), BRANCH, input.repo);
  return file ? siteAutoFix(file.text) : false;
}

export interface OpenFixIssueInput {
  /** `owner/name` of the findings repository. */
  repo: string;
  site: string;
  key: string;
  /** `sites/<site>/findings/<key>.md` */
  findingPath: string;
  /**
   * The previous attempt's issue and why it ended, closed with a comment saying
   * so before the new one opens. Null on a first attempt.
   */
  supersedes?: { url: string; reason: string } | null;
}

export interface FixIssue {
  /** `owner/name` of the site repository the issue is in. */
  repo: string;
  number: number;
  url: string;
  /** True when an open issue for this finding already existed and is returned as it is. */
  reused: boolean;
}

/** The open issue in `repo` whose body carries `marker`, or undefined. Pull requests are skipped. */
async function findOpenIssue(repo: string, marker: string): Promise<{ number: number; html_url: string } | undefined> {
  for (let page = 1; ; page++) {
    const items = (await gh(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`)) as {
      number: number;
      html_url: string;
      body?: string | null;
      pull_request?: unknown;
    }[];
    const hit = items.find((item) => !item.pull_request && (item.body ?? '').includes(marker));
    if (hit) return hit;
    if (items.length < 100) return undefined;
  }
}

/**
 * Hands an approved finding to `claude-code-action` (design decisions 26 and
 * 27): one issue in the site repository, the finding file as its body under
 * the spike's six-line header, titled with the finding's H1.
 *
 * **The gate first.** {@link fixRefusal}, the rule the custom fixer ran: an
 * approved defect with a cause and a measure. A finding that fails it is
 * `FindingNotFixable` and no issue opens.
 *
 * **Idempotent on the finding key.** The body ends with a hidden marker naming
 * the finding, and an open issue that carries it is returned instead of a
 * second one. Only open issues count (the card's rule 2), so after
 * `supersedes` closes the last attempt's issue a new one opens.
 *
 * Created with the worker's `GITHUB_TOKEN`, a person's token, so the Action's
 * write-access and human-actor checks pass (the card's rule 1).
 */
export async function openFixIssue(input: OpenFixIssueInput): Promise<FixIssue> {
  const siteRepo = siteRepository(input.site);
  if (!siteRepo) {
    throw ApplicationFailure.nonRetryable(`Steward knows no site repository for ${input.site}.`, 'UnknownSite');
  }
  const finding = await readFinding(input.repo, input.findingPath);
  const refusal = fixRefusal(finding.data, parseFindingBody(finding.text));
  if (refusal) {
    throw ApplicationFailure.nonRetryable(`${input.key} does not go to the fixer: ${refusal}.`, 'FindingNotFixable');
  }

  if (input.supersedes) {
    const old = parseIssueUrl(input.supersedes.url);
    if (!old) throw ApplicationFailure.nonRetryable(`${input.supersedes.url} is not an issue URL.`, 'FindingMalformed');
    const current = await gh(`/repos/${old.repo}/issues/${old.number}`);
    if (current.state === 'open') {
      await gh(`/repos/${old.repo}/issues/${old.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: fixIssueClosingComment(input.supersedes.reason) }),
      });
      await gh(`/repos/${old.repo}/issues/${old.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
      });
      log.info({ activity: 'openFixIssue', key: input.key, closed: input.supersedes.url }, 'previous fix issue closed');
    }
  }

  const marker = fixIssueMarker(input.site, input.key);
  const open = await findOpenIssue(siteRepo, marker);
  if (open) {
    log.info({ activity: 'openFixIssue', key: input.key, issue: open.html_url }, 'fix issue already open');
    return { repo: siteRepo, number: open.number, url: open.html_url, reused: true };
  }
  const created = await gh(`/repos/${siteRepo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: fixIssueTitle(finding.text),
      body: fixIssueBody(input.site, input.key, finding.text, finding.data.verdict_reason),
    }),
  });
  log.info({ activity: 'openFixIssue', key: input.key, issue: created.html_url }, 'fix issue opened');
  return { repo: siteRepo, number: created.number as number, url: created.html_url as string, reused: false };
}

export interface AwaitFixPrInput {
  /** `owner/name` of the site repository, the issue's. */
  repo: string;
  issueNumber: number;
}

export interface FixPr {
  prUrl: string;
  /** The PR's head branch, `claude/issue-<n>-…`. */
  branch: string;
}

/**
 * The PR wait: one read of the site repository's open PRs that fails until one
 * has a head branch starting `claude/issue-<n>-`, the branch the Action cuts
 * for issue `n`. The branch prefix is the match, not the PR body's `Fixes #n`
 * (the card's rule 3).
 *
 * The same infrequent-polling pattern as {@link awaitFixPrMerge}: `FixPrNotOpen`
 * is the retryable "not yet", and the workflow's schedule-to-close bound is the
 * 60-minute give-up, which reaches the workflow as a timeout. Each attempt is
 * one short read, so it needs no heartbeat.
 */
export async function awaitFixPr(input: AwaitFixPrInput): Promise<FixPr> {
  const prefix = fixPrBranchPrefix(input.issueNumber);
  const pulls = (await gh(`/repos/${input.repo}/pulls?state=open&per_page=100`)) as {
    html_url: string;
    head?: { ref?: string };
  }[];
  const match = pulls.find((pr) => pr.head?.ref?.startsWith(prefix));
  if (!match) {
    throw ApplicationFailure.retryable(`No open PR in ${input.repo} from a ${prefix} branch yet.`, 'FixPrNotOpen');
  }
  log.info({ activity: 'awaitFixPr', issue: input.issueNumber, pr: match.html_url }, 'the fix PR is open');
  return { prUrl: match.html_url, branch: match.head?.ref as string };
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
  const read = await readLive(input);
  if (!read.live) throw ApplicationFailure.retryable(read.why, 'DeployNotLive');
  if (!read.contains) throw ApplicationFailure.retryable(read.why, 'DeployNotLive');
  log.info({ activity: 'awaitProductionDeploy', mergeSha: input.mergeSha, liveSha: read.live.sha }, 'the merge commit is live');
  return { liveSha: read.live.sha, deploymentId: read.live.id };
}

/**
 * The deploy wait's read and compare, once: the live deployment, and whether
 * its commit contains the merge commit. `why` says what is missing when either
 * is.
 */
async function readLive(
  input: AwaitProductionDeployInput,
): Promise<{ live: DeploymentRecord | undefined; contains: boolean; why: string }> {
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
    return { live, contains: false, why: `No ${input.environment} deployment of ${input.repo} has succeeded yet.` };
  }
  if (live.sha === input.mergeSha) return { live, contains: true, why: '' };
  const compare = await gh(`/repos/${input.repo}/compare/${input.mergeSha}...${live.sha}`);
  const status = String(compare.status);
  if (compareContains(status)) return { live, contains: true, why: '' };
  return {
    live,
    contains: false,
    why: `${input.environment} serves ${live.sha.slice(0, 7)}, which does not contain ${input.mergeSha.slice(0, 7)} (${status}).`,
  };
}

export interface ReadProductionDeployInput {
  /** The fix PR, from the finding's `links.pr`. */
  prUrl: string;
  /** The GitHub deployment environment Vercel posts production to. */
  environment: string;
}

export interface ProductionRead {
  prUrl: string;
  /** The PR's merge commit, or null when GitHub has none. */
  mergeSha: string | null;
  /** The commit production serves, or null when no deployment has succeeded. */
  liveSha: string | null;
  deploymentId: number | null;
  /** True when the live commit contains the merge commit. */
  contains: boolean;
  /** What is missing when `contains` is false. */
  why: string;
  /** ISO 8601, when production was read. */
  readAt: string;
}

/**
 * A blockless verify's one look at production (design decision 30): the fix
 * PR's merge commit, then {@link awaitProductionDeploy}'s read and compare,
 * one attempt. Not contained is an answer, not a retry: the verify has no
 * "not yet" to wait out, since the lifecycle's deploy wait or the operator
 * already decided the fix is live.
 */
export async function readProductionDeploy(input: ReadProductionDeployInput): Promise<ProductionRead> {
  const pr = parsePrUrl(input.prUrl);
  if (!pr) throw ApplicationFailure.nonRetryable(`${input.prUrl} is not a pull request URL.`, 'FindingMalformed');
  const data = await gh(`/repos/${pr.repo}/pulls/${pr.number}`);
  const mergeSha = (data.merge_commit_sha as string | null) ?? null;
  const readAt = new Date().toISOString();
  const none = { prUrl: input.prUrl, mergeSha, liveSha: null, deploymentId: null, contains: false, readAt };
  if (data.merged !== true || !mergeSha) {
    return { ...none, why: `${input.prUrl} has no merge commit on GitHub.` };
  }
  const read = await readLive({ repo: pr.repo, mergeSha, environment: input.environment });
  log.info(
    { activity: 'readProductionDeploy', prUrl: input.prUrl, mergeSha, liveSha: read.live?.sha, contains: read.contains },
    'production read for a blockless verify',
  );
  return {
    ...none,
    liveSha: read.live?.sha ?? null,
    deploymentId: read.live?.id ?? null,
    contains: read.contains,
    why: read.why,
  };
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
  /** `sites/<site>/handoffs/<key>.md`. Unread since design decision 29. */
  handoffPath?: string;
  /** The production origin every check must name. */
  origin: string;
}

export interface ReadVerifyBlockResult {
  /** Always null since decision 29: the handoff is not read. */
  handoff: string | null;
  /** False when the finding has no `verify` key. */
  hasBlock: boolean;
  checks: VerifyCheck[];
  /** `finding`. Absent from histories written before the finding's block was read. */
  source?: VerifyBlockSource;
}

/**
 * A finding's `verify` block, from the finding's own frontmatter and nowhere
 * else (design decision 29). Argus writes it at filing time.
 *
 * A list of checks runs. An empty list is the finder judging the measure
 * unmeasurable, and a finding with no `verify` key has no measure at all:
 * both return no checks, and the workflow confirms the fix by its deploy
 * instead (design decision 30). A block that fails {@link validateVerifyBlock}
 * is a failure naming the finding: a typo is not a pass.
 */
export async function readVerifyBlock(input: ReadVerifyBlockInput): Promise<ReadVerifyBlockResult> {
  const own = (parseFrontmatter(input.findingText).data ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(own, 'verify')) {
    return { handoff: null, hasBlock: false, checks: [], source: 'finding' };
  }
  const { checks, problems } = validateVerifyBlock(own.verify, input.origin);
  if (problems.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `The verify block in ${input.findingPath} was refused: ${problems.join('; ')}.`,
      'VerifyBlockInvalid',
    );
  }
  return { handoff: null, hasBlock: true, checks, source: 'finding' };
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
 * **It moves a finding from `fixing` or `reopened` only**, the two statuses
 * the workflow's gate admits. A file that already holds this run's result is
 * the retry case and passes. Any other status means somebody moved the finding
 * while the checks ran, and the write refuses.
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
  if (before.status !== 'fixing' && before.status !== 'reopened' && !retry) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} is ${String(before.status)}, not fixing or reopened, so it is not marked ${status}.`,
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
  /** The index line's status. Absent from inputs recorded before `reopened` was started; read it as `proposed`. */
  indexStatus?: 'proposed' | 'reopened';
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
 * `ALLOW_DUPLICATE_FAILED_ONLY` for a `proposed` line: a finding whose workflow
 * completed at a verdict is never reopened by a stale index line, while one
 * that failed or was terminated can be started again. `ALLOW_DUPLICATE` for a
 * `reopened` line: its last run completed by writing `reopened`, so that run
 * is history, and the new one returns the finding to the verdict gate. A
 * retry after a start that landed returns `already-started`, so the activity
 * is safe to retry.
 *
 * The line's status rides in the memo, so `steward finding list` names a
 * reopened finding without a query per workflow.
 */
export async function startFindingWorkflow(
  input: StartFindingWorkflowInput,
): Promise<'started' | 'already-started'> {
  const client = Context.current().client;
  const { indexStatus = 'proposed', ...rest } = input;
  let args: FindingWorkflowInput = { ...rest };
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
      workflowIdReusePolicy: indexStatus === 'reopened' ? 'ALLOW_DUPLICATE' : 'ALLOW_DUPLICATE_FAILED_ONLY',
      memo: { indexStatus },
    });
    return 'started';
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return 'already-started';
    throw err;
  }
}

/**
 * Every running `findingWorkflow` from the visibility store, with the `step`
 * and `fixAttempts` its `state` query reports.
 *
 * Through the worker's own client (`Context.current().client`), so the activity
 * holds no second connection or credential. Visibility is eventually consistent,
 * so a workflow started seconds ago may be missing from this list; the
 * reconciler tolerates that by treating "already started" as unchanged.
 *
 * A run that closed between the list and its query is dropped: its query
 * reads `step: done`, or the run is gone. Any other query
 * failure (a run whose workflow task is failing, say) keeps the run with a
 * null step, which the reconciler treats as it treated every run before it
 * knew steps: one stuck run must not stop the whole pass.
 */
export async function listOpenFindingWorkflows(): Promise<OpenFindingWorkflow[]> {
  const client = Context.current().client;
  const runs: OpenFindingWorkflow[] = [];
  for await (const info of client.workflow.list({
    query: "WorkflowType='findingWorkflow' AND ExecutionStatus='Running'",
  })) {
    try {
      // By name: importing `findingStateQuery` would load the workflow module here.
      const state = await client.workflow.getHandle(info.workflowId, info.runId).query<FindingState>('state');
      if (state.step === 'done') continue;
      runs.push({ workflowId: info.workflowId, step: state.step ?? null, fixAttempts: state.fixAttempts ?? null });
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) continue;
      log.warn(
        { activity: 'listOpenFindingWorkflows', workflowId: info.workflowId, error: err instanceof Error ? err.message : String(err) },
        'state query failed; listing the run with no step',
      );
      runs.push({ workflowId: info.workflowId, step: null, fixAttempts: null });
    }
  }
  return runs.sort((a, b) => a.workflowId.localeCompare(b.workflowId));
}
