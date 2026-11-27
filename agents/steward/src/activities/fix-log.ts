import { ApplicationFailure, Context } from '@temporalio/activity';
import { draftFixLogEntry as draftEntry, type DraftUsage, type ReviewProblem } from '../lib/fix-log-draft.js';
import { BRIEF_PATH, noteText, readEntries } from '../lib/fix-log-backfill.js';
import { backfillGitHub, diffOf } from '../lib/fix-log-backfill-github.js';
import { entryFile, entryPath, findingFacts } from '../lib/fix-log-rules.js';
import { parsePrUrl } from '../lib/findings.js';
import { branchSha, commitFiles, fastForwardBranch, readRepoFile } from '../lib/github-contents.js';
import { gh } from '../lib/github.js';
import { fixLogSend, type FixLogSend } from '../lib/llm.js';
import { log } from '../lib/logger.js';
import { commentOnFixPr, readFinding } from './findings.js';

/**
 * The fix log entry step of `findingWorkflow` (STW-710, slice 3 of the fix log
 * writer): two activities on `steward-findings`, run on the hosted worker.
 *
 * `draftFixLogEntry` reads everything the draft needs and makes the model calls
 * through `lib/fix-log-draft.ts`. It reads the brief from `master` and the titles
 * and slugs of every entry on `master` and on each open fix branch, never from the
 * fix PR's own head, so a fixer cannot steer what Steward publishes by editing the
 * brief in its PR. When the entry is already on the PR's branch it makes no model
 * call and says so.
 *
 * `commitFixLogEntry` commits the one file to the PR's branch, on top of the head it
 * read, and moves the branch without force: a fixer push in between makes GitHub
 * refuse, and the activity reports `moved` rather than hide that push from the
 * retest. It does nothing when the file is already on the branch. Review notes go
 * on the PR as one comment, on that path too, so a retry after the commit landed
 * still posts them. A comment that fails is reported, never thrown: the workflow's
 * state line keeps the notes, and the commit is not repeated.
 *
 * Both are shaped for the workflow's bound: the draft heartbeats and passes the
 * activity's cancellation to each model call, and its permanent failures are
 * non-retryable (`ModelKeyMissing`, `ModelRequestRefused`, `FixLogEntryInvalid`,
 * `FindingNotInLog`, and the GitHub refusals).
 */

const BASE = 'master';
/** The head branches of the Action's fix PRs. */
const FIX_BRANCH_PREFIX = 'claude/issue-';
/** How often the draft heartbeats while a model turn runs. */
const HEARTBEAT_MS = 30_000;

/** The hidden line that tells the notes comment of one entry from every other comment. */
export const fixLogNotesMarker = (key: string): string => `<!-- steward-fix-log-notes ${key} -->`;

export interface DraftFixLogEntryActivityInput {
  /** `owner/name` of the findings repository. */
  repo: string;
  findingPath: string;
  /** The finding's key, for the log line. */
  key: string;
  prUrl: string;
}

export type DraftFixLogEntryActivityResult =
  | { state: 'exists'; key: string; path: string }
  | {
      state: 'drafted';
      key: string;
      path: string;
      text: string;
      title: string;
      slug: string;
      attempts: number;
      reviewRounds: number;
      reviewNotes: ReviewProblem[];
      usage: DraftUsage;
    };

interface PullFacts {
  repo: string;
  number: number;
  branch: string;
  title: string;
  body: string;
  opened: string;
  merged: string | null;
}

async function readPull(prUrl: string): Promise<PullFacts> {
  const pr = parsePrUrl(prUrl);
  if (!pr) throw ApplicationFailure.nonRetryable(`${prUrl} is not a pull request URL.`, 'FindingMalformed');
  const pull = await gh(`/repos/${pr.repo}/pulls/${pr.number}`);
  return {
    repo: pr.repo,
    number: pr.number,
    branch: String(pull.head?.ref ?? ''),
    title: String(pull.title ?? ''),
    body: String(pull.body ?? ''),
    opened: String(pull.created_at ?? ''),
    merged: pull.merged === true ? String(pull.merged_at) : null,
  };
}

