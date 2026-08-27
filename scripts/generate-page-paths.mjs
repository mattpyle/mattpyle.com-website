/**
 * Compile the list of page paths the hit counter is allowed to name.
 *
 * Runs in `prebuild` (and `predev`) and writes src/data/page-paths.mjs, which
 * src/lib/agent-hits.mjs imports statically and the middleware bundle therefore carries.
 *
 * WHY THIS EXISTS. The `page` event class counts a bot fetching an ordinary HTML page, and the
 * middleware learns nothing about the response: `next()` hands the request to the routing layer
 * and never sees its status. Without a list, `GET /writing/anything-at-all/` with a spoofed
 * crawler user agent would mint a counter key, and the module's bounded-cardinality promise
 * (src/lib/agent-hits.mjs, property 2) would be a promise about well-behaved clients rather than
 * a structural one. The other two classes get their bound for free — a surface path is one of a
 * fixed list, and a markdown serve is only counted once the sibling fetch came back 200 — so this
 * class is the first one that has to be given a bound rather than inheriting one.
 *
 * The list is the whole bound: a path on it is counted by name, and everything else buckets into
 * UNNAMED_PAGE. A stale list therefore costs resolution and never correctness — a post published
 * since the last build reads as `/*` until the next one, which is the same fail-soft direction
 * everything else in that module leans.
 *
 * DRAFTS ARE EXCLUDED, and that is not only a routing detail: this file is committed and rides
 * into the client-visible middleware bundle, so a draft slug here would publish the existence of
 * an unpublished post. `draft: true` already keeps an entry out of getStaticPaths, so a draft has
 * no page to count either way.
 *
 * The generated file is committed rather than gitignored, for the same reasons
 * src/data/a2a-digest.json is: it is small, a reviewer can see exactly what the counter will be
 * able to name, and a diff on it is the review signal when the route set changes. It is committed
 * for one further reason the digest does not have — the platform bundles middleware.ts from the
 * repository, and this module has to be importable whether or not the build command has run yet.
 *
 * NO TOP-LEVEL SIDE EFFECTS beyond the write at the foot of the file, which only runs when this
 * script is the entry point, so tests/page-paths.test.mjs can import the builder.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCollection } from './lib/content-frontmatter.mjs';

const PAGES_DIR = fileURLToPath(new URL('../src/pages/', import.meta.url));
const CONTENT_DIR = fileURLToPath(new URL('../src/content/', import.meta.url));
export const PAGE_PATHS_FILE = fileURLToPath(new URL('../src/data/page-paths.mjs', import.meta.url));

/**
 * Entries per changelog ledger page.
 *
 * Transcribed from PAGE_SIZE in src/pages/changelog/[...page].astro, which defines it inside
 * getStaticPaths because Astro runs that in an isolated scope. Two copies of one number is worse
 * than one, so pageCount() below is asserted against the real pager in tests/page-paths.test.mjs;
 * a change to either without the other fails there rather than silently shortening this list.
 */
const CHANGELOG_PAGE_SIZE = 20;

/** Every `.astro` file under src/pages, recursively, sorted for stable output. */
function pageFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return pageFiles(path);
      return entry.isFile() && entry.name.endsWith('.astro') ? [path] : [];
    })
    .sort();
}

/**
 * The static page routes, derived from the file names rather than listed.
 *
 * A file whose path carries a `[` is a dynamic route and is skipped here: its paths come from the
 * collections below, which is the only place that knows which slugs exist. `index.astro` drops its
 * last segment, so src/pages/writing/index.astro is `/writing` and src/pages/index.astro is `/`.
 *
 * Paths are canonicalised the way counterPath() canonicalises them: no trailing slash, except the
 * root, which is `/`.
 *
 * @returns {string[]}
 */
export function staticPagePaths() {
  const paths = [];
  for (const file of pageFiles(PAGES_DIR)) {
    const route = relative(PAGES_DIR, file).split(sep).join('/').replace(/\.astro$/, '');
    if (route.includes('[')) continue;
    const trimmed = route.replace(/(^|\/)index$/, '');
    paths.push(trimmed === '' ? '/' : `/${trimmed}`);
  }
  return paths;
}

/** How many ledger pages a changelog of this size paginates into. @param {number} entries */
export function pageCount(entries) {
  return Math.max(1, Math.ceil(entries / CHANGELOG_PAGE_SIZE));
}

/** Published entries of a collection, drafts dropped. @param {string} collection */
function publishedSlugs(collection) {
  return readCollection(join(CONTENT_DIR, collection))
    .filter(({ data }) => data.draft !== true)
    .map(({ slug }) => slug);
}

/**
 * Every page path the site publishes, sorted and deduplicated.
 *
 * `/projects/<slug>` is deliberately absent: the projects collection renders as cards on
 * src/pages/projects/index.astro and has no per-entry route to fetch. If one is ever added, this
 * function is where it joins the list.
 *
 * @returns {string[]}
 */
export function buildPagePaths() {
  const paths = new Set(staticPagePaths());

  // The changelog's page 1 is `/changelog` (the rest parameter is undefined there), which the
  // static pass above cannot see because the file is `[...page].astro`.
  paths.add('/changelog');

  for (const slug of publishedSlugs('writing')) paths.add(`/writing/${slug}`);

  const changelog = publishedSlugs('changelog');
  for (const slug of changelog) paths.add(`/changelog/${slug}`);
  for (let page = 2; page <= pageCount(changelog.length); page += 1) paths.add(`/changelog/${page}`);

  return [...paths].sort();
}

/** The generated module's source. @param {string[]} paths */
export function renderModule(paths) {
  return `// GENERATED BY scripts/generate-page-paths.mjs — DO NOT EDIT BY HAND.
//
// Every page path this site publishes, canonicalised the way src/lib/agent-hits.mjs canonicalises
// one: no trailing slash, and the root as "/". It is the bound on the \`page\` event class's key
// space — a path here is counted by name, anything else buckets — so a hand edit is a hand edit to
// what a stranger can write into the store. Regenerate instead: \`npm run prebuild\`.
//
// Why it exists at all, and why drafts are not in it: the docblock in the generator.

export const PAGE_PATHS = [
${paths.map((path) => `  '${path}',`).join('\n')}
];
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const source = renderModule(buildPagePaths());
  const existing = (() => {
    try {
      return readFileSync(PAGE_PATHS_FILE, 'utf8');
    } catch {
      return null;
    }
  })();
  // Written only when it changed, so a build does not touch the file's mtime on every run.
  if (source !== existing) writeFileSync(PAGE_PATHS_FILE, source);
}
