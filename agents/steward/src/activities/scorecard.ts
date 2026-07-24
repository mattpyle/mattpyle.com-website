import fs from 'node:fs/promises';
import path from 'node:path';
import { Context } from '@temporalio/activity';
import {
  REPO_ROOT,
  SITE_DIR,
  WORKTREE_DIR,
  GITHUB_REPO,
  SCORECARD_RUNS_PATH,
  SCORECARD_ARCHIVE_DIR,
} from '../config.js';
import { git, worktreeExists } from '../lib/git.js';
import { gh } from '../lib/github.js';
import { auditUrl } from '../lib/audit-engine.js';
import { log } from '../lib/logger.js';
import { validateCommentary } from '../lib/scorecard-aggregate.js';
import type { PageAuditOutcome, PublishableRun, ScorecardMetric, ScorecardRunRecord } from '../lib/scorecard-aggregate.js';

/**
 * The Scorecard system's activities (scorecard-audit-spec.md §4.3). A sibling
 * of the Steward's own activities, not a variant of them — see the spec §2
 * table for why `auditLiveUrl` must never be confused with
 * `buildAndAuditDraft`, even though both call the same `audit-engine.ts`.
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

  const list = [...urls].sort();
  log.info({ activity: 'resolveAuditUrls', sitemapUrl, count: list.length }, 'resolved live audit URL set');
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

/**
 * Reads the currently-published run-log from the primary checkout
 * (`SITE_DIR`, not the worktree — this is a read of what's actually live on
 * `master`, before any publish work has started). `undefined` only if the
 * file is missing or empty, which should never happen once Phase 1 seeds it.
 */
export async function readPublishedScorecard(): Promise<PublishableRun | undefined> {
  const absPath = path.join(SITE_DIR, SCORECARD_RUNS_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(absPath, 'utf8');
  } catch {
    return undefined;
  }
  const runs = JSON.parse(raw) as ScorecardRunRecord[];
  if (runs.length === 0) return undefined;
  return { iso: runs[0].iso, metrics: runs[0].metrics };
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
 * `src/data/scorecard-runs.json` in a worktree, commits, pushes, and opens
 * (or updates) a PR. Mirrors `activities/publish.ts`'s `publishPost` in
 * shape: same worktree-reset-to-base pattern, same idempotent
 * open-or-update-existing-PR check, same `git`/`gh` libs.
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

  const repoInfo = await gh(`/repos/${GITHUB_REPO}`);
  const base: string = repoInfo.default_branch;

  await git(SITE_DIR, ['fetch', 'origin', base]);

  // Same reasoning as `publishPost` (design rule 3): the worktree does the git
  // work, never the primary checkout, which may be mid-edit under the human.
  if (!(await worktreeExists(SITE_DIR, WORKTREE_DIR))) {
    await git(SITE_DIR, ['worktree', 'add', '--detach', WORKTREE_DIR, `origin/${base}`]);
  }
  await git(WORKTREE_DIR, ['fetch', 'origin', base]);
  await git(WORKTREE_DIR, ['checkout', '-B', branch, `origin/${base}`]);
  await git(WORKTREE_DIR, ['clean', '-fd', '-e', 'node_modules', '-e', 'dist']);

  const runsPath = path.join(WORKTREE_DIR, SCORECARD_RUNS_PATH);
  const existing = JSON.parse(await fs.readFile(runsPath, 'utf8')) as ScorecardRunRecord[];

  const id = uniqueId(input.record.iso, existing);
  const record: ScorecardRunRecord = { ...input.record, id };
  const updated = [record, ...existing];
  await fs.writeFile(runsPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');

  let committed = false;
  await git(WORKTREE_DIR, ['add', '--', SCORECARD_RUNS_PATH]);
  const staged = await git(WORKTREE_DIR, ['status', '--porcelain', '--', SCORECARD_RUNS_PATH]);
  if (staged.trim()) {
    await git(WORKTREE_DIR, ['commit', '-m', `chore(scorecard): publish ${id} run`]);
    committed = true;
  } else {
    log.info({ activity: 'publishScorecardRun', id, branch }, 'nothing to commit — base already carries this run');
  }
  await git(WORKTREE_DIR, ['push', '--force-with-lease', '-u', 'origin', branch]);
  await git(WORKTREE_DIR, ['checkout', '--detach']).catch(() => {});

  const owner = GITHUB_REPO.split('/')[0];
  const title = `${input.dryRun ? '[dry run] ' : ''}Scorecard: ${id}`;
  const body = buildScorecardPrBody(record, input.perPage, input.dryRun === true);

  const existingPrs = await gh(
    `/repos/${GITHUB_REPO}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
  );

  let prUrl: string;
  if (Array.isArray(existingPrs) && existingPrs.length > 0) {
    const updatedPr = await gh(`/repos/${GITHUB_REPO}/pulls/${existingPrs[0].number}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, body }),
    });
    prUrl = updatedPr.html_url;
    log.info({ activity: 'publishScorecardRun', id, prUrl }, 'updated existing PR');
  } else {
    const created = await gh(`/repos/${GITHUB_REPO}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, body, head: branch, base, draft: input.dryRun === true }),
    });
    prUrl = created.html_url;
    log.info({ activity: 'publishScorecardRun', id, prUrl, committed }, 'opened PR');
  }

  return { branch, prUrl, id };
}

// ---------------------------------------------------------------------------
// archiveScorecardRun — light queue
// ---------------------------------------------------------------------------

export interface ScorecardArchiveRecord {
  id: string;
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
}

export interface ArchiveScorecardRunResult {
  archivePath: string;
}

/**
 * Writes the full run — public metrics plus per-page raw detail — to the
 * private archive (spec §5.2). **Runs on every execution, published or not**
 * (spec §4.2 step 5): a no-op night is still a fact worth keeping, and the
 * archive is the only place that per-page detail survives at all — the
 * public run-log never carries it.
 */
export async function archiveScorecardRun(record: ScorecardArchiveRecord): Promise<ArchiveScorecardRunResult> {
  await fs.mkdir(SCORECARD_ARCHIVE_DIR, { recursive: true });
  const json = JSON.stringify(record, null, 2) + '\n';
  const file = path.join(SCORECARD_ARCHIVE_DIR, `${record.id}.json`);
  const latest = path.join(SCORECARD_ARCHIVE_DIR, 'latest.json');
  await fs.writeFile(file, json, 'utf8');
  await fs.writeFile(latest, json, 'utf8');

  const archivePath = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  log.info(
    { activity: 'archiveScorecardRun', id: record.id, decision: record.decision, archivePath },
    'scorecard run archived',
  );
  return { archivePath };
}
