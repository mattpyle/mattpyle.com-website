import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** agents/steward */
export const STEWARD_DIR = path.resolve(here, '..');

/** The primary checkout. Overridable so tests/CI can point elsewhere. */
export const SITE_DIR = process.env.STEWARD_SITE_DIR
  ? path.resolve(process.env.STEWARD_SITE_DIR)
  : path.resolve(STEWARD_DIR, '..', '..');

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

export const REVIEWS_DIR = path.join(STEWARD_DIR, 'reviews');
export const CSPELL_CONFIG = path.join(STEWARD_DIR, 'cspell.config.yaml');
export const RUBRICS_DIR = path.join(STEWARD_DIR, 'src', 'rubrics');

export const WEB_UI = 'http://localhost:8233';

/**
 * Phase gates (spec §12). Every incomplete surface is off, so each phase ships
 * in a working state rather than a half-wired one.
 */
export const ENABLE_AI_TELLS = false;
export const ENABLE_BUILD_AUDIT = false;
export const ENABLE_PUBLISH_LEG = false;

/** Where a writing post lives, given a slug. Repo-relative. */
export function postRelPath(slug: string): string {
  return `src/content/writing/${slug}.md`;
}

export function workflowIdFor(slug: string): string {
  return `steward-review-${slug}`;
}
