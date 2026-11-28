import { ApplicationFailure, Context } from '@temporalio/activity';
import {
  GITHUB_REPO,
  SCORECARD_ARCHIVE_BRANCH,
  SCORECARD_ARCHIVE_REL,
  SCORECARD_RUNS_PATH,
} from '../config.js';
import { gh, ghResponse } from '../lib/github.js';
import {
  checkChangedFiles,
  checkPullIdentity,
  checksRefusal,
  evaluateScorecardChecks,
  pullNumberFromUrl,
  type CheckRunLike,
  type ScorecardChecksResult,
  type ScorecardMergeOutcome,
} from '../lib/scorecard-merge.js';
import {
  branchSha,
  commitFiles,
  defaultBranch,
  ensureBranch,
  fastForwardBranch,
  openOrUpdatePr,
  readRepoFile,
  resetBranch,
  writeRepoFile,
} from '../lib/github-contents.js';
import { AUDIT_USER_AGENT } from '../lib/agent-audit/safe-fetch.js';
import { measureReadingBudget, type ReadingBudget } from '../lib/agent-audit/reading-budget.js';
import { auditUrl } from '../lib/audit-engine.js';
import type { AuditRunners } from '../lib/audit-engine.js';
import { log } from '../lib/logger.js';
import { agenticCheckLabel, parsePageCount, validateCommentary } from '../lib/scorecard-aggregate.js';
import type { PageAuditOutcome, PageCheckResult, PublishableRun, ScorecardMetric, ScorecardRunRecord } from '../lib/scorecard-aggregate.js';

/**
 * The Scorecard system's activities (scorecard-audit-spec.md §4.3). A sibling
 * of Steward's own activities, not a variant of them — see the spec §2
 * table for why `auditLiveUrl` must never be confused with
 * `buildAndAuditDraft`, even though both call the same `audit-engine.ts`.
 *
 * ## None of these touch the local filesystem any more (2026-08-14)
 *
 * Every activity in this file used to be a *local* activity: the run-log was
 * read out of `SITE_DIR`, the publish leg drove git in `WORKTREE_DIR`, and the
 * archive was a `writeFile` under the local reviews directory. That is what pinned
 * the whole scorecard run to Matt's PC, and therefore what kept the daily
 * Schedule desk-bound no matter where the Schedule itself lived
 * (always-on-audit-worker card, leg 2b).
 *
 * They now read and write the repository through the GitHub API
 * (`lib/github-contents.ts`), so the entire workflow runs on `steward-audit`
 * and finishes end to end on the hosted worker with the PC off. What the
 * activities *mean* is unchanged: same run-log entry, same PR, same archive
 * record. Which pull requests Steward merges is the merge leg's business
 * (`mergeScorecardPr`, below).
 *
 * The cost is that this file now needs the GitHub App credential for reads as well as
 * writes, where before only the publish leg did. A run whose credential is missing
 * fails at step 0.5 rather than twelve minutes in at the publish step, which is
 * the better of the two.
 */

// ---------------------------------------------------------------------------
// resolveAuditUrls — light queue
// ---------------------------------------------------------------------------

/** Pulls every `<loc>` out of a sitemap XML document. */
function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/** A sitemap that is not there is permanent; every other refusal may pass. */
function sitemapFailure(message: string, status: number): Error {
  return status === 404 ? ApplicationFailure.nonRetryable(message, 'SitemapNotFound') : new Error(message);
}

/**
 * Fetches the live sitemap index and every sitemap it references, returning
 * the full set of indexed HTML URLs (spec §5.4). **Not a hardcoded list** —
 * `@astrojs/sitemap` already excludes drafts, numeric changelog pagination
 * pages, and `.md` variants at build time (astro.config.mjs's `filter`), so
 * whatever this returns is exactly "what's live" by the site's own rules.
 *
 * A 404 and an index that names no sitemap are non-retryable: the workflow
 * retries this read for hours, and neither mends by waiting. Any other answer,
 * and a network failure, stays retryable.
 */
export async function resolveAuditUrls(sitemapUrl: string): Promise<string[]> {
  const idxRes = await fetch(sitemapUrl);
  if (!idxRes.ok) {
    throw sitemapFailure(`sitemap index fetch failed: ${sitemapUrl} -> ${idxRes.status}`, idxRes.status);
  }
  const idx = await idxRes.text();
  const subSitemaps = extractLocs(idx);
  if (subSitemaps.length === 0) {
    throw ApplicationFailure.nonRetryable(`sitemap index ${sitemapUrl} referenced no sitemaps`, 'SitemapEmpty');
  }

  const urls = new Set<string>();
  for (const loc of subSitemaps) {
    const res = await fetch(loc);
    if (!res.ok) throw sitemapFailure(`sitemap fetch failed: ${loc} -> ${res.status}`, res.status);
    for (const url of extractLocs(await res.text())) urls.add(url);
  }

  // The list itself is logged, not just its count: the audited set and the
  // sitemap are identical by construction, so the only way to diff a suspect
  // run after the fact is to have written down what it actually audited.
  const list = [...urls].sort();
  log.info(
    { activity: 'resolveAuditUrls', sitemapUrl, count: list.length, urls: list },
    'resolved live audit URL set',
  );
  return list;
}

// ---------------------------------------------------------------------------
// resolveRunStamp — light queue
// ---------------------------------------------------------------------------

