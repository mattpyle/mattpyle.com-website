import { ApplicationFailure, Context } from '@temporalio/activity';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { QUEUE_FINDINGS } from '../config.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { listRepoDirectory, readRepoFile, writeRepoFile } from '../lib/github-contents.js';
import { log } from '../lib/logger.js';
import {
  findingWorkflowId,
  isFindingSlug,
  parseFindingsIndex,
  findingsIndexPath,
  setFrontmatterVerdict,
  setIndexVerdict,
  type FindingVerdictSource,
  type FindingVerdictStatus,
  type FindingsIndexLine,
} from '../lib/findings.js';

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

export interface StartFindingWorkflowInput {
  site: string;
  key: string;
  repo: string;
  findingPath: string;
  indexPath: string;
  stopAfter: 'verdict';
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
 * `ALLOW_DUPLICATE_FAILED_ONLY`: a finding whose workflow completed at a verdict
 * is never reopened by a stale index line, while one that failed or was
 * terminated can be started again. A retry after a start that landed returns
 * `already-started`, so the activity is safe to retry.
 */
export async function startFindingWorkflow(
  input: StartFindingWorkflowInput,
): Promise<'started' | 'already-started'> {
  const client = Context.current().client;
  try {
    await client.workflow.start('findingWorkflow', {
      workflowId: findingWorkflowId(input.site, input.key),
      taskQueue: QUEUE_FINDINGS,
      args: [input],
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
