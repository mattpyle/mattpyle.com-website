import { ApplicationFailure, Context } from '@temporalio/activity';
import {
  SCORECARD_ARCHIVE_BRANCH,
  SCORECARD_ARCHIVE_REL,
  SCORECARD_RUNS_PATH,
} from '../config.js';
import {
  branchSha,
  defaultBranch,
  ensureBranch,
  isAlreadyExists,
  openOrUpdatePr,
  readRepoFile,
  resetBranch,
  writeRepoFile,
} from '../lib/github-contents.js';
import { auditUrl } from '../lib/audit-engine.js';
import { log } from '../lib/logger.js';
import { parsePageCount, validateCommentary } from '../lib/scorecard-aggregate.js';
import type { PageAuditOutcome, PublishableRun, ScorecardMetric, ScorecardRunRecord } from '../lib/scorecard-aggregate.js';

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
 * archive was a `writeFile` under `SCORECARD_ARCHIVE_DIR`. That is what pinned
 * the whole scorecard run to Matt's laptop, and therefore what kept the daily
 * Schedule laptop-bound no matter where the Schedule itself lived
 * (always-on-audit-worker card, leg 2b).
 *
 * They now read and write the repository through the GitHub API
 * (`lib/github-contents.ts`), so the entire workflow runs on `steward-audit`
 * and finishes end to end on the hosted worker with the laptop off. What the
 * activities *mean* is unchanged: same run-log entry, same PR, same archive
 * record, same never-merges-its-own-PR rule.
 *
 * The cost is that this file now needs `GITHUB_TOKEN` for reads as well as
 * writes, where before only the publish leg did. A run whose token is missing
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

/**
 * Fetches the live sitemap index and every sitemap it references, returning
 * the full set of indexed HTML URLs (spec §5.4). **Not a hardcoded list** —
 * `@astrojs/sitemap` already excludes drafts, numeric changelog pagination
 * pages, and `.md` variants at build time (astro.config.mjs's `filter`), so
 * whatever this returns is exactly "what's live" by the site's own rules.
 */