/** The head branches of the open fix PRs in `repo`, except `except`. */
async function openFixBranches(repo: string, except: string): Promise<string[]> {
  const branches: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const pulls = (await gh(`/repos/${repo}/pulls?state=open&per_page=100&page=${page}`)) as Array<{ head?: { ref?: string } }>;
    for (const p of pulls) {
      const ref = p.head?.ref;
      if (ref && ref.startsWith(FIX_BRANCH_PREFIX) && ref !== except) branches.push(ref);
    }
    if (pulls.length < 100) break;
  }
  return branches;
}

export interface DraftActivityDeps {
  /** The model. Defaults to the real one at `STEWARD_FIX_LOG_MODEL`. Tests inject it. */
  send?: FixLogSend;
  review?: FixLogSend;
}

/** The draft, with its model injectable for tests. The activity below passes the real one. */
export async function draftFixLogEntryWith(
  input: DraftFixLogEntryActivityInput,
  deps: DraftActivityDeps,
): Promise<DraftFixLogEntryActivityResult> {
  const finding = await readFinding(input.repo, input.findingPath);
  const facts = findingFacts(finding.text);
  if (!facts) {
    throw ApplicationFailure.nonRetryable(`${input.findingPath} has no fix pull request in links.pr.`, 'FindingNotInLog');
  }
  const pull = await readPull(input.prUrl);
  const path = entryPath(facts.key);
  if (await readRepoFile(path, pull.branch, pull.repo)) {
    log.info({ activity: 'draftFixLogEntry', key: input.key, pr: input.prUrl }, 'the entry is already on the PR branch');
    return { state: 'exists', key: facts.key, path };
  }

  // The brief and every other entry's title, from master and the open fix branches only.
  const github = backfillGitHub();
  const brief = await github.readFile(pull.repo, BRIEF_PATH, BASE);
  if (!brief) throw ApplicationFailure.nonRetryable(`${BRIEF_PATH} is not on ${BASE} in ${pull.repo}.`, 'FixLogBriefMissing');
  const refs = [BASE, ...(await openFixBranches(pull.repo, pull.branch))];
  const entries = await readEntries(github, pull.repo, refs);
  const diff = await diffOf(pull.repo, pull.number);

  const context = activityContext();
  const beat = (details?: unknown) => context?.heartbeat(details);
  const timer = context ? setInterval(() => beat(), HEARTBEAT_MS) : undefined;
  try {
    const draft = await draftEntry(
      {
        finding: { key: facts.key, text: finding.text },
        pr: { number: pull.number, title: pull.title, body: pull.body, diff, opened: pull.opened, merged: pull.merged },
        brief,
        taken: { titles: entries.titles, slugs: entries.slugs },
      },
      {
        send: deps.send ?? fixLogSend(),
        ...(deps.review ? { review: deps.review } : {}),
        ...(context ? { signal: context.cancellationSignal } : {}),
        onAttempt: (attempt) => beat({ attempt }),
        onReview: (round) => beat({ review: round }),
      },
    );
    log.info(
      { activity: 'draftFixLogEntry', key: input.key, pr: input.prUrl, attempts: draft.attempts, reviewRounds: draft.reviewRounds, notes: draft.reviewNotes.length },
      'fix log entry drafted',
    );
    return { state: 'drafted', ...draft };
  } finally {
    if (timer) clearInterval(timer);
  }
}

/** The activity's context, or undefined when called outside an activity (a unit test). */
function activityContext(): Context | undefined {
  try {
    return Context.current();
  } catch {
    return undefined;
  }
}

/** `draftFixLogEntry`, the activity: the real model. */
export async function draftFixLogEntry(input: DraftFixLogEntryActivityInput): Promise<DraftFixLogEntryActivityResult> {
  return draftFixLogEntryWith(input, {});
}

export interface CommitFixLogEntryInput {
  prUrl: string;
  /** The entry's key, `MP-<n>`. */
  key: string;
  /** `src/content/fixes/<key>.md`. */
  path: string;
  text: string;
  /** The reviewer's notes a person must read: posted as one PR comment when any. */
  notes: ReviewProblem[];
}

