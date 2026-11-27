import { ApplicationFailure } from '@temporalio/activity';
import { confirmEntry, confirmationBranch, confirmationDiffRefusal, type EntryChange } from '../lib/fix-log-confirm.js';
import { checkEntry, entryPath, findingFacts } from '../lib/fix-log-rules.js';
import { parsePrUrl } from '../lib/findings.js';
import { branchSha, commitFiles, defaultBranch, fastForwardBranch, readRepoFile, resetBranch } from '../lib/github-contents.js';
import { gh, ghResponse } from '../lib/github.js';
import { log } from '../lib/logger.js';
import {
  checkPullIdentity,
  checksRefusal,
  evaluateScorecardChecks,
  type CheckRunLike,
  type ScorecardChecksResult,
  type ScorecardMergeOutcome,
} from '../lib/scorecard-merge.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { readFinding } from './findings.js';

/**
 * The fix log confirmation (STW-712, slice 4 of the fix log writer): three
 * activities on `steward-findings`, run on the hosted worker after a fix's verify
 * answers, and called in-process by `steward fix-log confirm <key>`.
 *
 * `openFixLogConfirmation` completes the entry on `master` from the finding after
 * the verify (`lib/fix-log-confirm.ts`), commits it on `master`'s head to its own
 * branch, and opens the pull request. It does nothing, and says why, when the
 * entry is not on `master`, the finding holds no verification, or the entry is
 * already confirmed by this verification. A retry finds the open or merged pull
 * request of its branch and returns it.
 *
 * `readFixLogConfirmationChecks` reads the check runs on the exact commit, by the
 * Scorecard merge leg's rule (`evaluateScorecardChecks`).
 *
 * `mergeFixLogConfirmation` merges as `mergeScorecardPr` does, deciding from
 * GitHub at merge time: the pull request is the one this step opened, its head
 * has not moved, its diff is the one entry file, the file differs from `master`
 * in the confirmed fields only, and the checks pass. Any miss is a returned
 * refusal and the pull request stays open for a person. Idempotent: a pull
 * request already merged from the expected head reads as merged.
 */

export interface FixLogConfirmInput {
  /** `owner/name` of the findings repository. */
  repo: string;
  findingPath: string;
  /** The finding's key, for the log line. */
  key: string;
  /** The fix pull request production just verified. */
  prUrl: string;
}

export type OpenFixLogConfirmationResult =
  | { state: 'skipped'; reason: string }
  | { state: 'opened'; key: string; path: string; repo: string; prNumber: number; prUrl: string; branch: string; headSha: string; reused: boolean }
  | { state: 'merged'; key: string; path: string; repo: string; prNumber: number; prUrl: string; mergeSha: string };

/** The rules an entry Steward rewrites must pass. The prose rules are the writer's; this step writes facts. */
const STRUCTURE_RULES = new Set(['frontmatter', 'schema', 'forbidden']);

interface PullDetails {
  number: number;
  url: string;
  state: string;
  merged: boolean;
  mergeSha: string | null;
  headSha: string;
}

async function pullDetails(repo: string, number: number): Promise<PullDetails> {
  const pull = await gh(`/repos/${repo}/pulls/${number}`);
  return {
    number,
    url: String(pull.html_url ?? `https://github.com/${repo}/pull/${number}`),
    state: String(pull.state ?? ''),
    merged: pull.merged === true,
    mergeSha: (pull.merge_commit_sha as string | null) ?? null,
    headSha: String(pull.head?.sha ?? ''),
  };
}

/** The newest pull request from `branch`, open or not. */
async function branchPull(repo: string, branch: string): Promise<PullDetails | undefined> {
  const owner = repo.split('/')[0];
  const listed = await gh(`/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`);
  const numbers = (Array.isArray(listed) ? listed : []).map((p: { number: number }) => Number(p.number)).filter(Boolean);
  if (numbers.length === 0) return undefined;
  return pullDetails(repo, Math.max(...numbers));
}

