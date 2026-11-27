import { ApplicationFailure } from '@temporalio/activity';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { branchSha, commitFiles, fastForwardBranch, readRepoFile } from '../lib/github-contents.js';
import { log } from '../lib/logger.js';
import { setIndexStatus } from '../lib/findings.js';
import { hasRecheckSection, isArgusRunId, resolvedByLook, setFindingLookResolved, type LookResolvedBy } from '../lib/finding-look.js';

/**
 * `writeFindingLook` (stage 5, slice A): the one write of an Argus look that
 * found an approved finding gone. `findingWorkflow` issues it at the step
 * `recording-look`, after a `record-look` Update, on `steward-findings` with
 * the durable policy. `watchFinding` calls it too, when the file carries
 * `looked_fixed` and the Update never came.
 *
 * Argus has already committed the body: its `## Re-check <run>` section and
 * its evidence. This writes the fields only, in one commit on `main` with the
 * compare-and-swap on the branch head that `writeFindingRecheck` uses:
 *
 * | The file on `main` | The write |
 * |---|---|
 * | `approved`, no `resolved_run`, `## Re-check <run>` present | `status: resolved`, `resolved_run: <run>`, `resolved_by: review` and the index line, one commit |
 * | `approved`, no `## Re-check <run>` section | Refuses `LookBodyMissing`: the body did not land first |
 * | `resolved` by this look | Success, nothing written, `by: 'look'` |
 * | `resolved` by anything else | Success, nothing written, `by: 'watch'` when the text names the run, else `'elsewhere'` |
 * | Any other status, a `resolved_run` on an approved file, or no file | Refuses `FindingMoved` or `FindingMissing` |
 *
 * The file's text never gets a workflow ID; the commit message names the run.
 * A watch's write and this one can meet, because a cancelled `watchFinding`
 * attempt can still commit. Both read the head first and fast-forward onto it,
 * so whichever commits second reads the other's result: `BranchMoved` is
 * retryable, and the next attempt builds on the new head.
 */

const BRANCH = 'main';

export interface WriteFindingLookInput {
  repo: string;
  site: string;
  key: string;
  /** `sites/<site>/findings/<key>.md` */
  findingPath: string;
  /** `sites/<site>/findings/INDEX.md` */
  indexPath: string;
  /** Argus's run identifier, `2026-11-26T0830Z`. */
  run: string;
  /** The finding run that writes, for the commit message only. */
  by: string;
  /** `message` for the Update, `file` for `looked_fixed` read by the watch. */
  via?: 'message' | 'file';
}

export interface WriteFindingLookResult {
  by: LookResolvedBy;
  /** The `resolved_run` the file holds after the write. */
  resolvedRun: string | null;
  /** Null when nothing was written. */
  commitSha: string | null;
}

export async function writeFindingLook(input: WriteFindingLookInput): Promise<WriteFindingLookResult> {
  if (!isArgusRunId(input.run)) {
    throw ApplicationFailure.nonRetryable(`The look's run is not an Argus run identifier: ${JSON.stringify(String(input.run).slice(0, 40))}.`, 'BadInput');
  }
  // The head first, then the files at the branch, as `writeFindingRecheck` does.
  const head = await branchSha(BRANCH, input.repo);
  const finding = await readRepoFile(input.findingPath, BRANCH, input.repo);
  if (!finding) throw ApplicationFailure.nonRetryable(`${input.findingPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  const data = (parseFrontmatter(finding.text).data ?? {}) as Record<string, unknown>;
  const resolvedRun = data.resolved_run === undefined || data.resolved_run === null ? null : String(data.resolved_run);

  if (resolvedByLook(data, input.run)) return { by: 'look', resolvedRun, commitSha: null };
  if (data.status === 'resolved') {
    return { by: finding.text.includes(input.by) ? 'watch' : 'elsewhere', resolvedRun, commitSha: null };
  }
  if (data.status !== 'approved' || resolvedRun !== null) {
    const says = typeof data.status === 'string' ? `says ${data.status}` : 'has no status';
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} ${says}${resolvedRun ? ` with resolved_run ${resolvedRun}` : ''}, so the look is not written.`,
      'FindingMoved',
    );
  }
  if (!hasRecheckSection(finding.text, input.run)) {
    throw ApplicationFailure.nonRetryable(
      `${input.findingPath} has no "## Re-check ${input.run}" section on ${BRANCH}: the body must land before the look.`,
      'LookBodyMissing',
    );
  }

  const text = setFindingLookResolved(finding.text, input.run);
  const readBack = (parseFrontmatter(text).data ?? {}) as Record<string, unknown>;
  if (!resolvedByLook(readBack, input.run)) {
    throw ApplicationFailure.nonRetryable(`${input.findingPath}: the edited frontmatter did not read back as resolved by the look.`, 'FindingMalformed');
  }
  const files = [{ path: input.findingPath, text }];
  const index = await readRepoFile(input.indexPath, BRANCH, input.repo);
  if (!index) throw ApplicationFailure.nonRetryable(`${input.indexPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  const indexText = setIndexStatus(index.text, input.key, 'resolved');
  if (indexText !== index.text) files.push({ path: input.indexPath, text: indexText });

  const from = input.via === 'file' ? `looked_fixed ${input.run}` : `Argus run ${input.run}`;
  const message = `look ${input.key}: resolved by ${from} (${input.by})`;
  const commit = await commitFiles({ repo: input.repo, parent: head, message, files });
  if (!(await fastForwardBranch(BRANCH, commit, input.repo))) {
    throw ApplicationFailure.retryable(`${BRANCH} moved while the look on ${input.key} was written; retrying on the new head.`, 'BranchMoved');
  }
  log.info({ activity: 'writeFindingLook', key: input.key, run: input.run, commit }, 'look written');
  return { by: 'look', resolvedRun: input.run, commitSha: commit };
}
