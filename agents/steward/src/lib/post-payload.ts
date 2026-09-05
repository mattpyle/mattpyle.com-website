import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultBranch, git } from './git.js';

/**
 * The set of files a post needs from outside its own markdown.
 *
 * **Why this exists.** Steward reads the draft from the author's checkout and
 * builds it in a worktree reset to a commit that has never seen it (design rule
 * 3). Until 2026-09-04 both the build-audit overlay and the publish commit
 * carried exactly one file, the markdown — so the first post with a hero image
 * failed `build_audit` (review `5372eb620069`), and a post whose review needed
 * `steward dict-add` opened a PR whose spellcheck ran against the old
 * dictionary (PR 218). Both are the same defect: anything the post needs that
 * is not the post has to travel with it.
 *
 * One resolver names that set; the overlay, the publish commit and `steward
 * cleanup` all consume it, so they cannot drift from each other.
 *
 * **Four groups**, in the order they are staged:
 *
 * | Group | What |
 * |---|---|
 * | `post` | the markdown itself |
 * | `assets` | everything under `src/assets/<collection>/<slug>/`, plus any other `src/assets/` file the post references relatively |
 * | `publicFiles` | every `public/` file the body or frontmatter names by a root-relative path |
 * | `dictionary` | `cspell.shared.yaml`, when its bytes differ from the compare ref |
 *
 * `assets` covers more than the per-slug folder on purpose: the `changelog`
 * collection files its heroes flat in `src/assets/` (`hero:
 * ../../assets/retro-mode.png`), so a folder walk alone would carry nothing for
 * a changelog entry. A relative reference is resolved and included wherever it
 * lands inside the repo.
 */

/** `key: value` at column 0, value optionally quoted.
 *
 * Copied from the site's own resolver, `scripts/lib/content-references.mjs`,
 * rather than imported: Steward imports nothing from the site's `scripts/`, and
 * a worktree being audited may be at a commit whose copy of that file differs
 * from this one. It carries the same known limit — column-0 scalars only, so a
 * sequence (`- ../../assets/x.png`) or a nested mapping value is skipped. No
 * such field exists in `src/content.config.ts` today. Keep the two in step: a
 * frontmatter shape one accepts and the other does not is a reference that
 * validates on the site and never travels with the post.
 */
const SCALAR_FIELD =
  /^([A-Za-z_][\w-]*):[ \t]+(?:"([^"]*)"|'([^']*)'|(.*?))[ \t]*(?:[ \t]#.*)?$/;

/** Markdown image. Same pattern as the frontmatter pass's `IMAGE_RE`. */
const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * `src=` / `poster=` on an MDX-style component. The one live case is the
 * `<Video src="/video/x.mp4" poster="/video/x-poster.jpg">` block in the WebMCP
 * post, whose two files live under `public/` and are named nowhere else.
 */
const MEDIA_ATTR_RE = /\b(?:src|poster)[ \t]*=[ \t]*"([^"]+)"|\b(?:src|poster)[ \t]*=[ \t]*'([^']+)'/g;

/** `./x` or `../x` — a path relative to the post, and therefore ours to resolve. */
const RELATIVE_PATH = /^\.{1,2}\//;

/**
 * A root-relative reference to a file served out of `public/`.
 *
 * The trailing extension is load-bearing. Bodies are full of root-relative
 * *links* (`[/webmcp](/webmcp/)`, `[the scorecard](/scorecard/)`) that name
 * pages, not files; without the extension test every one of them would resolve
 * to a `public/` path that does not exist.
 */
const ROOT_RELATIVE_FILE = /^\/(?!\/)[^?#]*\.[A-Za-z0-9]+$/;

/** The repo root of the shared dictionary, relative to the checkout. */
export const DICTIONARY_REL = 'cspell.shared.yaml';

/**
 * Generated every build and gitignored (`.gitignore`, `/public/og/`), so a
 * reference into it names a file that is absent from a fresh clone and rebuilt
 * before it is ever served. Carrying one into the publish commit would commit a
 * build artifact.
 */
const GENERATED_PUBLIC_PREFIX = 'public/og/';

export interface PostPayload {
  /** Repo-relative path of the post itself. */
  post: string;
  /** Repo-relative paths under `src/assets/`, sorted. */
  assets: string[];
  /** Repo-relative paths under `public/`, sorted. */
  publicFiles: string[];
  /** `cspell.shared.yaml` when it differs from the compare ref, else null. */
  dictionary: string | null;
  /** Every path above, post first — the copy list and the stage list. */
  files: string[];
}

export interface ResolveOptions {
  /**
   * The ref the dictionary is compared against. Defaults to
   * `origin/<default branch>`, falling back to `HEAD` in a checkout with no
   * `origin/HEAD` (which is what the test harness's throwaway repos are).
   */
  compareRef?: string;
}

/**
 * Thrown when the post references a file under `src/assets/` that is not on
 * disk. Distinct from a bare `Error` so `publishPost` can turn it into a
 * non-retryable failure rather than burning attempts on a missing file.
 */
export class MissingReferenceError extends Error {
  constructor(readonly reference: string, readonly resolved: string, readonly at: string) {
    super(
      `${at} references ${reference}, which resolves to ${resolved} — no such file in the ` +
        `checkout. The build would fail on it, so nothing is copied.`,
    );
    this.name = 'MissingReferenceError';
  }
}

function posix(p: string): string {
  return p.split(path.sep).join('/');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir`, repo-relative, recursively. Absent directory → none. */
async function walk(repoDir: string, relDir: string): Promise<string[]> {
  const abs = path.join(repoDir, relDir);
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(repoDir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** The frontmatter block's lines, in file order, and the body that follows it. */
function splitPost(source: string): { frontmatter: string[]; body: string } {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: [], body: source };
  return {
    frontmatter: match[1].split(/\r?\n/),
    body: source.slice(match.index! + match[0].length),
  };
}

/** Every path-shaped reference in the post, with where it was found. */
function references(source: string): Array<{ value: string; at: string }> {
  const { frontmatter, body } = splitPost(source);
  const found: Array<{ value: string; at: string }> = [];

  frontmatter.forEach((line, index) => {
    const match = SCALAR_FIELD.exec(line);
    if (!match) return;
    const [, field, doubleQuoted, singleQuoted, bare] = match;
    const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
    // +2 because line 1 of the file is the opening `---` and these are 1-based.
    found.push({ value, at: `frontmatter \`${field}\` (line ${index + 2})` });
  });

  for (const m of body.matchAll(IMAGE_RE)) found.push({ value: m[1], at: `image \`${m[1]}\`` });
  for (const m of body.matchAll(MEDIA_ATTR_RE)) {
    const value = m[1] ?? m[2];
    found.push({ value, at: `media attribute \`${value}\`` });
  }

  return found;
}

