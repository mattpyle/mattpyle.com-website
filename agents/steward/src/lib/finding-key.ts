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
 * the frontmatter of the site's finding files. One GraphQL query reads the whole
 * findings folder with every file's text. Every file is matched, not only up to
 * the first hit, because two findings holding one short key must be refused
 * rather than guessed between.
 *
 * An answer that is short of a file never becomes "no finding": a file GraphQL
 * truncates or gives no text for is read on its own, and a query that fails
 * falls back to reading `INDEX.md` and then each file it lists.
 *
 * `site` is the one the command searched. Nothing in the store maps a short
 * key's prefix to a site, so the resolver does not read one into it.
 */

import { findingPath, findingsDir, findingsIndexPath, isFindingSlug, parseFindingsIndex } from './findings.js';
import { parseFrontmatter } from './frontmatter.js';
import { readRepoFile } from './github-contents.js';
import { gh } from './github.js';

/** The findings repository's only branch. */
const BRANCH = 'main';

/** Finding files read at once, for the ones the folder query did not give. */
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

function frontmatter(text: string): Record<string, unknown> {
  return parseFrontmatter(text).data as Record<string, unknown>;
}

async function readFrontmatter(repo: string, path: string): Promise<Record<string, unknown> | undefined> {
  const file = await readRepoFile(path, BRANCH, repo);
  return file ? frontmatter(file.text) : undefined;
}

function shortOf(data: Record<string, unknown>): string {
  return typeof data.key_short === 'string' ? data.key_short.toUpperCase() : '';
}

const FOLDER_QUERY =
  'query($owner: String!, $name: String!, $expression: String!) { repository(owner: $owner, name: $name) { ' +
  'object(expression: $expression) { ... on Tree { entries { name object { ... on Blob { text isTruncated } } } } } } }';

interface TreeEntry {
  name: string;
  object?: { text?: string | null; isTruncated?: boolean } | null;
}

/**
 * Every finding file of a site as full key to text, from one query; null for a
 * file whose text did not come whole. Throws when the answer is not the folder.
 */
async function readFolder(repo: string, site: string): Promise<Map<string, string | null>> {
  const [owner, name] = repo.split('/');
  const reply = await gh('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: FOLDER_QUERY, variables: { owner, name, expression: `${BRANCH}:${findingsDir(site)}` } }),
  });
  const entries: TreeEntry[] | undefined = reply.data?.repository?.object?.entries;
  if (reply.errors?.length || !Array.isArray(entries)) {
    const said = (reply.errors ?? []).map((e: { message?: string }) => e.message).join('; ');
    throw new Error(said || `no folder ${findingsDir(site)} in the answer`);
  }
  const files = new Map<string, string | null>();
  for (const entry of entries) {
    const key = entry.name.endsWith('.md') ? entry.name.slice(0, -'.md'.length) : '';
    // `INDEX.md` and anything else that is not a finding fails the slug rule.
    if (!isFindingSlug(key)) continue;
    const blob = entry.object;
    files.set(key, blob && !blob.isTruncated && typeof blob.text === 'string' ? blob.text : null);
  }
  return files;
}

/** The files the index lists, none of them read yet. */
async function listFromIndex(repo: string, site: string): Promise<Map<string, string | null>> {
  const index = await readRepoFile(findingsIndexPath(site), BRANCH, repo);
  return new Map((index ? parseFindingsIndex(index.text) : []).map((line) => [line.key, null]));
}

async function findByShortKey(repo: string, site: string, keyShort: string): Promise<ResolvedFinding> {
  let files: Map<string, string | null>;
  try {
    files = await readFolder(repo, site);
  } catch (err) {
    console.error(`  The folder query failed, so each finding file is read: ${(err as Error).message}`);
    files = await listFromIndex(repo, site);
  }
  const matches: ResolvedFinding[] = [];
  const unreadable: string[] = [];
  const match = async (key: string, text: string | null): Promise<void> => {
    const path = findingPath(site, key);
    let data: Record<string, unknown> | undefined;
    try {
      data = text === null ? await readFrontmatter(repo, path) : frontmatter(text);
    } catch (err) {
      // One file with broken YAML must not stop every other short key.
      if ((err as Error).name !== 'YAMLException') throw err;
      unreadable.push(key);
      return;
    }
    if (data && shortOf(data) === keyShort) matches.push({ site, key, keyShort, findingPath: path, data });
  };
  const all = [...files];
  for (let at = 0; at < all.length; at += READS_AT_ONCE) {
    await Promise.all(all.slice(at, at + READS_AT_ONCE).map(([key, text]) => match(key, text)));
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
