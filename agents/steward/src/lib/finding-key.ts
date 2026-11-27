/**
 * The two forms of a finding key, and the one place a command turns either into
 * the other.
 *
 * | Form | Example | What it names |
 * |---|---|---|
 * | full | `ux-more-menu-never-closes--sitewide` | the finding's file, its index line and its workflow ID |
 * | short | `MP-187` | the file's `key_short`, which a fix log entry is named after |
 *
 * A full key needs no read. A short key is not in `INDEX.md`, so it is found in
 * the frontmatter of the site's finding files, every one the index lists: the
 * scan does not stop at the first match, because two findings holding one short
 * key must be refused rather than guessed between.
 *
 * `site` is the one the command searched. Nothing in the store maps a short
 * key's prefix to a site, so the resolver does not read one into it.
 */

import { findingPath, findingsIndexPath, isFindingSlug, parseFindingsIndex } from './findings.js';
import { parseFrontmatter } from './frontmatter.js';
import { readRepoFile } from './github-contents.js';

/** The findings repository's only branch. */
const BRANCH = 'main';

/** Finding files read at once while a short key is looked up. */
const READS_AT_ONCE = 10;

/** Letters, one hyphen, digits. A full key joins its finding and its page with `--`, so it never matches. */
const SHORT_KEY = /^[a-z]+-[0-9]+$/i;

export type FindingKey = { form: 'full'; key: string } | { form: 'short'; keyShort: string };

/** What an operator typed, as one of the two forms; a short key comes back in capitals. Undefined for neither. */
export function parseFindingKey(value: string): FindingKey | undefined {
  const typed = value.trim();
  if (SHORT_KEY.test(typed)) return { form: 'short', keyShort: typed.toUpperCase() };
  return isFindingSlug(typed) ? { form: 'full', key: typed } : undefined;
}

export class FindingKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindingKeyError';
  }
}

export interface FindingKeyQuery {
  /** The findings repository. */
  repo: string;
  site: string;
  /** Either form, as typed. */
  key: string;
}

export interface ResolvedFindingKey {
  site: string;
  /** The full key. */
  key: string;
}

export interface ResolvedFinding extends ResolvedFindingKey {
  /** The short key in capitals. */
  keyShort: string;
  findingPath: string;
  /** The file's frontmatter. */
  data: Record<string, unknown>;
}

function parsed(value: string): FindingKey {
  const found = parseFindingKey(value);
  if (!found) throw new FindingKeyError(`Invalid key "${value}".`);
  return found;
}

async function readFrontmatter(repo: string, path: string): Promise<Record<string, unknown> | undefined> {
  const file = await readRepoFile(path, BRANCH, repo);
  return file ? (parseFrontmatter(file.text).data as Record<string, unknown>) : undefined;
}

function shortOf(data: Record<string, unknown>): string {
  return typeof data.key_short === 'string' ? data.key_short.toUpperCase() : '';
}

async function findByShortKey(repo: string, site: string, keyShort: string): Promise<ResolvedFinding> {
  const index = await readRepoFile(findingsIndexPath(site), BRANCH, repo);
  const keys = index ? parseFindingsIndex(index.text).map((line) => line.key) : [];
  const matches: ResolvedFinding[] = [];
  const unreadable: string[] = [];
  for (let at = 0; at < keys.length; at += READS_AT_ONCE) {
    await Promise.all(
      keys.slice(at, at + READS_AT_ONCE).map(async (key) => {
        const path = findingPath(site, key);
        let data: Record<string, unknown> | undefined;
        try {
          data = await readFrontmatter(repo, path);
        } catch (err) {
          // One file with broken YAML must not stop every other short key.
          if ((err as Error).name !== 'YAMLException') throw err;
          unreadable.push(key);
          return;
        }
        if (data && shortOf(data) === keyShort) matches.push({ site, key, keyShort, findingPath: path, data });
      }),
    );
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const named = matches.map((m) => m.key).sort().join(', ');
    throw new FindingKeyError(`${keyShort} matches ${matches.length} findings in site ${site}: ${named}. Give the full key.`);
  }
  const broken = unreadable.length > 0 ? ` Unreadable frontmatter: ${unreadable.sort().join(', ')}.` : '';
  throw new FindingKeyError(`No finding with key ${keyShort} in site ${site}.${broken} \`--site\` names another site.`);
}

/** For a command that needs the full key. A full key is returned as typed, with no read. */
export async function resolveFindingKey({ repo, site, key }: FindingKeyQuery): Promise<ResolvedFindingKey> {
  const typed = parsed(key);
  if (typed.form === 'full') return { site, key: typed.key };
  return { site, key: (await findByShortKey(repo, site, typed.keyShort)).key };
}

/** For a command that also needs the short key or the file's fields. A full key costs the one read of its file. */
export async function resolveFinding({ repo, site, key }: FindingKeyQuery): Promise<ResolvedFinding> {
  const typed = parsed(key);
  if (typed.form === 'short') return findByShortKey(repo, site, typed.keyShort);
  const path = findingPath(site, typed.key);
  const data = await readFrontmatter(repo, path);
  if (!data) throw new FindingKeyError(`No finding with key ${typed.key} in site ${site}.`);
  const keyShort = shortOf(data);
  if (!keyShort) throw new FindingKeyError(`${typed.key} in site ${site} has no key_short.`);
  return { site, key: typed.key, keyShort, findingPath: path, data };
}