/**
 * True if the working-tree copy of `relPath` differs from `ref`'s.
 *
 * Compared through git's own blob hashes, the way `cleanup.ts` does it:
 * `hash-object` applies the checkout's line-ending and filter rules, so this
 * asks the question git will ask rather than a subtly different one about raw
 * bytes. On a CRLF checkout a raw byte comparison reports every file as changed.
 */
async function differsFrom(repoDir: string, ref: string, relPath: string): Promise<boolean> {
  try {
    const committed = await git(repoDir, ['rev-parse', `${ref}:${relPath}`]);
    const local = await git(repoDir, ['hash-object', '--', relPath]);
    return committed !== local;
  } catch {
    // The ref has no copy of the file (or no such ref). If the file is on disk
    // it is new and has to travel; if it is not, there is nothing to carry.
    return exists(path.join(repoDir, relPath));
  }
}

/**
 * The full file set for one post, as repo-relative POSIX paths.
 *
 * Throws `MissingReferenceError` for a relative reference that is not on disk.
 * A *root-relative* reference to a missing `public/` file is deliberately not
 * an error: Astro resolves and type-checks `src/assets/` references at build
 * time and fails on a broken one, but it never looks at `public/`, so a missing
 * file there builds cleanly and shows as a broken image. Making it fatal here
 * would turn `steward-smoke-test.md` — a permanent fixture that references
 * `/images/from-public.png` on purpose — from a review full of findings into a
 * crashed activity. The frontmatter pass already flags every non-`src/assets/`
 * image, which is the right place for it.
 */
export async function resolvePostPayload(
  repoDir: string,
  postRelPath: string,
  options: ResolveOptions = {},
): Promise<PostPayload> {
  const post = posix(postRelPath);
  const source = await fs.readFile(path.join(repoDir, postRelPath), 'utf8');

  // `src/content/<collection>/<slug>.md` → collection and slug.
  const segments = post.split('/');
  const collection = segments.length >= 3 ? segments[2] : 'writing';
  const slug = path.basename(post).replace(/\.[^.]+$/, '');

  const assets = new Set<string>(await walk(repoDir, `src/assets/${collection}/${slug}`));
  const publicFiles = new Set<string>();

  for (const { value, at } of references(source)) {
    if (RELATIVE_PATH.test(value)) {
      const abs = path.resolve(path.dirname(path.join(repoDir, postRelPath)), value);
      const rel = posix(path.relative(repoDir, abs));
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // Outside the repo: not ours.
      if (!(await exists(abs))) throw new MissingReferenceError(value, rel, `${post} ${at}`);
      assets.add(rel);
      continue;
    }

    if (!ROOT_RELATIVE_FILE.test(value)) continue;
    const rel = `public${value}`;
    if (rel.startsWith(GENERATED_PUBLIC_PREFIX)) continue;
    if (await exists(path.join(repoDir, rel))) publicFiles.add(rel);
  }

  let compareRef = options.compareRef;
  if (compareRef === undefined) {
    const branch = await defaultBranch(repoDir);
    compareRef = branch ? `origin/${branch}` : 'HEAD';
  }
  const dictionary = (await differsFrom(repoDir, compareRef, DICTIONARY_REL))
    ? DICTIONARY_REL
    : null;

  const sortedAssets = [...assets].sort();
  const sortedPublic = [...publicFiles].sort();

  return {
    post,
    assets: sortedAssets,
    publicFiles: sortedPublic,
    dictionary,
    files: [post, ...sortedAssets, ...sortedPublic, ...(dictionary ? [dictionary] : [])],
  };
}

/**
 * What travels with the post, for the report and the operator output. Empty
 * when the post travels alone — a note saying "0 asset files, 0 `public/`
 * files" reads as a defect report rather than as the nothing it describes.
 */
export function describePayload(payload: PostPayload): string {
  if (payload.files.length <= 1) return '';
  const parts = [
    `${payload.assets.length} asset file${payload.assets.length === 1 ? '' : 's'}`,
    `${payload.publicFiles.length} \`public/\` file${payload.publicFiles.length === 1 ? '' : 's'}`,
  ];
  if (payload.dictionary) parts.push('the shared dictionary');
  return parts.join(', ');
}
