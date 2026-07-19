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

export const GITHUB_REPO = process.env.STEWARD_GITHUB_REPO ?? 'mattpyle/mattpyle.com-website';

export const MODEL = process.env.STEWARD_MODEL ?? 'claude-sonnet-4-6';

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
export const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';

export const QUEUE_LIGHT = 'steward-light';
export const QUEUE_HEAVY = 'steward-heavy';

/**
 * The review archive — a dataset, not a scratch directory. Overridable so tests
 * that archive reports write into a temp dir instead of contaminating the real
 * one (Phase 1c: `reviews/archive-test/` was showing up as untracked junk in the
 * dataset after every test run). Production never sets this.
 */
export const REVIEWS_DIR = process.env.STEWARD_REVIEWS_DIR
  ? path.resolve(process.env.STEWARD_REVIEWS_DIR)
  : path.join(STEWARD_DIR, 'reviews');
export const CSPELL_CONFIG = path.join(STEWARD_DIR, 'cspell.config.yaml');
export const RUBRICS_DIR = path.join(STEWARD_DIR, 'src', 'rubrics');

export const WEB_UI = 'http://localhost:8233';

/**
 * Phase gates (spec §12). Every incomplete surface is off, so each phase ships
 * in a working state rather than a half-wired one.
 */
export const ENABLE_AI_TELLS = false;
export const ENABLE_BUILD_AUDIT = true;
export const ENABLE_PUBLISH_LEG = false;

/** Where a writing post lives, given a slug. Repo-relative. */
export function postRelPath(slug: string): string {
  return `src/content/writing/${slug}.md`;
}

/**
 * Resolves a `reportPath`/`latestPath` from an archive result back to an absolute
 * path. The counterpart to the relativisation in `archiveReport` — both anchor on
 * `REPO_ROOT` so archives stay readable under a redirected `SITE_DIR`.
 */
export function resolveArchivePath(relPath: string): string {
  return path.resolve(REPO_ROOT, relPath);
}

export function workflowIdFor(slug: string): string {
  return `steward-review-${slug}`;
}