export interface RunStamp {
  /** `YYYY-MM-DD` in the given IANA timezone — the run's calendar date (spec §5.1). */
  iso: string;
  /** Full ISO 8601 instant, carrying that timezone's actual offset (never `Z`). */
  timestamp: string;
}

/**
 * Resolves "what day is it" in a given IANA timezone (spec §5.1's timezone
 * amendment). Runs as an **activity**, not inline in the workflow, so the
 * result is captured in workflow history and replay-safe — the workflow
 * sandbox's patched `Date` gives a replay-safe *instant*, but converting that
 * instant to a calendar day in a named timezone depends on the host's ICU
 * timezone database, which the spec's determinism rules don't guarantee is
 * available or consistent inside the sandbox.
 *
 * DST is handled for free: the tz database (not a fixed UTC offset) decides
 * both the calendar day and the offset written into `timestamp`.
 */
export async function resolveRunStamp(timeZone: string): Promise<RunStamp> {
  const now = new Date();
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `"${timeZone}" is not a time zone: ${err instanceof Error ? err.message : String(err)}`,
      'BadTimeZone',
    );
  }
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(now)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  // The classic offset trick: reinterpret the timezone's local wall-clock
  // digits as if they were UTC, then diff against the real UTC instant.
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  const offsetMinutes = Math.round((asUTC - now.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offsetH = String(Math.floor(abs / 60)).padStart(2, '0');
  const offsetM = String(abs % 60).padStart(2, '0');

  return {
    iso: `${map.year}-${map.month}-${map.day}`,
    timestamp: `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}${sign}${offsetH}:${offsetM}`,
  };
}

// ---------------------------------------------------------------------------
// auditLiveUrl — heavy queue
// ---------------------------------------------------------------------------

/**
 * Audits one live URL with the shared engine (`audit-engine.ts`'s `auditUrl`)
 * and returns a `PageAuditOutcome`. Always **resolves**, never throws for a
 * page-level failure that Temporal's retry policy should own instead — this
 * mirrors `reviewPost`'s `guard` pattern (design rule 4): after the activity's
 * own retries are exhausted, it is the *workflow's* `guard` that converts a
 * thrown `ActivityFailure` into the `ok: false` marker, not this function.
 *
 * Heartbeats every 5s during the audit — the same discipline
 * `buildAndAuditDraft` uses, for the same reason: Chrome + Lighthouse + axe
 * against one URL is easily tens of seconds, comfortably past the default
 * heartbeat timeout if left silent.
 *
 * Sends `AUDIT_USER_AGENT`, the same `steward-audit` identity Steward carries
 * when it audits anybody else's site. These are 25 loads of mattpyle.com a
 * night, and unlabelled they arrive as Chrome: `/activity` counts a page load
 * only under a family `CLIENT_FAMILIES` names, so the site's own auditor was
 * the one reader the page that names its readers never listed.
 *
 * `opts.runners` is `auditUrl`'s test seam, passed straight through; the
 * workflow calls this with the URL alone.
 */
export async function auditLiveUrl(
  url: string,
  opts: { runners?: AuditRunners; fetch?: typeof fetch } = {},
): Promise<PageAuditOutcome> {
  const ctx = Context.current();
  const signal = ctx.cancellationSignal;
  const pump = setInterval(() => ctx.heartbeat(`auditing ${url}`), 5_000);
  try {
    ctx.heartbeat(`auditing ${url}`);
    const raw = await auditUrl(url, signal, { userAgent: AUDIT_USER_AGENT, runners: opts.runners });
    const readingBudget = await measureLiveReadingBudget(url, signal, opts.fetch ?? fetch);
    return {
      url,
      ok: true,
      scores: raw.scores,
      agenticChecks: raw.agenticChecks,
      axeViolations: raw.axeViolations.length,
      ...(raw.lhr.lighthouseVersion ? { lighthouseVersion: raw.lhr.lighthouseVersion } : {}),
      ...(readingBudget ? { readingBudget } : {}),
    };
  } finally {
    clearInterval(pump);
  }
}

/**
 * The page's reading budget (`lib/agent-audit/reading-budget.ts`): two plain
 * fetches, the page as HTML and the page as markdown, under the same
 * `steward-audit` identity the browser tools carry, measured with the code the
 * agent audit's `reading-budget-*` checks use.
 *
 * Two fetches beside a Lighthouse run cost nothing worth noting, and a failure
 * here is not a failure of the page's audit: the figure is optional on the
 * outcome, so the page keeps its four gates and loses this one number, logged.
 * A markdown request answered with HTML, or anything but 200, measures as no
 * twin; the site's own negotiation is the agent audit's business, not this one's.
 */
async function measureLiveReadingBudget(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ReadingBudget | undefined> {
  const get = async (accept: string) => {
    const res = await fetchImpl(url, {
      signal,
      headers: { accept, 'user-agent': AUDIT_USER_AGENT },
      redirect: 'follow',
    });
    return { ok: res.ok, type: (res.headers.get('content-type') ?? '').toLowerCase(), body: await res.text() };
  };
  try {
    const html = await get('text/html');
    if (!html.ok) {
      log.warn({ activity: 'auditLiveUrl', url, status: 'not ok' }, 'reading budget not measured: the page did not answer 200');
      return undefined;
    }
    const md = await get('text/markdown');
    const twin = md.ok && !md.type.includes('text/html') && !/^\s*(<!doctype html|<html[\s>])/i.test(md.body);
    return measureReadingBudget({ html: html.body, markdown: twin ? md.body : null }).budget;
  } catch (err) {
    log.warn({ activity: 'auditLiveUrl', url, err }, 'reading budget not measured: a fetch failed');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// readPublishedScorecard — light queue
// ---------------------------------------------------------------------------

export interface PublishedScorecard extends PublishableRun {
  /**
   * How many pages the published run audited, parsed from its `scope` string
   * — the audit-set guard's comparison baseline (spec §5.4). `undefined` when
   * the scope is missing or unparseable, which the guard treats as "nothing to
   * compare against" rather than guessing a number.
   */
  pageCount?: number;
}

/**
 * Reads the currently-published run-log **from the default branch on GitHub**,
 * before any publish work has started. `undefined` only if the file is missing
 * or empty, which should never happen once Phase 1 seeds it.
 *
 * This used to read `SITE_DIR`, and the change is a correction rather than a
 * compromise. The docblock always said what it wanted — "what's actually live
 * on `master`" — and a working copy is only ever a *proxy* for that: a checkout
 * Matt has not pulled reports a stale baseline, and one carrying local commits
 * reports a baseline that is not published at all. Either way the publish gate
 * (spec §6) and the audit-set guard (spec §5.4) compare this run against
 * something other than the run the site is actually serving. Asking the branch
 * removes the proxy.
 *
 * It is also what lets this activity run on `steward-audit`, which matters more
 * than it sounds: this is step 0.5, *before* the fan-out, so an activity that
 * needs the local machine here parks the run before it measures anything and there is
 * no such thing as a partially-hosted scorecard.
 */
export async function readPublishedScorecard(): Promise<PublishedScorecard | undefined> {
  const base = await defaultBranch();
  const file = await readRepoFile(SCORECARD_RUNS_PATH, base);
  if (!file) return undefined;
  let runs: ScorecardRunRecord[];
  try {
    runs = JSON.parse(file.text) as ScorecardRunRecord[];
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `${SCORECARD_RUNS_PATH} on ${base} does not parse: ${err instanceof Error ? err.message : String(err)}`,
      'ScorecardRunsMalformed',
    );
  }
  if (runs.length === 0) return undefined;
  // `scope` and `tools` come back too: they are half the publish gate (§6's
  // third trigger), not just display fields.
  return {
    iso: runs[0].iso,
    metrics: runs[0].metrics,
    scope: runs[0].scope,
    tools: runs[0].tools,
    pageCount: parsePageCount(runs[0].scope),
  };
}

// ---------------------------------------------------------------------------
// publishScorecardRun — light queue
// ---------------------------------------------------------------------------

export interface PerPageDetail {
  url: string;
  scores: Record<string, number>;
  axeViolations: number;
  /** The page's reading budget, when it was measured. See `PageAuditOutcome`. */
  readingBudget?: ReadingBudget;
  /** Performance samples, first audit first, on a page that was re-measured. Absent on every other page. */
  performanceSamples?: number[];
  /**
   * The Agentic Browsing checks that ran on this page, each with its score and
   * pass flag. Optional: a record or workflow history from before the field
   * existed has none, and a page that failed to audit has none either.
   */
  agenticChecks?: PageCheckResult[];
}

/** "5/6", or what is missing. Counts only the checks that ran on the page. */
function agenticCell(checks: PageCheckResult[] | undefined): string {
  if (!checks) return 'not recorded';
  if (checks.length === 0) return 'none ran';
  const passed = checks.filter((c) => c.passed).length;
  const failing = checks
    .filter((c) => !c.passed)
    .map((c) => `${agenticCheckLabel(c.id)} ${c.score === null ? 'no score' : c.score}`);
  return failing.length === 0 ? `${passed}/${checks.length}` : `${passed}/${checks.length} (not passing: ${failing.join(', ')})`;
}

/** One page's reading budget as the PR body prints it: "61% / 94%", or what is missing. */
function readingBudgetCell(budget: ReadingBudget | undefined): string {
  if (!budget) return 'not measured';
  return `${budget.text.share}% / ${budget.markdown ? `${budget.markdown.share}%` : 'no twin'}`;
}

export interface PublishScorecardRunInput {
  /** Everything but `id` — the final id (collision-checked against the real file) is resolved here, not by the workflow, which never reads the file directly. */
  record: Omit<ScorecardRunRecord, 'id'>;
  perPage: PerPageDetail[];
  /** Opens the PR as a draft and tags the title — same convention as `publishPost`'s dry-run. */
  dryRun?: boolean;
  /**
   * Set when the run's archive record rides in this pull request (STW-614): the
   * run-log entry and `<id>.json` under the archive directory go in one commit.
   * It carries what the archive record holds beyond the run record and the
   * per-page detail. Absent on a call from a history recorded before the change,
   * and the activity then commits the run-log alone, as it did.
   */
  archive?: { decision: 'open-pr' | 'no-op'; reason: string };
  /**
   * Set when the run is unhealthy and its pull request is held for a person
   * (STW-614). The body says so, and the workflow starts no merge leg.
   */
  held?: { failedPages: number; totalPages: number };
}

export interface PublishScorecardRunResult {
  branch: string;
  prUrl: string;
  id: string;
  /**
   * What the merge leg needs. Optional: a result recorded before the merge leg
   * existed carries none of them, and the workflow then has nothing to merge.
   */
  prNumber?: number;
  /** The commit this run made on the branch. Absent when it made none. */
  headSha?: string;
  /** False when the base already carried this run: no commit, so nothing to merge. */
  committed?: boolean;
  /**
   * The archive record this run committed beside the run-log, repo-relative.
   * Absent when the input carried no `archive`, or when nothing was committed.
   * The workflow hands it to `mergeScorecardPr` as the one extra file the diff
   * may hold, and archives separately when it is absent.
   */
  archivePath?: string;
  /** The archive filename stem: the run id, or `<id>-n` when that name was taken on the base. */
  archiveId?: string;
}

/** `<iso>`, or `<iso>-2`, `<iso>-3`, … on a same-day collision (spec §5.1). */
function uniqueId(iso: string, existing: ScorecardRunRecord[]): string {
  const ids = new Set(existing.map((r) => r.id));
  if (!ids.has(iso)) return iso;
  for (let n = 2; ; n++) {
    const candidate = `${iso}-${n}`;
    if (!ids.has(candidate)) return candidate;
  }
}

interface ScorecardPrBodyOptions {
  dryRun: boolean;
  held?: { failedPages: number; totalPages: number };
  archivePath?: string;
}

function buildScorecardPrBody(record: ScorecardRunRecord, perPage: PerPageDetail[], options: ScorecardPrBodyOptions): string {
  const { dryRun, held, archivePath } = options;
  const metricRows = record.metrics.map((m) => `| ${m.name} | ${m.value}/${m.maximum} | ${m.status} |`).join('\n');
  const pageRows = perPage
    .map(
      (p) =>
        `| ${p.url} | ${p.axeViolations} | ${readingBudgetCell(p.readingBudget)} | ${agenticCell(p.agenticChecks)} | ${Object.entries(p.scores)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')} |`,
    )
    .join('\n');
  const budgetLine = record.readingBudget
    ? `Reading budget, lowest content share of an agent's first 8,000 characters across ${record.readingBudget.pages} page(s): ` +
      `${record.readingBudget.text.lowest}% as text on ${record.readingBudget.text.url}` +
      (record.readingBudget.markdown
        ? `, ${record.readingBudget.markdown.lowest}% as markdown on ${record.readingBudget.markdown.url}.`
        : '; no markdown twin on any page.')
    : 'Reading budget: not measured on this run.';

  const lines: string[] = [];
  if (dryRun) {
    lines.push(
      '> **DRY RUN — do not merge.** This PR exists to verify the Scorecard publish mechanics and will be closed.',
      '',
    );
  }
  if (held) {
    lines.push(
      `> **Held for Matt.** ${held.failedPages} of ${held.totalPages} page(s) could not be audited, so Steward ` +
        'leaves this pull request open and does not merge it. Merge it by hand if the numbers are right, or close it. ' +
        'The next healthy night publishes its own pull request.',
      '',
    );
  }
  lines.push(
    `**Scorecard run \`${record.id}\`** — ${record.entry}`,
    '',
    record.commentary,
    '',
    '| Metric | Score | Status |',
    '|---|---|---|',
    metricRows,
    '',
    `Scope: ${record.scope} · Tools: ${record.tools.join(', ')}`,
    '',
    budgetLine,
    '',
    '<details><summary>Per-page detail</summary>',
    '',
    '| URL | Axe violations | First read, text / markdown | Agent checks | Scores |',
    '|---|---|---|---|---|',
    pageRows,
    '',
    '</details>',
    '',
    ...(archivePath ? [`This pull request also adds the run's per-page record, \`${archivePath}\`.`, ''] : []),
    '---',
    '',
    dryRun
      ? '*Opened by the Scorecard workflow. Steward does not merge a dry run.*'
      : held
        ? '*Opened by the Scorecard workflow. Held: Steward does not merge this one.*'
        : '*Opened by the Scorecard workflow. Steward merges it after the checks pass.*',
  );
  return lines.join('\n');
}

/**
 * `publishScorecardRun` (spec §4.3) — appends the candidate run to
 * `src/data/scorecard-runs.json` on a branch and opens (or updates) a PR.
 *
 * **No longer a worktree activity** (2026-08-14). It keeps the same two
 * properties the worktree version was built around — reset-to-base rather than
 * append-to-whatever-is-there, and an idempotent open-or-update PR check — but
 * makes them API calls, so the activity has no local dependency and runs on
 * `steward-audit`. `publishPost` still uses the worktree, deliberately: a post
 * is a multi-file change that wants to be one commit, and this is one file.
 *
 * Dropping the worktree also drops the shared `withWorktreeLock`, and with it
 * the contention the 20-minute `startToCloseTimeout` in `scorecard-audit.ts`
 * existed to survive. A scorecard publish can no longer be blocked behind a
 * `buildAndAuditDraft` holding the tree.
 *
 * **The workflow does not call this in `dry-run` mode** (spec §4.2 step 4).
 * This function does not gate on `dryRun` beyond labelling the PR, so that
 * guarantee lives in the workflow, not here.
 *
 * ## The archive record rides in the same commit (STW-614, 2026-11-15)
 *
 * When the input carries `archive`, the run-log entry and the run's archive
 * record go in one commit through the Git Data API, on a branch just reset to
 * the base. One commit, for the reason `archiveScorecardRun` gives: two pushes
 * start two Vercel previews, and the pair raced once. The archive name is
 * `<id>.json`, or `<id>-2.json` and so on when the base already holds that name,
 * so a record on the default branch is not replaced. `latest.json` is not
 * written here: the merge rule allows one archive file.
 *
 * The record in the file carries no `prUrl`: the commit is made before the pull
 * request exists.
 */
/**
 * Blocks a present-relative commentary or metric description before it ever
 * reaches disk (spec §5.1 rule 7) — near-zero false positive rate here, so
 * this is a hard block, not a flag. Checks the run's own `commentary` plus
 * every metric's `description`, since the standard applies to both.
 */
function assertTimelessCommentary(record: Omit<ScorecardRunRecord, 'id'>): void {
  const checks: Array<{ label: string; text: string }> = [
    { label: 'commentary', text: record.commentary },
    ...record.metrics.map((m) => ({ label: `${m.name} description`, text: m.description })),
  ];
  for (const { label, text } of checks) {
    const result = validateCommentary(text);
    if (!result.ok) {
      throw new Error(
        `scorecard ${label} reads as present-relative, not timeless (found: ${result.matches.join(', ')}): "${text}"`,
      );
    }
  }
}

export async function publishScorecardRun(input: PublishScorecardRunInput): Promise<PublishScorecardRunResult> {
  assertTimelessCommentary(input.record);
  // One dated branch and one PR per run. Steward never closes the PR: a merge deletes the
  // branch (delete_branch_on_merge), and .github/workflows/scorecard-branch-cleanup.yml
  // deletes it when the PR closes unmerged.
  const branch = `steward/scorecard-${input.record.iso}`;

  const base = await defaultBranch();
  const baseSha = await branchSha(base);

  // Reset the branch to base rather than appending to whatever a previous failed
  // attempt left on it — the API translation of the old `checkout -B branch
  // origin/base` plus `push --force-with-lease`. Without it a retried publish
  // stacks a second run entry on top of the first.
  await resetBranch(branch, baseSha);

  const runsFile = await readRepoFile(SCORECARD_RUNS_PATH, base);
  if (!runsFile) {
    throw ApplicationFailure.nonRetryable(
      `${SCORECARD_RUNS_PATH} does not exist on ${base}. The run-log is seeded, not created here.`,
      'NotFound',
    );
  }
  const existing = JSON.parse(runsFile.text) as ScorecardRunRecord[];

  const id = uniqueId(input.record.iso, existing);
  const record: ScorecardRunRecord = { ...input.record, id };
  const updated = JSON.stringify([record, ...existing], null, 2) + '\n';

  // The "nothing to commit" case the worktree version handled with `git status
  // --porcelain`: base already carries this exact run, so a commit would be
  // empty and the API would answer 409 rather than no-op.
  let committed = false;
  let headSha: string | undefined;
  let archivePath: string | undefined;
  let archiveId: string | undefined;
  if (updated !== runsFile.text && input.archive) {
    // Create-only by a read of the base: a tree write replaces what is at a path.
    for (let n = 1; ; n++) {
      archiveId = n === 1 ? id : `${id}-${n}`;
      archivePath = `${SCORECARD_ARCHIVE_REL}/${archiveId}.json`;
      if (!(await readRepoFile(archivePath, base))) break;
    }
    const archived: ScorecardArchiveRecord = {
      ...record,
      archiveId,
      perPage: input.perPage,
      decision: input.archive.decision,
      reason: input.archive.reason,
    };
    const commit = await commitFiles({
      parent: baseSha,
      message: `chore(scorecard): publish ${id} run`,
      files: [
        { path: SCORECARD_RUNS_PATH, text: updated },
        { path: archivePath, text: JSON.stringify(archived, null, 2) + '\n' },
      ],
    });
    // The branch was reset to `baseSha` above, so this is a fast forward unless
    // something else wrote to the run's branch in between.
    if (!(await fastForwardBranch(branch, commit))) {
      throw new Error(`${branch} moved between its reset and the run's commit; the publish was not made.`);
    }
    headSha = commit;
    committed = true;
  } else if (updated !== runsFile.text) {
    const written = await writeRepoFile({
      path: SCORECARD_RUNS_PATH,
      text: updated,
      message: `chore(scorecard): publish ${id} run`,
      branch,
      sha: runsFile.sha,
    });
    headSha = written.commitSha;
    committed = true;
  } else {
    log.info({ activity: 'publishScorecardRun', id, branch }, 'nothing to commit — base already carries this run');
  }

  const prUrl = await openOrUpdatePr({
    branch,
    base,
    title: `${input.dryRun ? '[dry run] ' : ''}Scorecard: ${id}`,
    body: buildScorecardPrBody(record, input.perPage, {
      dryRun: input.dryRun === true,
      held: input.held,
      archivePath,
    }),
    draft: input.dryRun === true,
  });
  log.info(
    { activity: 'publishScorecardRun', id, prUrl, branch, committed, archivePath, held: input.held !== undefined },
    'scorecard PR open',
  );

  return {
    branch,
    prUrl,
    id,
    prNumber: pullNumberFromUrl(prUrl),
    headSha,
    committed,
    ...(archivePath && committed ? { archivePath, archiveId } : {}),
  };
}

// ---------------------------------------------------------------------------
// The merge leg: readScorecardPrChecks and mergeScorecardPr
// ---------------------------------------------------------------------------

/**
 * Reads the check runs on one exact commit, the one `publishScorecardRun` made.
 * Not the branch: a branch that moved would answer for a different commit.
 *
 * Throws on a GitHub error, unlike `checkPrChecks`: the workflow's retry policy
 * decides, and "could not read" must not look like "still pending" for thirty
 * polls.
 */
export async function readScorecardPrChecks(headSha: string): Promise<ScorecardChecksResult> {
  const runs = await gh(`/repos/${GITHUB_REPO}/commits/${headSha}/check-runs?per_page=100`);
  const list: CheckRunLike[] = (runs?.check_runs ?? []).map((r: CheckRunLike) => ({
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
  }));
  return evaluateScorecardChecks(list);
}

export interface MergeScorecardPrInput {
  /** The pull request this run opened. */
  prNumber: number;
  /** The run's exact branch name. A glob would match the archive branch too. */
  branch: string;
  /** The commit `publishScorecardRun` made. GitHub refuses the merge if the head moved off it. */
  expectedHeadSha: string;
  /**
   * The archive record the run committed beside the run-log, when it did. The
   * diff may hold this one file as well as the run-log. Absent on a call from a
   * history recorded before STW-614, and the diff must then be the run-log alone.
   */
  archivePath?: string;
}

/**
 * Merges the pull request this run opened. It is not used for any other.
 *
 * It decides from GitHub at merge time, not from the workflow's memory of
 * earlier polls: the pull request is this run's (number, exact branch, default
 * base, this repository), its head is the commit the run made, the diff is
 * `src/data/scorecard-runs.json` plus at most the run's own archive record
 * (`checkChangedFiles`), and the head's checks are complete, with the required
 * one successful. Any miss is a returned refusal naming the
 * condition. The pull request stays open and the workflow marks the run
 * unhealthy.
 *
 * **Idempotent.** A pull request already merged with the expected head returns
 * its merge commit. A merge GitHub accepted whose reply was lost therefore reads
 * as merged on the retry, not as a failure.
 *
 * The merge is a merge commit and carries the expected head `sha`, so GitHub
 * refuses a head that moved after the checks above. GitHub's own message is
 * kept when it refuses (a ruleset, a missing permission).
 */
export async function mergeScorecardPr(input: MergeScorecardPrInput): Promise<ScorecardMergeOutcome> {
  const repo = GITHUB_REPO;
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
  const base = await defaultBranch();
  const expectation = { branch: input.branch, expectedHeadSha: input.expectedHeadSha, defaultBranch: base, repo };

  if (pull.merged && pull.mergeCommitSha) {
    // Already merged. Merged from this run's commit is the success a lost reply hides.
    if (pull.headSha === input.expectedHeadSha && pull.headRef === input.branch) {
      log.info({ activity: 'mergeScorecardPr', pr: input.prNumber, mergeSha: pull.mergeCommitSha }, 'already merged');
      return { merged: true, mergeSha: pull.mergeCommitSha };
    }
    return { merged: false, condition: 'head-moved', detail: `the pull request merged from ${pull.headSha}, not the run's ${input.expectedHeadSha}` };
  }

  const identity = checkPullIdentity(pull, expectation);
  if (identity) return identity;

  const files = await gh(`/repos/${repo}/pulls/${input.prNumber}/files?per_page=100`);
  const changed = (Array.isArray(files) ? files : []).map((f: { filename: string; status?: string }) => ({
    filename: f.filename,
    status: f.status,
  }));
  const diff = checkChangedFiles(changed, {
    runLogPath: SCORECARD_RUNS_PATH,
    archivePath: input.archivePath,
    archiveDir: SCORECARD_ARCHIVE_REL,
  });
  if (diff) return diff;

  const checks = await readScorecardPrChecks(input.expectedHeadSha);
  const unready = checksRefusal(checks);
  if (unready) return unready;

  const res = await ghResponse(`/repos/${repo}/pulls/${input.prNumber}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'merge', sha: input.expectedHeadSha }),
  });
  if (res.ok) {
    log.info({ activity: 'mergeScorecardPr', pr: input.prNumber, mergeSha: res.body.sha }, 'scorecard PR merged');
    return { merged: true, mergeSha: String(res.body.sha) };
  }
  const message = String(res.body?.message ?? `HTTP ${res.status}`);
  // 409 with this message is GitHub saying the head moved between our read and the merge.
  if (res.status === 409 && /head branch was modified/i.test(message)) {
    return { merged: false, condition: 'head-moved', detail: message };
  }
  return { merged: false, condition: 'github-refused', detail: `GitHub ${res.status}: ${message}` };
}

// ---------------------------------------------------------------------------
// archiveScorecardRun — light queue
// ---------------------------------------------------------------------------

export interface ScorecardArchiveRecord {
  /**
   * The run's *run-log* identity: the id it was published under, or the
   * candidate `iso` it would have used had it published. Not necessarily the
   * archive filename — see `archiveId`.
   */
  id: string;
  /**
   * The archive filename stem, resolved against the files already on disk and
   * always present on a written record. Equal to `id` in the ordinary case;
   * `<id>-2`, `<id>-3`, … when this is the second or third run archived on a
   * day already taken. Set by `archiveScorecardRun`, never by the caller.
   */
  archiveId?: string;
  iso: string;
  timestamp?: string;
  scope: string;
  tools: string[];
  entry: string;
  commentary: string;
  metrics: ScorecardMetric[];
  perPage: PerPageDetail[];
  decision: 'open-pr' | 'no-op';
  reason: string;
  prUrl?: string;
  /**
   * Set by the workflow from `publishMode`, and the reason this activity can
   * still honour spec §4.2 step 4.
   *
   * The archive used to be a local file write, so "dry-run never touches
   * GitHub" cost nothing to promise: archiving and publishing used different
   * machinery entirely. Now that the archive commits through the API, the two
   * share it, and a `--dry-run` that quietly pushed a commit would break a
   * guarantee the operator relies on to run one casually. So a dry run computes
   * the record, logs it, and writes nothing.
   *
   * The cost is that `--dry-run` no longer leaves a per-page record behind. The
   * numbers it exists to validate come back on the workflow result and the CLI
   * prints them, so nothing that dry-run is *for* was lost.
   */
  dryRun?: boolean;
}

export interface ArchiveScorecardRunResult {
  /** Repo-relative path of the record. Empty on a dry run, which writes nothing. */
  archivePath: string;
  /** The filename stem actually used — `id`, or `<id>-n` if that was taken. */
  archiveId: string;
  /** False on a dry run. True when this call, or an earlier attempt of it, committed the record. */
  committed: boolean;
}

/** Rebuilds after the archive branch moved, before the activity gives up. */
const ARCHIVE_MOVED_RETRIES = 3;

/** The text of a record's file under the name `archiveId`. */
function archiveJson(record: ScorecardArchiveRecord, archiveId: string): string {
  return JSON.stringify({ ...record, archiveId }, null, 2) + '\n';
}

/**
 * Walks `<id>`, `<id>-2`, … on `ref`. Stops at the first name that is free, or
 * that already holds exactly this record (`written`).
 */
async function findArchiveName(
  record: ScorecardArchiveRecord,
  ref: string,
): Promise<{ archiveId: string; archivePath: string; written: boolean }> {
  for (let n = 1; ; n++) {
    const archiveId = n === 1 ? record.id : `${record.id}-${n}`;
    const archivePath = `${SCORECARD_ARCHIVE_REL}/${archiveId}.json`;
    const file = await readRepoFile(archivePath, ref);
    if (!file) return { archiveId, archivePath, written: false };
    if (file.text === archiveJson(record, archiveId)) return { archiveId, archivePath, written: true };
  }
}

/**
 * Writes the full run — public metrics plus per-page raw detail — to the
 * private archive (spec §5.2). A no-op night is still a fact worth keeping, and
 * the archive is the only place that per-page detail survives at all — the
 * public run-log does not carry it.
 *
 * ## Which runs still come here (STW-614, 2026-11-15)
 *
 * A run that publishes now commits its archive record in its own pull request
 * (`publishScorecardRun`), and the workflow skips this activity for it. That is
 * every healthy scheduled run, and a manual run with something to publish. This
 * activity keeps the runs that open no run-log pull request: a manual no-op, a
 * run where every page failed, a mixed-Lighthouse-version run, and a dry run
 * (which writes nothing, below). So the archive branch and its pull request
 * appear only after one of those, and a person merges or closes that pull
 * request. The sections below describe this route, and were written when every
 * run took it.
 *
 * ## It commits to one accumulating branch, not to the run's PR (2026-08-14)
 *
 * The archive used to be a `writeFile` into the checkout, which left the record
 * untracked until somebody remembered to commit it. It now commits through the
 * GitHub API, which raises a question the filesystem never posed: *which
 * branch*.
 *
 * Not the run's own PR branch. `publishScorecardRun` only runs when the result
 * changed or went stale, so a run-log PR appearing **means something changed**
 * (spec §6) — and it would stop meaning that the moment every no-op night
 * opened one to carry an archive record. One archive branch and one archive PR
 * keeps the signal where it belongs and gives the no-op nights somewhere to
 * accumulate. `ensureBranch` below creates `SCORECARD_ARCHIVE_BRANCH` off the
 * default branch whenever it is absent, and every run after that appends to it.
 * It is never reset while it exists, because until the archive PR merges its
 * whole content is history nobody else has. Merging that PR ends the branch
 * rather than resetting it: the repository deletes a branch on merge, the
 * records land on the default branch, and the next night's `ensureBranch` cuts
 * a fresh one from there. Nothing is lost either way — an unmerged branch keeps
 * accumulating, and a merged one has already handed its records to the default
 * branch.
 *
 * **The archive is append-only** (spec §5.2), which it was not until this
 * resolved a filename: a second run on a day already archived overwrote
 * `<iso>.json` outright, silently destroying the earlier run's per-page detail.
 * That is easy to hit — two manual runs in a day, or a `--dry-run` followed by
 * the real thing — and the destroyed record is the *only* copy.
 *
 * ## One commit per run (2026-10-29)
 *
 * The record and `latest.json` used to be two Contents API writes, so two
 * commits about a second apart, and Vercel starts a preview per push. On
 * 2026-10-12 the two previews raced and the head one failed with
 * `git_info_fail`, which turned a PR red with every check green. Both files now
 * go in one commit through the Git Data API: blobs, a tree on `base_tree`, a
 * commit, then a ref update.
 *
 * The ref update is never forced. A Contents `PUT` with no `sha` used to be the
 * create-only claim; a tree write replaces what is at a path, so the activity
 * reads whether `<id>.json` exists on the branch and walks `<id>`, `<id>-2`,
 * `<id>-3` itself. A push that lands between that read and the ref update makes
 * GitHub refuse the update as not a fast forward, so nothing is dropped and no
 * name is taken twice. The activity then reads the branch again and rebuilds
 * the commit, at most {@link ARCHIVE_MOVED_RETRIES} times before it throws.
 *
 * `latest.json` is overwritten every run. It is a pointer at the newest
 * record, not a record of its own.
 *
 * The workflow issues the same commands as before, so this change carries no
 * `patched` marker.
 *
 * ## A retry writes no second record (STW-717, 2026-11-27)
 *
 * An attempt can commit and then fail: a lost reply, or a failure while it opens
 * the pull request. A retry gets the same input from history, so the file it
 * wrote is, byte for byte, the one this attempt would write under that name.
 * {@link findArchiveName} reads each taken name and compares. A different run
 * differs at least in its `timestamp`.
 *
 * The default branch is read first. The archive pull request may have merged
 * between two attempts, which deletes the branch, and a branch cut again would
 * hold nothing to open a pull request from. On the archive branch a match makes
 * no commit and still opens the pull request, which may be the step that failed.
 *
 * A record edited by hand, or a deploy between two attempts that changes how the
 * record is serialised, no longer matches, and the retry writes it again.
 */
export async function archiveScorecardRun(record: ScorecardArchiveRecord): Promise<ArchiveScorecardRunResult> {
  if (record.dryRun) {
    log.info(
      { activity: 'archiveScorecardRun', id: record.id, decision: record.decision, record },
      'dry run — the archive record was computed and logged, not committed (spec §4.2 step 4)',
    );
    return { archivePath: '', archiveId: record.id, committed: false };
  }

  const base = await defaultBranch();
  const merged = await findArchiveName(record, base);
  if (merged.written) {
    log.info(
      { activity: 'archiveScorecardRun', id: record.id, archiveId: merged.archiveId, branch: base },
      "an earlier attempt's record is already on the default branch; nothing to write",
    );
    return { archivePath: merged.archivePath, archiveId: merged.archiveId, committed: true };
  }
  await ensureBranch(SCORECARD_ARCHIVE_BRANCH, await branchSha(base));

  const latestPath = `${SCORECARD_ARCHIVE_REL}/latest.json`;
  let archiveId = record.id;
  let archivePath = '';
  let moved = 0;
  for (;;) {
    const head = await branchSha(SCORECARD_ARCHIVE_BRANCH);
    // Create-only, checked here because a tree write replaces whatever is at
    // the path. A name taken between this read and the ref update is caught by
    // the ref update below: the branch moved, so the whole pass reruns.
    const name = await findArchiveName(record, SCORECARD_ARCHIVE_BRANCH);
    ({ archiveId, archivePath } = name);
    // An earlier attempt committed it. `latest.json` went in that commit.
    if (name.written) break;
    const json = archiveJson(record, archiveId);
    const commit = await commitFiles({
      parent: head,
      message: `chore(scorecard): archive ${archiveId}`,
      files: [
        { path: archivePath, text: json },
        { path: latestPath, text: json },
      ],
    });
    if (await fastForwardBranch(SCORECARD_ARCHIVE_BRANCH, commit)) break;
    if (++moved > ARCHIVE_MOVED_RETRIES) {
      throw new Error(
        `${SCORECARD_ARCHIVE_BRANCH} moved under ${ARCHIVE_MOVED_RETRIES + 1} archive attempts in a row; giving up.`,
      );
    }
    log.info({ activity: 'archiveScorecardRun', id: record.id, moved }, 'archive branch moved — rebuilding from a fresh read');
  }

  await openOrUpdatePr({
    branch: SCORECARD_ARCHIVE_BRANCH,
    base,
    title: 'Scorecard archive: per-run detail',
    body:
      'Per-run Scorecard records — public metrics plus the per-page raw scores the ' +
      'public run-log never carries (spec §5.2).\n\n' +
      'A run that publishes carries its record in its own `Scorecard: <id>` PR. This branch ' +
      'holds the records of runs that opened no such PR: a manual run with nothing to publish, ' +
      'a night where every page failed, or a night measured by two Lighthouse versions. ' +
      'Merge this whenever; nothing waits on it. Merging puts these records on the default ' +
      'branch and deletes the branch, and the next such run cuts a new one.\n\n' +
      `Most recent record: \`${archiveId}\` (${record.decision}).\n\n` +
      '---\n\n' +
      '*Opened by the Scorecard workflow. Steward does not merge this one; merge or close it by hand.*',
  });

  log.info(
    {
      activity: 'archiveScorecardRun',
      id: record.id,
      archiveId,
      decision: record.decision,
      archivePath,
      branch: SCORECARD_ARCHIVE_BRANCH,
    },
    archiveId === record.id
      ? 'scorecard run archived'
      : 'scorecard run archived under a suffixed id — the day was already taken',
  );
  return { archivePath, archiveId, committed: true };
}