export interface CommitFixLogEntryResult {
  /**
   * `committed`: the file is on the branch in a new commit. `exists`: it was there
   * already. `moved`: the branch moved while the commit was built, so nothing landed.
   */
  state: 'committed' | 'exists' | 'moved';
  /** The new commit, when committed. */
  sha: string | null;
  /** The branch head the commit was built on, when committed. */
  parent: string | null;
  /** `posted`, `none` (no notes, or already on the PR), or why the comment failed. */
  notes: string;
  /** When committed: whether the PR showed the commit as its head before this returned. */
  headSeen?: boolean;
}

/** The notes comment's text. */
export function notesComment(key: string, path: string, notes: ReviewProblem[]): string {
  return [
    `Steward wrote the fix log entry \`${path}\` for ${key} in this pull request. Its reviewer still objected to these lines after its last round. Read and mend each before merging:`,
    '',
    ...notes.map((n, i) => `${i + 1}. "${noteText(n.quote)}" (${noteText(n.rule)}): ${noteText(n.reason)}`),
  ].join('\n');
}

async function postNotes(input: CommitFixLogEntryInput): Promise<string> {
  if (input.notes.length === 0) return 'none';
  try {
    const { posted } = await commentOnFixPr({
      prUrl: input.prUrl,
      marker: fixLogNotesMarker(input.key),
      body: notesComment(input.key, input.path, input.notes),
    });
    return posted ? 'posted' : 'none';
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ activity: 'commitFixLogEntry', pr: input.prUrl, error: reason }, 'the fix log notes comment failed');
    return `the comment failed: ${reason}`;
  }
}

/** `commitFixLogEntry`, the activity. */
export async function commitFixLogEntry(input: CommitFixLogEntryInput): Promise<CommitFixLogEntryResult> {
  const pull = await readPull(input.prUrl);
  if (await readRepoFile(input.path, pull.branch, pull.repo)) {
    return { state: 'exists', sha: null, parent: null, notes: await postNotes(input) };
  }
  const parent = await branchSha(pull.branch, pull.repo);
  const sha = await commitFiles({
    repo: pull.repo,
    parent,
    message: `Fix log: add the entry for ${input.key}`,
    files: [{ path: input.path, text: input.text }],
  });
  if (!(await fastForwardBranch(pull.branch, sha, pull.repo))) {
    log.info({ activity: 'commitFixLogEntry', pr: input.prUrl, parent }, 'the PR branch moved; the entry was not committed');
    return { state: 'moved', sha: null, parent: null, notes: 'none' };
  }
  log.info({ activity: 'commitFixLogEntry', pr: input.prUrl, sha, file: entryFile(input.key) }, 'fix log entry committed');
  const headSeen = await awaitPrHead(pull, sha);
  if (!headSeen) {
    log.warn({ activity: 'commitFixLogEntry', pr: input.prUrl, sha }, 'the PR head did not show the entry commit; the merge wait may test it once');
  }
  return { state: 'committed', sha, parent, notes: await postNotes(input), headSeen };
}

/**
 * How long `commitFixLogEntry` waits for the PR to show its commit as head. Mutable
 * so a test can shorten it.
 *
 * Why: GitHub's pull request object lags a ref update made through the Git Data API.
 * On 2026-11-27 (finding MP-187, PR 822) the pulls API still returned the old head
 * 0.65 seconds after the ref moved, so the merge wait's first poll read it as a push
 * and tested Steward's own commit. Waiting here keeps the merge wait's `head !==
 * retestAfter` test as it is, for the fixer's pushes too.
 */
export const PR_HEAD_SETTLE = { tries: 10, intervalMs: 1000 };

/** Reads the PR until its head is `sha`, a few short tries. False when it never is; the merge wait then tests the commit once. */
async function awaitPrHead(pull: PullFacts, sha: string): Promise<boolean> {
  for (let i = 0; i < PR_HEAD_SETTLE.tries; i++) {
    const now = await gh(`/repos/${pull.repo}/pulls/${pull.number}`);
    if (String(now.head?.sha ?? '') === sha) return true;
    if (i < PR_HEAD_SETTLE.tries - 1) await new Promise((resolve) => setTimeout(resolve, PR_HEAD_SETTLE.intervalMs));
  }
  return false;
}
