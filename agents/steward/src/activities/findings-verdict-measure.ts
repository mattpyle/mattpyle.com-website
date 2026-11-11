import { ApplicationFailure } from '@temporalio/activity';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { branchSha, commitFiles, fastForwardBranch, readRepoFile } from '../lib/github-contents.js';
import { log } from '../lib/logger.js';
import {
  buildVerdictMeasureSection,
  setFindingVerdictMeasure,
  setFindingVerification,
  setIndexStatus,
  type VerdictMeasure,
  type Verification,
} from '../lib/findings.js';

/**
 * The write of a finding's measurement at its approved verdict (STW-589).
 *
 * Like the other findings activities it is a GitHub API call against the
 * findings repository and opens no local file, so the hosted worker registers
 * it on `steward-findings`.
 */

const BRANCH = 'main';

export interface WriteFindingVerdictMeasureInput {
  repo: string;
  key: string;
  findingPath: string;
  indexPath: string;
  measure: VerdictMeasure;
  /** Set when every check passed: the finding is resolved in the same commit. */
  verification?: Verification;
}

export interface WriteFindingVerdictMeasureResult {
  /** Null when the files already held this result. */
  commitSha: string | null;
}

/**
 * One commit on `main`. It always writes the `## Measured at the verdict`
 * section. With `verification` it also resolves the finding: `status:
 * resolved`, `resolved_run`, the `## Verification` section and the INDEX.md
 * line, as the recheck does.
 *
 * The file must read `approved` with no `resolved_run`. A file that already
 * holds this run's section (and, when resolving, reads `resolved`) is the
 * retry case and writes nothing. Any other state means a person or another run
 * moved the finding while the checks ran, and the write refuses with
 * `FindingMoved`. A branch that moved between the read and the commit is
 * retried by the activity's retry policy.
 */
export async function writeFindingVerdictMeasure(input: WriteFindingVerdictMeasureInput): Promise<WriteFindingVerdictMeasureResult> {
  const { findingPath, indexPath, measure, verification } = input;
  // The head first, then the files at the branch: a commit that moved the
  // branch in between makes the files newer than `head`, and the fast-forward
  // then refuses, so the retry builds on the new head.
  const head = await branchSha(BRANCH, input.repo);
  const finding = await readRepoFile(findingPath, BRANCH, input.repo);
  if (!finding) throw ApplicationFailure.nonRetryable(`${findingPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
  const before = (parseFrontmatter(finding.text).data ?? {}) as Record<string, unknown>;

  // The exact section, time included: a later run on the same finding has the
  // same workflow ID, so the ID alone would read its first approval as a retry.
  const written = finding.text.replace(/\r\n/g, '\n').includes(buildVerdictMeasureSection(measure));
  const retry = written && (verification ? before.status === 'resolved' : before.status === 'approved');
  if (retry) return { commitSha: null };
  if (before.status !== 'approved' || before.resolved_run) {
    throw ApplicationFailure.nonRetryable(
      `${findingPath} is ${String(before.status ?? 'without a status')}${before.resolved_run ? ` with resolved_run ${String(before.resolved_run)}` : ''}, not approved and unresolved, so the measurement at the verdict is not written.`,
      'FindingMoved',
    );
  }

  let text: string;
  try {
    text = setFindingVerdictMeasure(finding.text, measure);
    if (verification) text = setFindingVerification(text, verification);
  } catch (err) {
    throw ApplicationFailure.nonRetryable(`${findingPath}: ${err instanceof Error ? err.message : String(err)}`, 'FindingMalformed');
  }
  const readBack = (parseFrontmatter(text).data ?? {}) as Record<string, unknown>;
  const wanted = verification ? 'resolved' : 'approved';
  if (readBack.status !== wanted || (verification && !readBack.resolved_run)) {
    throw ApplicationFailure.nonRetryable(`${findingPath}: the edited frontmatter did not read back as ${wanted}.`, 'FindingMalformed');
  }

  const files: { path: string; text: string }[] = [];
  if (text !== finding.text) files.push({ path: findingPath, text });
  if (verification) {
    const index = await readRepoFile(indexPath, BRANCH, input.repo);
    if (!index) throw ApplicationFailure.nonRetryable(`${indexPath} is not in ${input.repo} at ${BRANCH}.`, 'FindingMissing');
    let indexText: string;
    try {
      indexText = setIndexStatus(index.text, input.key, 'resolved');
    } catch (err) {
      throw ApplicationFailure.nonRetryable(`${indexPath}: ${err instanceof Error ? err.message : String(err)}`, 'FindingMissing');
    }
    if (indexText !== index.text) files.push({ path: indexPath, text: indexText });
  }

  if (files.length === 0) return { commitSha: null };
  const message = verification ? `verdict ${input.key}: measured, resolved` : `verdict ${input.key}: measured`;
  const commit = await commitFiles({ repo: input.repo, parent: head, message, files });
  if (!(await fastForwardBranch(BRANCH, commit, input.repo))) {
    throw ApplicationFailure.retryable(`${BRANCH} moved while ${input.key} was written; retrying on the new head.`, 'BranchMoved');
  }
  log.info({ activity: 'writeFindingVerdictMeasure', key: input.key, commit, files: files.map((f) => f.path) }, 'verdict measurement written');
  return { commitSha: commit };
}
