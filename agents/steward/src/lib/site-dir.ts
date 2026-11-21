/**
 * Where `SITE_DIR`, the content tree under review, points.
 *
 * 1. `STEWARD_SITE_DIR`, when set, always wins.
 * 2. In a test process with none set, an empty directory, never the checkout.
 * 3. In every other process, the repository root.
 *
 * Why rule 2. CI runs only the Steward tests that read the site's real `src/content/`
 * or `src/data/` when a pull request changes those folders; `SITE_READERS` in
 * `scripts/select-steward-tests.mjs` is that list. A test that reached the real posts
 * through a default `SITE_DIR` would depend on them without being on the list, and a
 * content change would then skip it. With an empty default such a test fails on the
 * pull request that adds it, and the fix is to take the real root from
 * `tests/helpers/real-site.ts`, which checks the list.
 *
 * The test process is detected by `isTestProcess`, the same signals the credential guard
 * uses, so the CLI, both workers and the console keep the repository root in any process
 * a test did not start. `tests/lib/site-dir.test.ts` pins each start shape.
 */
import os from 'node:os';
import path from 'node:path';
import { isTestProcess, type ProcessShape } from './test-credential-guard.js';

/** The empty stand-in for the content tree in a test process. `config.ts` creates it. */
export const NO_SITE_DIR = path.join(os.tmpdir(), 'steward-no-site');

export function resolveSiteDir(repoRoot: string, p: ProcessShape = process): string {
  const explicit = p.env.STEWARD_SITE_DIR;
  if (explicit) return path.resolve(explicit);
  return isTestProcess(p) ? NO_SITE_DIR : repoRoot;
}
