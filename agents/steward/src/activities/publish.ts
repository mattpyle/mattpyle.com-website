import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import matter from 'gray-matter';
// pino, not `@temporalio/activity`'s `log` — the latter needs an activity
// context and would make this untestable as a plain function.
import { log } from '../lib/logger.js';
import { GITHUB_REPO, SITE_DIR, WORKTREE_DIR, postRelPath, type Collection } from '../config.js';
import { git, worktreeExists } from '../lib/git.js';
import type { ReviewReport } from '../lib/report.js';

export interface PublishPostInput {
  report: ReviewReport;
  /** Overrides the branch name. Used by the dry-run to target a throwaway branch. */
  branchOverride?: string;
  /**
   * Opens the PR as a draft and tags the title. The dry-run sets this so a PR
   * that exists only to prove the mechanics can never be mistaken for a real
   * publish sitting in the queue.
   */
  dryRun?: boolean;
}

export interface PublishPostResult {
  branch: string;
  prUrl: string;
  /** The published title, handed to `verifyDeploy` for its HTML assertion. */
  title: string;
  /** True if this call actually created a commit; false if it was already done. */
  committed: boolean;
}

// ---------------------------------------------------------------------------
// Pure frontmatter surgery — separated from all I/O so it is unit-testable.
// ---------------------------------------------------------------------------

export interface FlipResult {
  content: string;
  title: string;
  /** True if any byte changed. */
  changed: boolean;
  /** What happened to `date:`, for the log and the PR body. */
  dateAction: 'left' | 'refreshed' | 'added';
}

/**
 * Flips `draft: true` → `draft: false` and applies the §8.7 step-4 date rule.
 *
 * **Edits the frontmatter as text rather than re-serialising it.** Round-tripping
 * through `gray-matter`'s dump would reformat the entire block — reordering keys,
 * normalising quote style, rewriting the author's deliberate formatting — and
 * produce a diff where every line changed for a one-word edit. The PR is meant to
 * be readable by a human deciding whether to merge it.
 *
 * `updated:` is never touched on first publish: the post has not been updated,
 * it has been published, and a spurious `updated` would feed a false
 * `modifiedTime` into the freshness signals CLAUDE.md cares about.
 */
