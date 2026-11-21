import { siteAutoFix } from '../activities/findings.js';
import { parseFrontmatter } from './frontmatter.js';
import { isFindingSlug, siteConfigPath } from './findings.js';
import { normalizeShortId, type FindingRef } from './finding-ids.js';

/**
 * Which finding an id names, read from the findings repository on GitHub.
 *
 * A short id (`MP-121`) and a short title live only in a finding file's
 * frontmatter (`key_short`, `title_short`); `INDEX.md` holds neither. So a
 * lookup reads the repository's tree, one call, and then the finding files it
 * has not read yet, one blob each. Blob text is kept in this process by blob
 * sha, as the console's loader keeps it, so a later lookup reads only the files
 * that changed: about one, after a verdict.
 *
 * What a lookup costs: one tree call, plus one blob per finding file whose sha
 * is new, plus the `config.yaml` of each site a found finding is on. A lookup
 * of full keys alone reads only the files those keys name. A cold process
 * meeting its first short id reads every finding file once.
 *
 * It runs where the GitHub credential is: the `resolveFindingIds` activity on
 * the hosted worker holds one directory for the life of the process.
 */

export interface FindingEntry {
  site: string;
  key: string;
  /** `key_short` as the file spells it, normalized; null when the file has none. */
  keyShort: string | null;
  /** `title_short`, else the file's H1, else the key. */
  title: string;
  /** The site's `auto_fix` flag, from its `config.yaml`. */
  autoFix: boolean;
}

export type FindingLookup =
  | { ref: FindingRef; found: FindingEntry }
  | { ref: FindingRef; missing: true }
  | { ref: FindingRef; ambiguous: FindingEntry[] };

export interface FindingDirectorySources {
  /** `owner/name` of the findings repository. */
  repo: string;
  /** A GitHub REST GET returning parsed JSON: `gh` from `lib/github.ts`. */
  ghJson: (pathname: string) => Promise<any>;
}

export interface FindingDirectory {
  /** One answer per ref, in order. */
  lookup(refs: readonly FindingRef[]): Promise<FindingLookup[]>;
}

const BRANCH = 'main';
const PARALLEL = 8;
const FINDING_FILE = /^sites\/([^/]+)\/findings\/([^/]+)\.md$/;

interface FileRef {
  site: string;
  key: string;
  sha: string;
}

interface Meta {
  keyShort: string | null;
  title: string | null;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The short id and title of one finding file. */
export function findingMeta(fileText: string): Meta {
  const parsed = parseFrontmatter(fileText);
  const h1 = /^#\s+(.+?)\s*$/m.exec(parsed.content)?.[1] ?? null;
  const short = text(parsed.data.key_short);
  return { keyShort: short ? (normalizeShortId(short) ?? short) : null, title: text(parsed.data.title_short) ?? h1 };
}

export function createFindingDirectory(sources: FindingDirectorySources): FindingDirectory {
  /** Blob text by sha. A promise, so two readers of one blob share one call. */
  const blobs = new Map<string, Promise<string>>();
  const metas = new Map<string, Meta>();

  const readBlob = (sha: string): Promise<string> => {
    let pending = blobs.get(sha);
    if (!pending) {
      pending = sources
        .ghJson(`/repos/${sources.repo}/git/blobs/${sha}`)
        .then((blob) => Buffer.from(String(blob.content ?? ''), 'base64').toString('utf8'));
      blobs.set(sha, pending);
      // A failed read is asked again next time.
      pending.catch(() => blobs.delete(sha));
    }
    return pending;
  };

  const readTree = async (): Promise<{ files: FileRef[]; shaByPath: Map<string, string> }> => {
    const tree = await sources.ghJson(`/repos/${sources.repo}/git/trees/${BRANCH}?recursive=1`);
    if (tree.truncated === true) {
      // A cut-off tree would turn a real finding into "no such finding".
      throw new Error(`GitHub truncated the tree of ${sources.repo}; the findings cannot be listed in one call.`);
    }
    const shaByPath = new Map<string, string>();
    const files: FileRef[] = [];
    for (const entry of (tree.tree ?? []) as { path: string; type: string; sha: string }[]) {
      if (entry.type !== 'blob') continue;
      shaByPath.set(entry.path, entry.sha);
      const match = FINDING_FILE.exec(entry.path);
      // The slug check drops INDEX.md and README.md, which sit in the same folder.
      if (match && isFindingSlug(match[1]) && isFindingSlug(match[2])) files.push({ site: match[1], key: match[2], sha: entry.sha });
    }
    return { files, shaByPath };
  };

  const entries = (files: readonly FileRef[]): Promise<Omit<FindingEntry, 'autoFix'>[]> =>
    mapLimit(files, PARALLEL, async (file) => {
      let meta = metas.get(file.sha);
      if (!meta) {
        meta = findingMeta(await readBlob(file.sha));
        metas.set(file.sha, meta);
      }
      return { site: file.site, key: file.key, keyShort: meta.keyShort, title: meta.title ?? file.key };
    });

  return {
    async lookup(refs) {
      const { files, shaByPath } = await readTree();
      const named = (ref: FindingRef): FileRef[] =>
        ref.kind === 'key' ? files.filter((file) => file.key === ref.key && (!ref.site || file.site === ref.site)) : [];
      // A short id can be in any file; a full key names its own.
      const wanted = refs.some((ref) => ref.kind === 'short') ? files : [...new Set(refs.flatMap(named))];
      const known = await entries(wanted);

      // One read of a site's config per lookup, however many of its findings are named.
      const autoFixBySite = new Map<string, boolean>();
      const withAutoFix = async (entry: Omit<FindingEntry, 'autoFix'>): Promise<FindingEntry> => {
        if (!autoFixBySite.has(entry.site)) {
          const sha = shaByPath.get(siteConfigPath(entry.site));
          autoFixBySite.set(entry.site, sha ? siteAutoFix(await readBlob(sha)) : false);
        }
        return { ...entry, autoFix: autoFixBySite.get(entry.site) === true };
      };

      const out: FindingLookup[] = [];
      for (const ref of refs) {
        const matches = known.filter((entry) =>
          ref.kind === 'short' ? entry.keyShort === ref.short : entry.key === ref.key && (!ref.site || entry.site === ref.site),
        );
        if (matches.length === 0) out.push({ ref, missing: true });
        else if (matches.length === 1) out.push({ ref, found: await withAutoFix(matches[0]) });
        else out.push({ ref, ambiguous: await Promise.all(matches.map(withAutoFix)) });
      }
      return out;
    },
  };
}
