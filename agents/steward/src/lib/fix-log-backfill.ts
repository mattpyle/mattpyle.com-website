import { ApplicationFailure } from '@temporalio/activity';
import {
  draftFixLogEntry,
  type DraftFixLogEntryResult,
  type DraftUsage,
  type ReviewProblem,
  type TokenUsage,
} from './fix-log-draft.js';
import { findingPath, findingsIndexPath, parseFindingsIndex } from './findings.js';
import { ENTRIES_PATH, entryFile, entryPath, findingFacts } from './fix-log-rules.js';
import { parseFrontmatter } from './frontmatter.js';
import type { FixLogSend } from './llm.js';

/**
 * `steward fix-log backfill`: the fix log entries for every merged fix that has none,
 * drafted with `draftFixLogEntry`, committed one file at a time to one branch, and one
 * pull request against `master`. It never merges.
 *
 * A COMMAND, NOT A WORKFLOW. About 22 model calls, run once by a person who reads the
 * output. A second run is the retry: it skips every entry already on the branch and
 * reads titles and slugs from the branch, so it repeats nothing and clashes with
 * nothing it wrote before.
 *
 * THE SET. The launch set of `scripts/fix-log-entries.mjs`: a finding that is `resolved`
 * or `reopened` and has a merged fix pull request. A merged fix whose finding is not yet
 * decided is listed and skipped; the step in `findingWorkflow` covers it later. The facts
 * are as they are after the merge, so a confirmed fix carries `verified` and its checks.
 *
 * THE REVIEW. Each draft is reviewed by a second model pass (`fix-log-draft.ts`). A
 * draft the reviewer still objects to is committed with its notes, and the pull request
 * body lists them per entry, so a person reads only those.
 *
 * A CREDENTIAL FAILURE STOPS THE RUN. A missing model key or a 401 fails every entry the
 * same way, so the run stops at the first, says so, and lists the entries not tried.
 *
 * Every GitHub call goes through {@link BackfillGitHub}, so the tests run it in memory.
 */

export const BACKFILL_BRANCH = 'steward/fix-log-backfill';
export const BRIEF_PATH = 'agents/steward/briefs/fix-log.md';
const BASE = 'master';
const FINDINGS_BRANCH = 'main';

export interface PullRequestFacts {
  number: number;
  title: string;
  body: string;
  opened: string;
  merged: string | null;
}

/** The GitHub reads and writes the backfill makes. The CLI passes the real ones. */
export interface BackfillGitHub {
  readFile(repo: string, path: string, ref: string): Promise<string | undefined>;
  listDir(repo: string, dir: string, ref: string): Promise<string[] | undefined>;
  branchSha(repo: string, branch: string): Promise<string | undefined>;
  ensureBranch(repo: string, branch: string, fromSha: string): Promise<void>;
  writeFile(repo: string, input: { path: string; text: string; message: string; branch: string }): Promise<string>;
  pullRequest(repo: string, number: number): Promise<PullRequestFacts>;
  pullRequestDiff(repo: string, number: number): Promise<string>;
  openOrUpdatePr(repo: string, input: { branch: string; base: string; title: string; body: string }): Promise<string>;
}

export interface BackfillOptions {
  /** The site repository: `mattpyle/mattpyle.com-website`. */
  siteRepo: string;
  /** The findings store: `mattpyle/argus`. */
  findingsRepo: string;
  /** The findings store's site folder: `mattpyle-com`. */
  site: string;
  dryRun: boolean;
  only?: ReadonlySet<string>;
}

export interface BackfillDeps {
  github: BackfillGitHub;
  /** The model, or undefined for a dry run. */
  send?: FixLogSend;
  /** The reviewer's model. Defaults to `send`. */
  review?: FixLogSend;
  print: (line: string) => void;
}

export interface BackfillDrafted {
  key: string;
  slug: string;
  attempts: number;
  reviewRounds: number;
  reviewNotes: ReviewProblem[];
  usage: DraftUsage;
  commit?: string;
}