export function flipDraftFrontmatter(raw: string, todayIso: string): FlipResult {
  // The opening and closing fences are CAPTURED, not assumed. The first version
  // of this reconstructed the file with `raw.slice(0, fmMatch.index + 4)`, i.e.
  // a hardcoded length for `---\n` — which is 5 characters on a CRLF checkout,
  // and every file on the author's Windows machine is CRLF. See the comment on
  // the reconstruction below for what that actually produced.
  const fmMatch = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) {
    throw ApplicationFailure.nonRetryable(
      'The post has no YAML frontmatter block; refusing to guess at its structure.',
      'MalformedPost',
    );
  }

  const parsed = matter(raw);
  const title = typeof parsed.data.title === 'string' ? parsed.data.title : '';
  if (!title) {
    throw ApplicationFailure.nonRetryable(
      'The post has no `title` in frontmatter; verifyDeploy needs it to assert the page rendered.',
      'MalformedPost',
    );
  }

  const openFence = fmMatch[1];
  const closeFence = fmMatch[3];
  let block = fmMatch[2];
  const original = block;

  // draft: true -> false. If it already says false, this is a no-op, which is
  // what makes a repeated publish safe.
  //
  // `(\r?)$` rather than `\s*$`: `\s` matches `\r`, so the original pattern
  // CONSUMED the carriage return on a CRLF file and the replacement never put
  // it back — silently converting one line of a CRLF file to LF and corrupting
  // the byte offsets everything after it depended on.
  block = block.replace(/^([ \t]*draft[ \t]*:[ \t]*)true[ \t]*(\r?)$/m, '$1false$2');

  // date: refreshed only when clearly stale. A date the human set deliberately
  // (say, a post dated for an event) must survive — so the rule is deliberately
  // conservative: only a date more than 30 days in the past gets moved.
  let dateAction: FlipResult['dateAction'] = 'left';
  // Same `(\r?)$` treatment as the draft flip, for the same reason.
  const DATE_RE = /^([ \t]*date[ \t]*:[ \t]*)(.+?)[ \t]*(\r?)$/m;
  const dateMatch = block.match(DATE_RE);
  if (!dateMatch) {
    // Match the file's own line ending rather than assuming LF — an inserted
    // `\n` into an otherwise-CRLF frontmatter block is the same class of bug.
    const eol = openFence.includes('\r\n') ? '\r\n' : '\n';
    block = `date: ${todayIso}${eol}${block}`;
    dateAction = 'added';
  } else {
    const existing = new Date(dateMatch[2].replace(/^['"]|['"]$/g, ''));
    const today = new Date(todayIso);
    const ageDays = (today.getTime() - existing.getTime()) / 86_400_000;
    if (Number.isNaN(existing.getTime()) || ageDays > 30) {
      block = block.replace(DATE_RE, `$1${todayIso}$3`);
      dateAction = 'refreshed';
    }
  }

  // Reconstructed from the CAPTURED fences, so the arithmetic cannot drift from
  // the pattern that produced it.
  //
  // What the previous hardcoded-`4` version produced on a CRLF file, verified in
  // a real publish PR: `slice(0, index + 4)` kept the `\r` and dropped the `\n`,
  // welding the opening `---` onto the `title:` line and making the YAML
  // unparseable — so `date` read as undefined and the Vercel build failed with
  // "published writing requires a date field". The tail slice was short by the
  // same one byte, re-appending the final `e` of `true` to give `draft: falsee`.
  // One off-by-one, two unrelated-looking symptoms, neither caught by any test.
  const content =
    block === original
      ? raw
      : raw.slice(0, fmMatch.index!) +
        openFence +
        block +
        closeFence +
        raw.slice(fmMatch.index! + fmMatch[0].length);

  return { content, title, changed: content !== raw, dateAction };
}

/** The PR body: the report summary, the finding counts, and where to read more. */
export function buildPrBody(report: ReviewReport, reportPath: string, dryRun: boolean): string {
  const counts = report.passes
    .map((p) => `| \`${p.pass}\` | ${p.verdict} | ${p.findings.length} |`)
    .join('\n');

  // Blank lines are SIGNIFICANT here and must survive: GitHub renders this as
  // markdown, where a table needs a blank line before it and paragraphs need one
  // between them. An earlier version built the whole array with an empty string
  // standing in for the absent dry-run banner and then dropped every empty entry
  // with `.filter(l => l !== '')` — which also dropped all seven intentional
  // blank lines and collapsed the body into one unreadable run-on block. The
  // unit tests did not catch it because they assert with regexes that do not
  // care about blank lines; it was caught by reading the rendered PR.
  const lines: string[] = [];
  if (dryRun) {
    lines.push(
      "> **DRY RUN — do not merge.** This PR exists to verify the Steward's publish mechanics and will be closed.",
      '',
    );
  }
  lines.push(
    `**Verdict: ${report.overall.toUpperCase()}** — approved by ${report.human.decision === 'approved_force' ? 'the author with `--force`' : 'the author'}.`,
    '',
    report.summary,
    '',
    '| Pass | Verdict | Findings |',
    '|---|---|---|',
    counts,
    '',
    `Content pinned at \`${report.contentSha256.slice(0, 12)}\`. Full report: \`${reportPath}\`.`,
    '',
    '---',
    '',
    '*Opened by the Steward. The Steward never merges — that is deliberately a human act.*',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// GitHub REST, over plain fetch.
//
// `octokit` is named in spec §4 and was not adopted, on the same reasoning that
// retired `execa` in Phase 1b: this leg makes three REST calls with a bearer
// token, and `fetch` does that natively. A dependency tree earns its place by
// providing a guarantee the platform does not already give.
// ---------------------------------------------------------------------------

function githubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw ApplicationFailure.nonRetryable(
      'GITHUB_TOKEN is not set. The publish leg cannot open a PR without it.',
      'AuthError',
    );
  }
  return token;
}

async function gh(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};

  if (res.ok) return body;

  // Permanent vs transient, per the error-handling contract. Getting this
  // backwards is expensive in both directions: a retried auth failure burns ten
  // attempts against a credential that will never work, and a non-retried 502
  // fails a publish that would have succeeded a second later.
  if (res.status === 401 || res.status === 403) {
    throw ApplicationFailure.nonRetryable(
      `GitHub rejected the credential (${res.status}): ${body.message ?? text}. Check GITHUB_TOKEN's scopes (contents RW, pull requests RW).`,
      'AuthError',
    );
  }
  if (res.status === 404) {
    throw ApplicationFailure.nonRetryable(
      `GitHub returned 404 for ${pathname}. Either ${GITHUB_REPO} is wrong or the token cannot see it.`,
      'NotFound',
    );
  }
  if (res.status === 422) {
    throw ApplicationFailure.nonRetryable(
      `GitHub rejected the request as unprocessable (422): ${body.message ?? text}. ${JSON.stringify(body.errors ?? [])}`,
      'UnprocessableRequest',
    );
  }
  // Everything else — 5xx, rate limits, transport hiccups — is retryable, and
  // deliberately a plain Error so the default retry policy applies.
  throw new Error(`GitHub ${res.status} for ${pathname}: ${body.message ?? text}`);
}

// ---------------------------------------------------------------------------

/**
 * `publishPost` (spec §8.7).
 *
 * **Idempotent by construction** — the workflow gives it 1 attempt, but a human
 * re-approving after a park must not produce a second PR or a duplicate commit.
 * Every step checks before acting, and the branch is reset to the base each run
 * so the same inputs always produce the same tree.
 *
 * **The Steward does not merge.** Merging is what triggers the production
 * deploy, and it is the human's act. This returns as soon as the PR is open.
 */
export async function publishPost(input: PublishPostInput): Promise<PublishPostResult> {
  const { report } = input;
  const collection = (report.collection ?? 'writing') as Collection;
  const relPath = postRelPath(report.slug, collection);
  const absPath = path.join(SITE_DIR, relPath);
  const branch = input.branchOverride ?? `steward/publish-${report.slug}`;

  // --- Step 3 (hoisted): the hash gate, before anything is mutated ----------
  // The workflow already refused a stale approve. This is the belt-and-braces
  // second check the spec asks for, and it is deliberately the FIRST thing that
  // happens here: by the time a branch exists and a file has been rewritten, a
  // hash mismatch has already cost work that has to be unwound.
  let raw: string;
  try {
    raw = await fs.readFile(absPath, 'utf8');
  } catch {
    throw ApplicationFailure.nonRetryable(
      `${relPath} does not exist in the primary checkout. The reviewed post is gone.`,
      'PostMissing',
    );
  }
  const actualHash = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
  if (actualHash !== report.contentSha256) {
    throw ApplicationFailure.nonRetryable(
      `Refusing to publish: ${relPath} has changed since it was reviewed ` +
        `(reviewed ${report.contentSha256.slice(0, 12)}, on disk ${actualHash.slice(0, 12)}). ` +
        `Send \`rereview\` and approve the new report.`,
      'ContentHashMismatch',
    );
  }

  // --- Step 1: base branch --------------------------------------------------
  const repoInfo = await gh(`/repos/${GITHUB_REPO}`);
  const base: string = repoInfo.default_branch;

  await git(SITE_DIR, ['fetch', 'origin', base]);

  // --- Step 2: branch, in the WORKTREE, reset to base ----------------------
  //
  // **Design rule 3, and the first draft of this activity got it wrong.** The
  // obvious implementation commits from the primary checkout, because that is
  // where the uncommitted draft lives. It is also where the *human* lives:
  // `git checkout -B` there switches the branch under someone who may be
  // mid-edit, carrying or refusing their uncommitted work. The publish leg runs
  // unattended after an approve that could have been sent hours earlier.
  //
  // So: the worktree does the git work, and the draft's bytes are copied into it
  // from the primary checkout — exactly the overlay `syncWorktree` already does
  // for the build audit, and for the same reason (the post is usually
  // uncommitted, so HEAD's version of it is nothing at all).
  if (!(await worktreeExists(SITE_DIR, WORKTREE_DIR))) {
    await git(SITE_DIR, ['worktree', 'add', '--detach', WORKTREE_DIR, `origin/${base}`]);
  }
  await git(WORKTREE_DIR, ['fetch', 'origin', base]);
  // `-B` creates or resets. Resetting to origin/base every run is what makes a
  // re-publish produce an identical tree rather than stacking commits.
  await git(WORKTREE_DIR, ['checkout', '-B', branch, `origin/${base}`]);
  await git(WORKTREE_DIR, ['clean', '-fd', '-e', 'node_modules', '-e', 'dist']);

  // --- Step 4: the frontmatter flip ----------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const flipped = flipDraftFrontmatter(raw, today);

  const wtPath = path.join(WORKTREE_DIR, relPath);
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  await fs.writeFile(wtPath, flipped.content, 'utf8');

  // --- Step 5: commit + push -----------------------------------------------
  let committed = false;
  await git(WORKTREE_DIR, ['add', '--', relPath]);
  const staged = await git(WORKTREE_DIR, ['status', '--porcelain', '--', relPath]);
  if (staged.trim()) {
    await git(WORKTREE_DIR, ['commit', '-m', `chore(steward): publish ${report.slug}`]);
    committed = true;
  } else {
    // Not an error — this is the idempotent path. A re-approve after a park
    // finds origin/base already carrying the published post.
    log.info(
      { activity: 'publishPost', slug: report.slug, branch },
      'nothing to commit — base already carries the published post',
    );
  }
  // force-with-lease, not plain force: the branch is Steward-owned by naming
  // convention, but "owned by convention" is not "safe to clobber blindly".
  // The lease fails loudly if someone else moved it.
  await git(WORKTREE_DIR, ['push', '--force-with-lease', '-u', 'origin', branch]);

  // Detach the worktree from the branch it just pushed.
  //
  // Found by doing the dry-run teardown: git refuses to delete a branch that is
  // checked out in *any* worktree, so leaving the worktree parked on
  // `steward/publish-<slug>` makes the branch undeletable — including by the
  // human cleaning up after a merge, who gets an error naming a directory they
  // may not even know exists. Detaching costs nothing: the worktree is a
  // disposable snapshot, and the commit is already on the remote.
  await git(WORKTREE_DIR, ['checkout', '--detach']).catch(() => {});

  // --- Step 6: the PR -------------------------------------------------------
  const owner = GITHUB_REPO.split('/')[0];
  const reportPath = `agents/steward/reviews/${collection}/${report.slug}/${report.contentSha256.slice(0, 12)}.json`;
  const body = buildPrBody(report, reportPath, input.dryRun === true);
  const title = `${input.dryRun ? '[dry run] ' : ''}Publish: ${flipped.title}`;

  const existing = await gh(
    `/repos/${GITHUB_REPO}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
  );

  let prUrl: string;
  if (Array.isArray(existing) && existing.length > 0) {
    // Update rather than open a second one. This is the path a re-approve after
    // a park-on-unmerged-PR takes.
    const updated = await gh(`/repos/${GITHUB_REPO}/pulls/${existing[0].number}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, body }),
    });
    prUrl = updated.html_url;
    log.info({ activity: 'publishPost', slug: report.slug, prUrl }, 'updated existing PR');
  } else {
    const created = await gh(`/repos/${GITHUB_REPO}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, body, head: branch, base, draft: input.dryRun === true }),
    });
    prUrl = created.html_url;
    log.info({ activity: 'publishPost', slug: report.slug, prUrl }, 'opened PR');
  }

  return { branch, prUrl, title: flipped.title, committed };
}

// ---------------------------------------------------------------------------
// PR check status (Phase 2 Part A).
// ---------------------------------------------------------------------------

export type PrChecksState = 'passing' | 'pending' | 'failing';

export interface PrChecksResult {
  state: PrChecksState;
  /** Names of check runs that concluded in a failure. */
  failing: string[];
  /** Names still running or queued. */
  pending: string[];
}

/**
 * Reads the CI check runs on the publish branch's head commit.
 *
 * **Why this exists.** `verifyDeploy` polls *production* for the published URL,
 * which only becomes true after a human merges. If the PR's own CI is red the
 * merge will not happen, so every one of the ten 90-second attempts is
 * guaranteed to fail — the workflow spends fifteen minutes discovering something
 * GitHub knew in twenty seconds, and presents it as "waiting for merge" rather
 * than "your build is broken".
 *
 * That is exactly what happened on the first real publish: a corrupted
 * frontmatter flip failed the Vercel build, and the operator's experience was a
 * silent fifteen-minute wait with no indication anything was wrong. A slow
 * success and a fast failure must not look the same.
 *
 * Reports rather than throws, for the same reason `verifyDeploy` does: the
 * workflow decides what a red check means, and a GitHub API hiccup must not
 * fail a publish that has already committed and pushed.
 */
export async function checkPrChecks(branch: string): Promise<PrChecksResult> {
  try {
    const ref = await gh(`/repos/${GITHUB_REPO}/commits/${encodeURIComponent(branch)}`);
    const sha = ref?.sha;
    if (!sha) return { state: 'pending', failing: [], pending: [] };

    const runs = await gh(`/repos/${GITHUB_REPO}/commits/${sha}/check-runs?per_page=100`);
    const list: Array<{ name: string; status: string; conclusion: string | null }> =
      runs?.check_runs ?? [];

    // No check runs yet is `pending`, not `passing`: a branch pushed seconds ago
    // has not had time to report, and treating "no news" as good news would let
    // the loop sail past a failure that had not registered yet.
    if (list.length === 0) return { state: 'pending', failing: [], pending: [] };

    // `neutral` and `skipped` are deliberately NOT failures — a skipped job is a
    // configuration statement, not a defect.
    const FAIL = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);
    const failing = list.filter((r) => r.conclusion && FAIL.has(r.conclusion)).map((r) => r.name);
    const pending = list.filter((r) => r.status !== 'completed').map((r) => r.name);

    if (failing.length > 0) return { state: 'failing', failing, pending };
    if (pending.length > 0) return { state: 'pending', failing: [], pending };
    return { state: 'passing', failing: [], pending: [] };
  } catch (err) {
    // Unknown, not broken. Never let an observability call break the publish.
    log.warn({ activity: 'checkPrChecks', err: String(err) }, 'could not read PR checks');
    return { state: 'pending', failing: [], pending: [] };
  }
}