export async function resolveAuditUrls(sitemapUrl: string): Promise<string[]> {
  const idxRes = await fetch(sitemapUrl);
  if (!idxRes.ok) {
    throw new Error(`sitemap index fetch failed: ${sitemapUrl} -> ${idxRes.status}`);
  }
  const idx = await idxRes.text();
  const subSitemaps = extractLocs(idx);
  if (subSitemaps.length === 0) {
    throw new Error(`sitemap index ${sitemapUrl} referenced no sitemaps`);
  }

  const urls = new Set<string>();
  for (const loc of subSitemaps) {
    const res = await fetch(loc);
    if (!res.ok) throw new Error(`sitemap fetch failed: ${loc} -> ${res.status}`);
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
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
 */
export async function auditLiveUrl(url: string): Promise<PageAuditOutcome> {
  const ctx = Context.current();
  const signal = ctx.cancellationSignal;
  const pump = setInterval(() => ctx.heartbeat(`auditing ${url}`), 5_000);
  try {
    ctx.heartbeat(`auditing ${url}`);
    const raw = await auditUrl(url, signal);
    return {
      url,
      ok: true,
      scores: raw.scores,
      agenticChecks: raw.agenticChecks,
      axeViolations: raw.axeViolations.length,
    };
  } finally {
    clearInterval(pump);
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
 * needs the laptop here parks the run before it measures anything and there is
 * no such thing as a partially-hosted scorecard.
 */
export async function readPublishedScorecard(): Promise<PublishedScorecard | undefined> {
  const base = await defaultBranch();
  const file = await readRepoFile(SCORECARD_RUNS_PATH, base);
  if (!file) return undefined;
  const runs = JSON.parse(file.text) as ScorecardRunRecord[];
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
}

export interface PublishScorecardRunInput {
  /** Everything but `id` — the final id (collision-checked against the real file) is resolved here, not by the workflow, which never reads the file directly. */
  record: Omit<ScorecardRunRecord, 'id'>;
  perPage: PerPageDetail[];
  /** Opens the PR as a draft and tags the title — same convention as `publishPost`'s dry-run. */
  dryRun?: boolean;
}

export interface PublishScorecardRunResult {
  branch: string;
  prUrl: string;
  id: string;
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

function buildScorecardPrBody(record: ScorecardRunRecord, perPage: PerPageDetail[], dryRun: boolean): string {
  const metricRows = record.metrics.map((m) => `| ${m.name} | ${m.value}/${m.maximum} | ${m.status} |`).join('\n');
  const pageRows = perPage
    .map((p) => `| ${p.url} | ${p.axeViolations} | ${Object.entries(p.scores).map(([k, v]) => `${k}: ${v}`).join(', ')} |`)
    .join('\n');

  const lines: string[] = [];
  if (dryRun) {
    lines.push(
      '> **DRY RUN — do not merge.** This PR exists to verify the Scorecard publish mechanics and will be closed.',
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
    '<details><summary>Per-page detail</summary>',
    '',
    '| URL | Axe violations | Scores |',
    '|---|---|---|',
    pageRows,
    '',
    '</details>',
    '',
    '---',
    '',
    '*Opened by the Scorecard workflow. It never merges — that is deliberately a human act (design rule 2).*',
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
 * **The workflow never calls this in `dry-run` mode** (spec §4.2 step 4) —
 * this function itself does not gate on `dryRun` beyond labelling the PR, so
 * that guarantee lives in the workflow, not here.
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
  if (updated !== runsFile.text) {
    await writeRepoFile({
      path: SCORECARD_RUNS_PATH,
      text: updated,
      message: `chore(scorecard): publish ${id} run`,
      branch,
      sha: runsFile.sha,
    });
    committed = true;
  } else {
    log.info({ activity: 'publishScorecardRun', id, branch }, 'nothing to commit — base already carries this run');
  }

  const prUrl = await openOrUpdatePr({
    branch,
    base,
    title: `${input.dryRun ? '[dry run] ' : ''}Scorecard: ${id}`,
    body: buildScorecardPrBody(record, input.perPage, input.dryRun === true),
    draft: input.dryRun === true,
  });
  log.info({ activity: 'publishScorecardRun', id, prUrl, branch, committed }, 'scorecard PR open');

  return { branch, prUrl, id };
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
  /** False on a dry run. True whenever a commit was actually made. */
  committed: boolean;
}

/**
 * Writes the full run — public metrics plus per-page raw detail — to the
 * private archive (spec §5.2). **Runs on every execution, published or not**
 * (spec §4.2 step 5): a no-op night is still a fact worth keeping, and the
 * archive is the only place that per-page detail survives at all — the public
 * run-log never carries it.
 *
 * ## It commits to a standing branch, not to the run's PR (2026-08-14)
 *
 * The archive used to be a `writeFile` into the checkout, which left the record
 * untracked until somebody remembered to commit it. It now commits through the
 * GitHub API, which raises a question the filesystem never posed: *which
 * branch*.
 *
 * Not the run's own PR branch. `publishScorecardRun` only runs when the result
 * changed or went stale, so a run-log PR appearing **means something changed**
 * (spec §6) — and it would stop meaning that the moment every no-op night
 * opened one to carry an archive record. One standing branch and one standing
 * PR keeps the signal where it belongs and gives the no-op nights somewhere to
 * accumulate. `SCORECARD_ARCHIVE_BRANCH` is created off the default branch once
 * and then only ever appended to; it is never reset, because unlike the run-log
 * branch its whole content is history nobody has merged yet.
 *
 * **The archive is append-only** (spec §5.2), which it was not until this
 * resolved a filename: a second run on a day already archived overwrote
 * `<iso>.json` outright, silently destroying the earlier run's per-page detail.
 * That is easy to hit — two manual runs in a day, or a `--dry-run` followed by
 * the real thing — and the destroyed record is the *only* copy.
 *
 * The atomic claim survives the move intact, in a nicer form. The filesystem
 * version needed `writeFile` with `flag: 'wx'` because a check-then-write is a
 * race; here, a Contents API `PUT` **with no `sha`** means "create, and fail if
 * this path exists", so the create is the claim and the retry loop walks
 * `<id>`, `<id>-2`, `<id>-3` exactly as before.
 *
 * `latest.json` is still overwritten every run. It is a pointer at the newest
 * record, not a record of its own, so it is written with the sha it is
 * replacing.
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
  await ensureBranch(SCORECARD_ARCHIVE_BRANCH, await branchSha(base));

  let archiveId = record.id;
  let archivePath = '';
  for (let n = 1; ; n++) {
    archiveId = n === 1 ? record.id : `${record.id}-${n}`;
    archivePath = `${SCORECARD_ARCHIVE_REL}/${archiveId}.json`;
    const json = JSON.stringify({ ...record, archiveId }, null, 2) + '\n';
    try {
      // No `sha`: this must be a create. A collision comes back 422 rather than
      // overwriting the earlier run's only copy of its per-page detail.
      await writeRepoFile({
        path: archivePath,
        text: json,
        message: `chore(scorecard): archive ${archiveId}`,
        branch: SCORECARD_ARCHIVE_BRANCH,
      });
      break;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  const latestPath = `${SCORECARD_ARCHIVE_REL}/latest.json`;
  const latest = await readRepoFile(latestPath, SCORECARD_ARCHIVE_BRANCH);
  await writeRepoFile({
    path: latestPath,
    text: JSON.stringify({ ...record, archiveId }, null, 2) + '\n',
    message: `chore(scorecard): point latest at ${archiveId}`,
    branch: SCORECARD_ARCHIVE_BRANCH,
    sha: latest?.sha,
  });

  await openOrUpdatePr({
    branch: SCORECARD_ARCHIVE_BRANCH,
    base,
    title: 'Scorecard archive: per-run detail',
    body:
      'Per-run Scorecard records — public metrics plus the per-page raw scores the ' +
      'public run-log never carries (spec §5.2).\n\n' +
      'This branch is **standing**: every run appends to it, including the no-op nights ' +
      'that open no run-log PR of their own. That is the point — a `Scorecard: <id>` PR ' +
      'appearing means a number moved, and it would stop meaning that if the archive rode ' +
      'in it. Merge this whenever; nothing waits on it.\n\n' +
      `Most recent record: \`${archiveId}\` (${record.decision}).\n\n` +
      '---\n\n' +
      '*Opened by the Scorecard workflow. It never merges — that is deliberately a human act (design rule 2).*',
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
