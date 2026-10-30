import fs from 'node:fs';
import path from 'node:path';

/**
 * What is installed against what the lockfile asks for, read off the install
 * itself.
 *
 * `steward update` used to run `npm ci` only when `package-lock.json` differed
 * between the commits on either side of its own pull. A checkout moved forward
 * by any other `git pull` kept a stale `node_modules`: on 2026-10-29 the laptop
 * ran Lighthouse 13.4.1 against the locked 13.5.0 and scored Agentic Browsing
 * 5/5 where the hosted worker scores 6/6. Both workers poll `steward-audit`, so
 * the public scorecard moved with whichever worker took the task.
 *
 * Two checks, both pure over parsed JSON so a test needs no filesystem:
 *
 * 1. {@link installStaleReason}: the `packages` entries of
 *    `node_modules/.package-lock.json` (npm's record of what it installed) against
 *    those of `package-lock.json`. Parsed JSON, not bytes, so line endings and key
 *    order do not count.
 * 2. {@link lighthouseMismatch}: the version in `node_modules/lighthouse` against
 *    the locked one. Both workers run it before they poll.
 */

type PackageMap = Record<string, unknown>;

/** Reasons are written to be read in the `steward update` log. */
export function installStaleReason(
  installed: { packages?: PackageMap } | null,
  locked: { packages?: PackageMap },
): string | null {
  if (!installed) return 'node_modules/.package-lock.json is missing';
  const want = locked.packages ?? {};
  const have = installed.packages ?? {};
  // `.package-lock.json` omits the root entry and any workspace link npm does not
  // install into node_modules, so compare only the entries it can hold.
  const names = Object.keys(want).filter((n) => n !== '' && n.startsWith('node_modules/'));
  for (const name of names) {
    // npm skips a locked optional package its platform cannot use (125 of them on
    // Windows, such as `@astrojs/compiler-binding-android-arm64`), so an absent
    // optional entry is how a good install looks.
    if (!(name in have)) {
      if ((want[name] as { optional?: boolean } | undefined)?.optional === true) continue;
      return `${name} is locked but not installed`;
    }
    const a = (want[name] as { version?: string } | undefined)?.version;
    const b = (have[name] as { version?: string } | undefined)?.version;
    if (a !== b) return `${name} is installed at ${b ?? 'no version'}, locked at ${a ?? 'no version'}`;
  }
  for (const name of Object.keys(have)) {
    if (name.startsWith('node_modules/') && !(name in want)) return `${name} is installed but not locked`;
  }
  return null;
}

export interface LighthouseMismatch {
  installed: string;
  locked: string;
}

/** Null when the two versions agree. A missing install reads as `not installed`. */
export function lighthouseMismatch(installed: string | null, locked: string | null): LighthouseMismatch | null {
  if (installed !== null && installed === locked) return null;
  return { installed: installed ?? 'not installed', locked: locked ?? 'not locked' };
}

export function lighthouseMismatchMessage(m: LighthouseMismatch): string {
  return (
    `Lighthouse ${m.installed} is installed but package-lock.json locks ${m.locked}. ` +
    'A worker on a different Lighthouse scores differently from the other worker on the same queue. ' +
    'Run `npm ci` at the repository root, then start the worker again.'
  );
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Null when the install matches the lockfile; otherwise why not. Reads `root`. */
export function readInstallStaleReason(root: string): string | null {
  const locked = readJson<{ packages?: PackageMap }>(path.join(root, 'package-lock.json'));
  if (!locked) return 'package-lock.json could not be read';
  const installed = readJson<{ packages?: PackageMap }>(path.join(root, 'node_modules', '.package-lock.json'));
  return installStaleReason(installed, locked);
}

/** The installed and locked Lighthouse versions under `root`. */
export function readLighthouseVersions(root: string): { installed: string | null; locked: string | null } {
  const installed = readJson<{ version?: string }>(path.join(root, 'node_modules', 'lighthouse', 'package.json'));
  const locked = readJson<{ packages?: Record<string, { version?: string }> }>(path.join(root, 'package-lock.json'));
  return {
    installed: installed?.version ?? null,
    locked: locked?.packages?.['node_modules/lighthouse']?.version ?? null,
  };
}

/**
 * The startup guard both workers call before they poll. Returns the installed
 * version for the ready line; throws with both versions and the fix on a mismatch.
 */
export function assertLighthouseMatchesLock(root: string): string {
  const { installed, locked } = readLighthouseVersions(root);
  const m = lighthouseMismatch(installed, locked);
  if (m) throw new Error(lighthouseMismatchMessage(m));
  return installed as string;
}
