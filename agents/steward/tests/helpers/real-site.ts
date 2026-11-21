/**
 * The one door to the site's real `src/content/` and `src/data/`.
 *
 * A test that reads those folders must be named in `SITE_READERS` in
 * `scripts/select-steward-tests.mjs`: CI runs only the listed tests when a pull request
 * changes content or data. This module throws on import for a test that is not listed,
 * and `realSitePath` throws for a folder the test's entry does not name, so a reader
 * cannot be left off the list without a red test.
 *
 * `useRealSite()` points `SITE_DIR` at the checkout for Steward source that reads
 * through it. Call it before anything imports `src/config.ts`, which resolves `SITE_DIR`
 * once; in a test process the default is an empty directory (`src/lib/site-dir.ts`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STEWARD_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** The repository root: the real checkout this test file sits in. */
export const REAL_SITE_DIR = path.resolve(STEWARD_DIR, '..', '..');

// Through a URL, not a literal specifier: the script is plain JavaScript outside this
// workspace, and a literal makes `tsc --noEmit` fail with TS7016.
const script = new URL('../../../../scripts/select-steward-tests.mjs', import.meta.url).href;
const { SITE_READERS } = (await import(script)) as { SITE_READERS: Record<string, string[]> };

const caller = path.relative(STEWARD_DIR, path.resolve(process.argv[1] ?? '')).split(path.sep).join('/');
const folders = SITE_READERS[caller];
if (!folders) {
  throw new Error(
    `${caller} reads the site's real content or data but is not in SITE_READERS. ` +
      `Add it to SITE_READERS in scripts/select-steward-tests.mjs, with the folders it reads ` +
      `(src/content/, src/data/), so that a pull request that changes them runs it.`,
  );
}

function assertListed(folder: string): void {
  if (folders.includes(folder)) return;
  throw new Error(
    `${caller} reads ${folder} but its SITE_READERS entry names only ${folders.join(', ')}. ` +
      `Add '${folder}' to its entry in SITE_READERS in scripts/select-steward-tests.mjs.`,
  );
}

/** The absolute path of a file or folder under the real `src/content/` or `src/data/`. */
export function realSitePath(relPath: string): string {
  const folder = ['src/content/', 'src/data/'].find((f) => `${relPath}/`.startsWith(f));
  if (!folder) throw new Error(`realSitePath serves src/content/ and src/data/ only, not ${relPath}`);
  assertListed(folder);
  return path.join(REAL_SITE_DIR, relPath);
}

/** Points `SITE_DIR` at the real checkout, for source that reads posts through it. */
export function useRealSite(): string {
  assertListed('src/content/');
  process.env.STEWARD_SITE_DIR = REAL_SITE_DIR;
  return REAL_SITE_DIR;
}
