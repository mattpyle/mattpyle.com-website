import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** agents/steward */
export const STEWARD_DIR = path.resolve(here, '..');

/**
 * Loads `agents/steward/.env` into `process.env`.
 *
 * Hand-rolled rather than pulling in `dotenv`: the file holds a handful of
 * `KEY=value` lines and the parsing rules that matter here fit in ten lines.
 *
 * **Already-set variables always win.** An explicit `ANTHROPIC_API_KEY=... npm
 * run …` or a CI secret must not be silently overridden by a stale local file —
 * that failure mode is invisible and sends requests under the wrong credential.
 *
 * Values are never logged. The file is gitignored (`.gitignore`), and nothing in
 * the Steward puts a secret into a workflow input or result, where Temporal
 * would persist it in history (spec §13).
 */
function loadDotEnv(): void {
  const envPath = path.join(STEWARD_DIR, '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // No .env is fine — the real environment may already carry the vars.
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

/**
 * The real checkout containing `agents/steward`, derived from this file's own
 * location and therefore **never** affected by `STEWARD_SITE_DIR`.
 *
 * The Steward's own artifacts — `reviews/`, caches, the Vale binary — always live
 * under `STEWARD_DIR`, no matter which content tree is being reviewed. Anchoring
 * their paths here rather than on `SITE_DIR` is what keeps them findable when the
 * site root is redirected (Phase 1b shipped a `readArchivedReport` that joined an
 * archive path onto `SITE_DIR` and silently rendered no findings under
 * redirection — that coupling is the bug this constant exists to prevent).
 */
export const REPO_ROOT = path.resolve(STEWARD_DIR, '..', '..');

/** The content tree under review. Overridable so tests/CI can point elsewhere. */
export const SITE_DIR = process.env.STEWARD_SITE_DIR
  ? path.resolve(process.env.STEWARD_SITE_DIR)
  : REPO_ROOT;

export const WORKTREE_DIR =
  process.env.STEWARD_WORKTREE_DIR ??
  path.resolve(SITE_DIR, '..', 'mattpyle.com-steward-worktree');

export const PROD_ORIGIN = process.env.STEWARD_PROD_ORIGIN ?? 'https://www.mattpyle.com';

/**
 * The sitemap URL `resolveAuditUrls` fetches at run time (scorecard-audit-spec.md
 * §5.4). **Not** a canonical page list — the sitemap itself is the source of
 * truth for "what pages are live". This constant is a CLI-resolved default,
 * consumed by the workflow only via the input (design rule 3): a decision the
 * workflow re-read from here at replay would rewrite the past for any run
 * still in flight.
 */
export const SITEMAP_URL = `${PROD_ORIGIN}/sitemap-index.xml`;

/**
 * Used only for `--urls` overrides and offline tests — never a fallback the
 * workflow reaches for on its own. The live audit set always comes from the
 * sitemap; this exists so a manual run or a test can skip the network fetch.
 */
export const SCORECARD_URLS_FALLBACK = [
  '/',
  '/about',
  '/writing',
  '/builds',
  '/changelog',
  '/scorecard',
] as const;

/** Default staleness threshold for the publish gate (spec §6), CLI-overridable via `--max-age-days`. */
export const SCORECARD_MAX_AGE_DAYS_DEFAULT = 7;

/**
 * The IANA timezone a scorecard run's calendar date (`iso`) is computed in
 * (spec §5.1). Matt is based in the Pacific timezone, so a run kicked off
 * after ~5pm Pacific dates itself the *next* UTC calendar day if left to
 * `new Date().toISOString()` — this is the fix for that. Resolved once, in
 * `resolveRunStamp`, an activity (not read inline in the workflow) so the
 * result is durable in history and replay-safe.
 */
export const STEWARD_TIMEZONE = process.env.STEWARD_TIMEZONE ?? 'America/Vancouver';

/** Repo-relative path to the public run-log (spec §5.1). */
export const SCORECARD_RUNS_PATH = 'src/data/scorecard-runs.json';

export const GITHUB_REPO = process.env.STEWARD_GITHUB_REPO ?? 'mattpyle/mattpyle.com-website';

export const MODEL = process.env.STEWARD_MODEL ?? 'claude-sonnet-4-6';

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
export const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';

export const QUEUE_LIGHT = 'steward-light';
export const QUEUE_HEAVY = 'steward-heavy';

/**
 * The exact line the worker logs once both queues are polling. `steward up`
 * health-gates on this string (lib/stack.ts), so the worker and the stack share
 * this one constant — a reworded log line can no longer silently break startup.
 */
export const WORKER_READY_LOG = 'steward worker polling';

/**
 * The review archive — a dataset, not a scratch directory. Overridable so tests
 * that archive reports write into a temp dir instead of contaminating the real
 * one (Phase 1c: `reviews/archive-test/` was showing up as untracked junk in the
 * dataset after every test run). Production never sets this.
 */
export const REVIEWS_DIR = process.env.STEWARD_REVIEWS_DIR
  ? path.resolve(process.env.STEWARD_REVIEWS_DIR)
  : path.join(STEWARD_DIR, 'reviews');

/**
 * Where full per-run Scorecard records (including per-page raw scores) are
 * archived (spec §5.2) — a sibling of the review archive, same dataset
 * convention: committed on purpose, not scratch (spec §11).
 */
export const SCORECARD_ARCHIVE_DIR = path.join(REVIEWS_DIR, '_scorecard');

/**
 * The shared spelling dictionary, at the REPO ROOT — not under `agents/steward`.
 *
 * One file, two consumers: this activity and the site's `npm run spellcheck`
 * (which reaches it via `import` in `cspell.json`). It moved out of the Steward
 * workspace in Phase 2 Part A, when the publish leg made a divergence between
 * the two dictionaries able to publish a post the site's own CI marks red.
 *
 * **Read directly, not via `import:`.** `readConfigFile` does NOT resolve
 * cspell's `import` key — a config that imports its wordlist comes back with
 * `words: undefined`. Pointing this at a thin config that imports the shared
 * file would empty the Steward's dictionary. Verified empirically; it is why
 * the shared file holds the words inline and this constant names it directly.
 */
export const CSPELL_CONFIG = path.join(REPO_ROOT, 'cspell.shared.yaml');
export const RUBRICS_DIR = path.join(STEWARD_DIR, 'src', 'rubrics');

export const WEB_UI = 'http://localhost:8233';

/**
 * Phase gates (spec §12). Every incomplete surface is off, so each phase ships
 * in a working state rather than a half-wired one.
 */
export const ENABLE_AI_TELLS = false;
export const ENABLE_BUILD_AUDIT = true;
/**
 * Phase 2. Resolved by the CLI into the `approve` **signal payload**, not into
 * the workflow input — the publish decision is consumed after the durable wait,
 * so for an already-parked review the input is immutable and the decision has
 * not yet been made. See the `approve` signal's docblock in
 * `workflows/review-post.ts` for the full reasoning.
 */
export const ENABLE_PUBLISH_LEG = process.env.STEWARD_ENABLE_PUBLISH_LEG === 'false' ? false : true;

/**
 * The content collections the Steward reviews.
 *
 * `builds` is deliberately absent. It has no `draft` field in
 * `src/content.config.ts` at all, so neither the gate-mode draft refusal nor the
 * `SHOW_DRAFTS` build has any meaning for it — it is out of scope until someone
 * decides what reviewing a build entry would even mean.
 */
export const COLLECTIONS = ['writing', 'changelog'] as const;
export type Collection = (typeof COLLECTIONS)[number];

export function isCollection(v: string): v is Collection {
  return (COLLECTIONS as readonly string[]).includes(v);
}

/**
 * Where a post lives, given a slug. Repo-relative.
 *
 * The collection name is both the content directory and the URL segment for
 * both current collections (`src/content/writing/` → `/writing/<slug>/`), but
 * that is a coincidence of naming rather than a guarantee, which is why
 * `urlPathFor` exists separately instead of callers reusing this.
 */
export function postRelPath(slug: string, collection: Collection = 'writing'): string {
  return `src/content/${collection}/${slug}.md`;
}

/** The site URL path a collection's entry renders at. Trailing slash included. */
export function urlPathFor(slug: string, collection: Collection = 'writing'): string {
  return `/${collection}/${slug}/`;
}

/**
 * Resolves a `reportPath`/`latestPath` from an archive result back to an absolute
 * path. The counterpart to the relativisation in `archiveReport` — both anchor on
 * `REPO_ROOT` so archives stay readable under a redirected `SITE_DIR`.
 */
export function resolveArchivePath(relPath: string): string {
  return path.resolve(REPO_ROOT, relPath);
}

/**
 * The workflow ID for a review.
 *
 * **`writing` keeps the bare `steward-review-<slug>` form on purpose.** Adding
 * the collection unconditionally would have been tidier, and would also have
 * orphaned every review parked under the old scheme — including the live
 * `steward-review-hello-world` execution this session was written alongside.
 * A workflow ID is not an implementation detail once a workflow is running under
 * it; it is the only handle the CLI has. Non-default collections get the
 * qualified form, so a `changelog` and a `writing` entry sharing a slug cannot
 * collide.
 */
export function workflowIdFor(slug: string, collection: Collection = 'writing'): string {
  return collection === 'writing'
    ? `steward-review-${slug}`
    : `steward-review-${collection}-${slug}`;
}

/**
 * Inverse of `workflowIdFor`. Only for read-only tooling that *discovers*
 * workflow IDs from Temporal's visibility store (`steward inbox`, which lists
 * open workflows rather than being told a slug directly) — everywhere else in
 * the CLI goes slug -> id via `workflowIdFor`, never the other way.
 *
 * Assumes no slug for the default `writing` collection begins with another
 * collection's `<collection>-` prefix; true today with `COLLECTIONS =
 * ['writing', 'changelog']` and cheap to revisit if that stops holding.
 */
export function parseWorkflowId(workflowId: string): { slug: string; collection: Collection } {
  const rest = workflowId.replace(/^steward-review-/, '');
  for (const collection of COLLECTIONS) {
    if (collection === 'writing') continue;
    const prefix = `${collection}-`;
    if (rest.startsWith(prefix)) return { slug: rest.slice(prefix.length), collection };
  }
  return { slug: rest, collection: 'writing' };
}