export interface BackfillReport {
  /** Keys that would be drafted (a dry run) or were attempted. */
  wanted: string[];
  drafted: BackfillDrafted[];
  failed: Array<{ key: string; reason: string; usage?: DraftUsage }>;
  /** Merged fixes whose finding is not yet `resolved` or `reopened`. */
  undecided: string[];
  /** Fixes that already have an entry on `master` or the branch. */
  existing: string[];
  prUrl?: string;
  /** The writer's and the reviewer's tokens, counted apart. */
  usage: DraftUsage;
  correctionTurns: number;
  /** Why the run stopped early: a credential failure. */
  stopped?: string;
  /** The keys a stopped run did not try. */
  notTried: string[];
}

const LAUNCH_SET = ['resolved', 'reopened'];

interface Candidate {
  key: string;
  text: string;
  pr: PullRequestFacts;
  confirmed: boolean;
}

/** The titles and slugs of every entry on `master` and on the branch, and the file names on each. */
export async function readEntries(github: BackfillGitHub, repo: string, refs: string[]) {
  const titles: string[] = [];
  const slugs: string[] = [];
  const files = new Map<string, Set<string>>();
  const read = new Set<string>();
  for (const ref of refs) {
    const names = (await github.listDir(repo, ENTRIES_PATH, ref)) ?? [];
    files.set(ref, new Set(names));
    for (const name of names.filter((n) => n.endsWith('.md'))) {
      if (read.has(name)) continue;
      const text = await github.readFile(repo, `${ENTRIES_PATH}/${name}`, ref);
      if (!text) continue;
      read.add(name);
      const data = parseFrontmatter(text.replace(/\r\n/g, '\n')).data as Record<string, unknown>;
      if (typeof data.title === 'string' && data.title) titles.push(data.title);
      if (typeof data.slug === 'string' && data.slug) slugs.push(data.slug);
    }
  }
  return { titles, slugs, files };
}

/** Statuses no fix pull request can have reached: the backfill reads no file for them. */
const BEFORE_A_FIX = ['proposed', 'rejected', 'approved'];

/** The index's findings that may have a fix pull request. */
async function findingKeys(github: BackfillGitHub, repo: string, site: string): Promise<string[]> {
  const index = await github.readFile(repo, findingsIndexPath(site), FINDINGS_BRANCH);
  if (!index) throw new Error(`${findingsIndexPath(site)} is not in ${repo}.`);
  return parseFindingsIndex(index).filter((line) => !BEFORE_A_FIX.includes(line.status)).map((line) => line.key);
}

const tokens = (u: TokenUsage): string => `${u.inputTokens} in, ${u.outputTokens} out`;
const splitTokens = (u: DraftUsage): string => `writer ${tokens(u.writer)}; reviewer ${tokens(u.reviewer)}`;

function addUsage(into: DraftUsage, u: DraftUsage): void {
  for (const side of ['writer', 'reviewer'] as const) {
    into[side].inputTokens += u[side].inputTokens;
    into[side].outputTokens += u[side].outputTokens;
  }
}

/** A failure no other entry would escape: no model key, or a key the model refused as unauthorised. */
export function isCredentialFailure(err: unknown): boolean {
  if (!(err instanceof ApplicationFailure)) return false;
  if (err.type === 'ModelKeyMissing') return true;
  return err.type === 'ModelRequestRefused' && (err.details?.[0] as { status?: number } | undefined)?.status === 401;
}

/** Note text on one line, with its backslashes escaped first and then its pipes, so markdown shows it as written. */
export const noteText = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** The reviewer's objections a person reads before merging, per entry. */
function reviewNotesSection(drafted: BackfillDrafted[]): string[] {
  const noted = drafted.filter((d) => d.reviewNotes.length > 0);
  if (noted.length === 0) return [];
  const lines = ['## Review notes', '', 'The reviewer still objected to these after its last round. Read and mend each before merging.', ''];
  for (const d of noted) {
    lines.push(`### \`${entryFile(d.key)}\``, '');
    for (const n of d.reviewNotes) lines.push(`1. "${noteText(n.quote)}" (${noteText(n.rule)}): ${noteText(n.reason)}`);
    lines.push('');
  }
  return lines;
}