function prBody(key: string, path: string, verified: number): string {
  return [
    `Steward confirms the fix log entry for ${key} after production verified the fix in #${verified}.`,
    '',
    `It changes \`${path}\` only, and only its confirmed facts: \`status\`, \`confirmedBy\`, \`verified\`, \`checks\` and the merge times in \`changes\`. The writing is as it was.`,
    '',
    'Steward merges this pull request when its checks pass. It leaves it open when the diff holds anything else.',
  ].join('\n');
}

/** `openFixLogConfirmation`, the activity. */
export async function openFixLogConfirmation(input: FixLogConfirmInput): Promise<OpenFixLogConfirmationResult> {
  const finding = await readFinding(input.repo, input.findingPath);
  const facts = findingFacts(finding.text);
  if (!facts) return { state: 'skipped', reason: 'the finding has no fix pull request' };
  const pr = parsePrUrl(input.prUrl);
  if (!pr) throw ApplicationFailure.nonRetryable(`${input.prUrl} is not a pull request URL.`, 'FindingMalformed');
  if (!facts.verified) return { state: 'skipped', reason: 'the finding holds no verification on production' };
  const path = entryPath(facts.key);
  const branch = confirmationBranch(facts.key, pr.number, facts.verified);
  const base = await defaultBranch(pr.repo);

  // A retry of this step finds its own pull request.
  const existing = await branchPull(pr.repo, branch);
  if (existing?.merged && existing.mergeSha) {
    return { state: 'merged', key: facts.key, path, repo: pr.repo, prNumber: existing.number, prUrl: existing.url, mergeSha: existing.mergeSha };
  }
  if (existing && existing.state === 'open') {
    return { state: 'opened', key: facts.key, path, repo: pr.repo, prNumber: existing.number, prUrl: existing.url, branch, headSha: existing.headSha, reused: true };
  }

  const entry = await readRepoFile(path, base, pr.repo);
  if (!entry) return { state: 'skipped', reason: `${path} is not on ${base}` };

  const fix = await gh(`/repos/${pr.repo}/pulls/${pr.number}`);
  if (fix.merged !== true) return { state: 'skipped', reason: `PR ${pr.number} is not merged` };
  const change: EntryChange = { number: pr.number, title: String(fix.title ?? ''), opened: String(fix.created_at ?? ''), merged: String(fix.merged_at) };

  // The merge time of each other listed pull request that lacks one.
  const listed: Array<Record<string, unknown>> = (parseFrontmatter(entry.text).data as Record<string, any>).changes ?? [];
  const mergedTimes = new Map<number, string | null>();
  for (const c of Array.isArray(listed) ? listed : []) {
    const n = Number(c?.number);
    if (!n || n === pr.number || c?.merged) continue;
    const other = await gh(`/repos/${pr.repo}/pulls/${n}`);
    mergedTimes.set(n, other.merged === true ? String(other.merged_at) : null);
  }

  const confirmed = confirmEntry(entry.text, { facts, pr: change, mergedAt: (n) => mergedTimes.get(n) });
  if (confirmed.state !== 'confirmed') return { state: 'skipped', reason: confirmed.reason };
  if (confirmed.text === entry.text.replace(/\r\n/g, '\n')) {
    return { state: 'skipped', reason: `${path} on ${base} already holds these facts` };
  }
  const broken = checkEntry(confirmed.text, { titles: [], slugs: [] }).filter((f) => STRUCTURE_RULES.has(f.rule));
  if (broken.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `The confirmed entry for ${facts.key} fails the entry rules: ${broken.map((f) => f.reason).join('; ')}.`,
      'FixLogEntryInvalid',
    );
  }

  // The branch is cut from master's head every time, so a stale branch of a closed pull request is replaced.
  const parent = await branchSha(base, pr.repo);
  const sha = await commitFiles({ repo: pr.repo, parent, message: `Fix log: confirm the entry for ${facts.key}`, files: [{ path, text: confirmed.text }] });
  await resetBranch(branch, parent, pr.repo);
  if (!(await fastForwardBranch(branch, sha, pr.repo))) {
    throw new Error(`${branch} moved while the confirmation was committed.`);
  }
  const opened = await gh(`/repos/${pr.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: `Fix log: confirm ${facts.key}`, head: branch, base, body: prBody(facts.key, path, pr.number) }),
  });
  const number = Number(opened.number);
  const url = String(opened.html_url);
  log.info({ activity: 'openFixLogConfirmation', key: facts.key, pr: url, sha }, 'fix log confirmation opened');
  return { state: 'opened', key: facts.key, path, repo: pr.repo, prNumber: number, prUrl: url, branch, headSha: sha, reused: false };
}

export interface FixLogConfirmationChecksInput {
  repo: string;
  headSha: string;
}

/** `readFixLogConfirmationChecks`, the activity: the check runs on one exact commit. Throws on a GitHub error. */
export async function readFixLogConfirmationChecks(input: FixLogConfirmationChecksInput): Promise<ScorecardChecksResult> {
  const runs = await gh(`/repos/${input.repo}/commits/${input.headSha}/check-runs?per_page=100`);
  const list: CheckRunLike[] = (runs?.check_runs ?? []).map((r: CheckRunLike) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
  return evaluateScorecardChecks(list);
}

export interface MergeFixLogConfirmationInput {
  repo: string;
  prNumber: number;
  branch: string;
  /** The commit `openFixLogConfirmation` made. GitHub refuses the merge if the head moved off it. */
  expectedHeadSha: string;
  /** The entry's path: the one file the diff may hold. */
  path: string;
}

/** Why the confirmation stayed open. The Scorecard leg's conditions, and a content change beyond the confirmed fields. */
export type FixLogMergeOutcome = ScorecardMergeOutcome | { merged: false; condition: 'beyond-confirmation'; detail: string };

/** `mergeFixLogConfirmation`, the activity. */
export async function mergeFixLogConfirmation(input: MergeFixLogConfirmationInput): Promise<FixLogMergeOutcome> {
  const repo = input.repo;
  const data = await gh(`/repos/${repo}/pulls/${input.prNumber}`);
  const pull = {
    state: String(data.state),
    merged: data.merged === true,
    draft: data.draft === true,
    mergeCommitSha: (data.merge_commit_sha as string | null) ?? null,
    headRef: String(data.head?.ref),
    headSha: String(data.head?.sha),
    headRepo: (data.head?.repo?.full_name as string | undefined) ?? null,
    baseRef: String(data.base?.ref),
  };
  if (pull.merged && pull.mergeCommitSha) {
    if (pull.headSha === input.expectedHeadSha && pull.headRef === input.branch) return { merged: true, mergeSha: pull.mergeCommitSha };
    return { merged: false, condition: 'head-moved', detail: `the pull request merged from ${pull.headSha}, not ${input.expectedHeadSha}` };
  }
  const base = await defaultBranch(repo);
  const identity = checkPullIdentity(pull, { branch: input.branch, expectedHeadSha: input.expectedHeadSha, defaultBranch: base, repo });
  if (identity) return identity;

  const files = await gh(`/repos/${repo}/pulls/${input.prNumber}/files?per_page=100`);
  const changed = (Array.isArray(files) ? files : []).map((f: { filename: string; status?: string }) => ({ filename: f.filename, status: f.status }));
  if (changed.length !== 1 || changed[0].filename !== input.path || changed[0].status !== 'modified') {
    const listed = changed.map((f) => `${f.filename} (${f.status ?? 'unknown'})`).join(', ') || 'empty';
    return { merged: false, condition: 'extra-files', detail: `the diff is ${listed}, expected ${input.path} modified` };
  }

  const [head, master] = await Promise.all([readRepoFile(input.path, input.branch, repo), readRepoFile(input.path, base, repo)]);
  if (!head || !master) return { merged: false, condition: 'beyond-confirmation', detail: `${input.path} is missing from ${head ? base : input.branch}` };
  const beyond = confirmationDiffRefusal(master.text, head.text);
  if (beyond) return { merged: false, condition: 'beyond-confirmation', detail: beyond };

  const unready = checksRefusal(await readFixLogConfirmationChecks({ repo, headSha: input.expectedHeadSha }));
  if (unready) return unready;

  const res = await ghResponse(`/repos/${repo}/pulls/${input.prNumber}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'merge', sha: input.expectedHeadSha }),
  });
  if (res.ok) {
    log.info({ activity: 'mergeFixLogConfirmation', pr: input.prNumber, mergeSha: res.body.sha }, 'fix log confirmation merged');
    return { merged: true, mergeSha: String(res.body.sha) };
  }
  const message = String(res.body?.message ?? `HTTP ${res.status}`);
  if (res.status === 409 && /head branch was modified/i.test(message)) return { merged: false, condition: 'head-moved', detail: message };
  return { merged: false, condition: 'github-refused', detail: `GitHub ${res.status}: ${message}` };
}

export interface ConfirmNowOptions {
  /** The poll interval and the bound, as the workflow keeps them. Tests shorten them. */
  pollMs?: number;
  boundMs?: number;
  print?: (line: string) => void;
}

/**
 * The whole confirmation in-process, for `steward fix-log confirm <key>`: an entry
 * whose run was past its verify when the workflow step shipped. The same three
 * activities and the same rules as `confirmFixLogEntry` in `findingWorkflow`:
 * checks passing on two reads in a row, one poll a minute, no poll after 30
 * minutes. Returns the line the workflow would hold in `fixLogConfirm`.
 */
export async function confirmFixLogEntryNow(input: FixLogConfirmInput, options: ConfirmNowOptions = {}): Promise<string> {
  const pollMs = options.pollMs ?? 60_000;
  const deadline = Date.now() + (options.boundMs ?? 30 * 60_000);
  const print = options.print ?? (() => undefined);
  const opened = await openFixLogConfirmation(input);
  if (opened.state === 'skipped') return `skipped: ${opened.reason}`;
  if (opened.state === 'merged') return `${opened.path} confirmed in ${opened.prUrl}, merged as ${opened.mergeSha.slice(0, 7)}`;
  print(`${opened.reused ? 'Found' : 'Opened'} ${opened.prUrl}; waiting for its checks.`);
  let passing = 0;
  for (;;) {
    const checks = await readFixLogConfirmationChecks({ repo: opened.repo, headSha: opened.headSha });
    if (checks.state === 'failing') return `left open: ${opened.prUrl}: checks failed: ${checks.failing.join(', ')}`;
    passing = checks.state === 'passing' ? passing + 1 : 0;
    if (passing >= 2) break;
    if (Date.now() + pollMs > deadline) return `left open: ${opened.prUrl}: the checks did not pass twice in a row in time`;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const merged = await mergeFixLogConfirmation({
    repo: opened.repo,
    prNumber: opened.prNumber,
    branch: opened.branch,
    expectedHeadSha: opened.headSha,
    path: opened.path,
  });
  if (!merged.merged) return `left open: ${opened.prUrl}: ${merged.condition}: ${merged.detail}`;
  return `${opened.path} confirmed in ${opened.prUrl}, merged as ${merged.mergeSha.slice(0, 7)}`;
}

/** The finding file whose `key_short` is `key`, and its fix pull request, from the site's findings index. */
export async function findFindingByShortKey(
  repo: string,
  site: string,
  key: string,
): Promise<{ findingPath: string; prUrl: string } | undefined> {
  const { readFindingsIndex } = await import('./findings.js');
  const { findingPath } = await import('../lib/findings.js');
  for (const line of await readFindingsIndex(repo, site)) {
    if (['proposed', 'rejected', 'approved'].includes(line.status)) continue;
    const path = findingPath(site, line.key);
    const file = await readRepoFile(path, 'main', repo);
    if (!file) continue;
    const data = parseFrontmatter(file.text).data as Record<string, any>;
    if (String(data.key_short ?? '').toUpperCase() !== key.toUpperCase()) continue;
    const prUrl = data.links?.pr;
    return typeof prUrl === 'string' ? { findingPath: path, prUrl } : undefined;
  }
  return undefined;
}