function prBody(report: BackfillReport): string {
  return [
    'The fix log entries for merged fixes that had none, drafted by Steward from each finding and its fix pull request, under `agents/steward/briefs/fix-log.md`.',
    '',
    '| Entry | Writer turns | Reviews | Review notes | Writer tokens | Reviewer tokens |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.drafted.map(
      (d) => `| \`${entryFile(d.key)}\` | ${d.attempts} | ${d.reviewRounds} | ${d.reviewNotes.length} | ${tokens(d.usage.writer)} | ${tokens(d.usage.reviewer)} |`,
    ),
    '',
    ...reviewNotesSection(report.drafted),
    ...(report.undecided.length ? [`Not drafted, the finding not yet resolved: ${report.undecided.join(', ')}.`, ''] : []),
    ...(report.failed.length ? [`Not drafted, the draft failed: ${report.failed.map((f) => f.key).join(', ')}.`, ''] : []),
    ...(report.stopped ? [`The run stopped early: ${report.stopped}`, ''] : []),
    ...(report.notTried.length ? [`Not tried: ${report.notTried.join(', ')}.`, ''] : []),
    'Read each entry before merging. A correction belongs in the brief as well as the entry.',
  ].join('\n');
}

export async function runFixLogBackfill(options: BackfillOptions, deps: BackfillDeps): Promise<BackfillReport> {
  const { github, print } = deps;
  if (!options.dryRun && !deps.send) throw new Error('A backfill that writes needs the model; pass --dry-run to only list.');

  const report: BackfillReport = {
    wanted: [],
    drafted: [],
    failed: [],
    undecided: [],
    existing: [],
    usage: { writer: { inputTokens: 0, outputTokens: 0 }, reviewer: { inputTokens: 0, outputTokens: 0 } },
    correctionTurns: 0,
    notTried: [],
  };

  // The brief from master only, never from a pull request's head.
  const brief = await github.readFile(options.siteRepo, BRIEF_PATH, BASE);
  if (!brief) throw new Error(`${BRIEF_PATH} is not on ${BASE} in ${options.siteRepo}.`);

  const branchHead = await github.branchSha(options.siteRepo, BACKFILL_BRANCH);
  const refs = branchHead ? [BACKFILL_BRANCH, BASE] : [BASE];
  const entries = await readEntries(github, options.siteRepo, refs);
  const hasEntry = (key: string): boolean => [...entries.files.values()].some((names) => names.has(entryFile(key)));

  // The launch set: resolved or reopened, with a merged fix pull request.
  const candidates: Candidate[] = [];
  for (const slug of await findingKeys(github, options.findingsRepo, options.site)) {
    const text = await github.readFile(options.findingsRepo, findingPath(options.site, slug), FINDINGS_BRANCH);
    if (!text) continue;
    const facts = findingFacts(text);
    if (!facts) continue;
    if (options.only && !options.only.has(facts.key)) continue;
    if (hasEntry(facts.key)) {
      report.existing.push(facts.key);
      continue;
    }
    const pr = await github.pullRequest(options.siteRepo, facts.pr);
    if (!pr.merged) continue;
    if (!LAUNCH_SET.includes(facts.findingStatus)) {
      report.undecided.push(facts.key);
      continue;
    }
    candidates.push({ key: facts.key, text, pr, confirmed: facts.verified !== null });
  }
  const byNumber = (k: string): number => Number(k.slice(3));
  candidates.sort((a, b) => byNumber(a.key) - byNumber(b.key));
  report.undecided.sort((a, b) => byNumber(a) - byNumber(b));
  report.wanted = candidates.map((c) => c.key);

  print(`${candidates.length} merged fix${candidates.length === 1 ? '' : 'es'} with no entry; ${report.existing.length} already have one.`);
  if (report.undecided.length) print(`Skipped, the finding not yet resolved or reopened: ${report.undecided.join(', ')}.`);

  if (options.dryRun) {
    for (const c of candidates) {
      print(`  would draft ${entryPath(c.key)} from PR #${c.pr.number} "${c.pr.title}"${c.confirmed ? ', confirmed on production' : ', not yet confirmed'}`);
    }
    print('Dry run: nothing written, no pull request opened.');
    return report;
  }
  if (candidates.length === 0) return report;

  if (!branchHead) {
    const base = await github.branchSha(options.siteRepo, BASE);
    if (!base) throw new Error(`${options.siteRepo} has no ${BASE} branch.`);
    await github.ensureBranch(options.siteRepo, BACKFILL_BRANCH, base);
  }

  const taken = { titles: [...entries.titles], slugs: [...entries.slugs] };
  for (const [i, c] of candidates.entries()) {
    let draft: DraftFixLogEntryResult;
    try {
      const diff = await github.pullRequestDiff(options.siteRepo, c.pr.number);
      draft = await draftFixLogEntry(
        { finding: { key: c.key, text: c.text }, pr: { ...c.pr, diff }, brief, taken },
        { send: deps.send!, ...(deps.review ? { review: deps.review } : {}) },
      );
    } catch (err) {
      const details = err instanceof ApplicationFailure ? (err.details?.[0] as { usage?: DraftUsage; attempts?: number } | undefined) : undefined;
      if (details?.usage) {
        addUsage(report.usage, details.usage);
        report.correctionTurns += (details.attempts ?? 1) - 1;
      }
      const reason = err instanceof Error ? err.message : String(err);
      report.failed.push({ key: c.key, reason, ...(details?.usage ? { usage: details.usage } : {}) });
      print(`  ${c.key}: failed. ${reason}`);
      if (isCredentialFailure(err)) {
        report.stopped = `a credential failure on ${c.key}: ${reason}`;
        report.notTried = candidates.slice(i + 1).map((n) => n.key);
        print(`Stopped: a credential failure. Not tried: ${report.notTried.join(', ') || 'none'}.`);
        break;
      }
      continue;
    }
    // A second writer may have put the file there since the listing: never overwrite.
    if (await github.readFile(options.siteRepo, draft.path, BACKFILL_BRANCH)) {
      report.existing.push(c.key);
      print(`  ${c.key}: already on ${BACKFILL_BRANCH}; skipped.`);
      continue;
    }
    const commit = await github.writeFile(options.siteRepo, {
      path: draft.path,
      text: draft.text,
      message: `Fix log: add the entry for ${c.key}`,
      branch: BACKFILL_BRANCH,
    });
    taken.titles.push(draft.title);
    taken.slugs.push(draft.slug);
    report.drafted.push({
      key: c.key,
      slug: draft.slug,
      attempts: draft.attempts,
      reviewRounds: draft.reviewRounds,
      reviewNotes: draft.reviewNotes,
      usage: draft.usage,
      commit,
    });
    addUsage(report.usage, draft.usage);
    report.correctionTurns += draft.attempts - 1;
    const notes = draft.reviewNotes.length ? `, ${draft.reviewNotes.length} review note${draft.reviewNotes.length === 1 ? '' : 's'}` : '';
    print(
      `  ${c.key}: ${draft.path}, ${draft.attempts} writer turn${draft.attempts === 1 ? '' : 's'}, ${draft.reviewRounds} review${draft.reviewRounds === 1 ? '' : 's'}${notes}, ${splitTokens(draft.usage)} tokens.`,
    );
  }

  print(`Tokens in total: ${splitTokens(report.usage)}. Correction turns: ${report.correctionTurns}.`);
  if (report.drafted.length > 0 || branchHead) {
    report.prUrl = await github.openOrUpdatePr(options.siteRepo, {
      branch: BACKFILL_BRANCH,
      base: BASE,
      title: 'Fix log: entries for the merged fixes that had none',
      body: prBody(report),
    });
    print(`Pull request: ${report.prUrl}`);
  }
  return report;
}
