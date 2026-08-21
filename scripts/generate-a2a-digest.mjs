/**
 * Compile the digest the /a2a responder answers from.
 *
 * Runs in `prebuild` (and `predev`) and writes src/data/a2a-digest.json, which src/pages/a2a.ts
 * imports statically. The responder therefore does no I/O at request time: no fetch, no content
 * collection read, nothing that can be slow or down when an agent calls.
 *
 * WHY BUILD TIME. The site redeploys on every merge, so a build-time digest is within one deploy
 * of live anyway, and in exchange the responder is deterministic, dependency-free, and testable
 * as a pure function of this file's output. The alternative (reading astro:content per request)
 * buys freshness the site does not have and costs all three.
 *
 * The generated file is committed rather than gitignored, deliberately: it is small, it is the
 * exact payload a reviewer needs to see to know what the responder will say, and a diff on it is
 * the review signal when content changes what an agent gets told.
 *
 * Ordering note: the changelog is sorted by the real compareChangelogEntries from
 * src/lib/changelog-order.ts, the same function every page and generator uses, imported straight
 * from TypeScript on Node's type stripping. It used to be transcribed here because a plain node
 * script could not import a .ts file; PR #97 moved every environment to Node 24 and that
 * constraint went with it. Changelog rows are therefore built collection-shaped, sorted, and only
 * then projected to digest rows, so the comparator sees the shape it is written against.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCollection } from './lib/content-frontmatter.mjs';
import { compareChangelogEntries } from '../src/lib/changelog-order.ts';
import { SITE_ORIGIN } from '../src/data/site-origin.mjs';
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  sitePerson,
  siteSections,
} from '../src/data/site-sections.mjs';

const CONTENT = fileURLToPath(new URL('../src/content/', import.meta.url));
export const DIGEST_PATH = fileURLToPath(new URL('../src/data/a2a-digest.json', import.meta.url));

/** How many changelog entries the responder can cite. The rest are one link away. */
const CHANGELOG_LIMIT = 10;

/** @param {string} value @param {string} where */
function requireString(value, where) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${where}: expected a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** A frontmatter date (`2026-07-13`, or a full timestamp) as an ISO string. */
function isoDate(value, where) {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00.000Z` : String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`${where}: unparseable date ${JSON.stringify(value)}`);
  return date.toISOString();
}

/**
 * Build the digest object.
 *
 * @param {string} [base] Origin with no trailing slash. Defaults to the canonical site origin.
 * @param {string} [contentDir]
 */
export function buildDigest(base = SITE_ORIGIN, contentDir = CONTENT) {
  const writing = readCollection(`${contentDir}writing`)
    // draft: true keeps a post out of every public surface, and this is one.
    .filter(({ data }) => data.draft !== true)
    .map(({ slug, data }) => ({
      title: requireString(data.title, `writing/${slug} title`),
      url: `${base}/writing/${slug}`,
      markdownUrl: `${base}/writing/${slug}.md`,
      date: isoDate(data.date, `writing/${slug} date`),
      ...(data.updated ? { updated: isoDate(data.updated, `writing/${slug} updated`) } : {}),
      tags: data.tags ?? [],
      description: requireString(data.description, `writing/${slug} description`),
    }))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const projects = readCollection(`${contentDir}projects`)
    .map(({ slug, data }) => ({
      title: requireString(data.title, `projects/${slug} title`),
      // Projects have no per-entry route; src/pages/projects/ is an index page only.
      url: `${base}/projects`,
      date: isoDate(data.date, `projects/${slug} date`),
      status: requireString(data.status, `projects/${slug} status`),
      tags: data.tags ?? [],
      description: requireString(data.description, `projects/${slug} description`),
      ...(data.github ? { github: data.github } : {}),
      ...(data.live ? { live: data.live } : {}),
    }))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  // Collection-shaped first, because that is the shape compareChangelogEntries is written
  // against. Projecting to digest rows after the sort keeps the adapter out of the comparator.
  const allChangelog = readCollection(`${contentDir}changelog`)
    .filter(({ data }) => data.draft !== true)
    .map(({ slug, data }) => ({
      id: slug,
      data: {
        title: requireString(data.title, `changelog/${slug} title`),
        date: new Date(isoDate(data.date, `changelog/${slug} date`)),
        ...(data.publishedAt
          ? { publishedAt: new Date(isoDate(data.publishedAt, `changelog/${slug} publishedAt`)) }
          : {}),
        type: requireString(data.type, `changelog/${slug} type`),
        significance: requireString(data.significance, `changelog/${slug} significance`),
        tags: data.tags ?? [],
        summary: requireString(data.summary, `changelog/${slug} summary`),
      },
    }))
    .sort(compareChangelogEntries)
    .map(({ id, data }) => ({
      slug: id,
      title: data.title,
      url: `${base}/changelog/${id}`,
      date: data.date.toISOString(),
      ...(data.publishedAt ? { publishedAt: data.publishedAt.toISOString() } : {}),
      type: data.type,
      significance: data.significance,
      tags: data.tags,
      summary: data.summary,
    }));

  return {
    // No `generated` timestamp. The digest is committed, so a wall-clock field would make every
    // build a diff and tell a reader nothing the content dates do not already say.
    site: {
      name: SITE_NAME,
      url: `${base}/`,
      description: SITE_DESCRIPTION,
      person: sitePerson(base),
      sections: siteSections(base),
    },
    // What this site hands to agents, which is the question the skill exists to answer.
    surfaces: [
      {
        name: 'agents.md',
        url: `${base}/agents.md`,
        description: 'Plain-language brief for agents reading, summarising, or citing the site.',
      },
      {
        name: 'llms.txt',
        url: `${base}/llms.txt`,
        description: 'Concise markdown index of every page and machine-readable resource.',
      },
      {
        name: 'llms-full.txt',
        url: `${base}/llms-full.txt`,
        description: 'Full plain-text export of all published content plus the scorecard snapshot.',
      },
      {
        name: 'Raw markdown per entry',
        url: `${base}/writing/`,
        description:
          'Every article and changelog entry has a .md sibling, and the canonical URL serves markdown to an Accept: text/markdown request that genuinely prefers it.',
      },
      {
        name: 'WebMCP tools',
        url: `${base}/webmcp`,
        description:
          'Six tools registered on document.modelContext for in-browser agents, four read and two write. Callable only from a browser that implements WebMCP; the definitions are at /webmcp/tools.json and the data they read is at /webmcp/index.json.',
      },
      {
        name: 'A2A Agent Card',
        url: `${base}/.well-known/agent-card.json`,
        description: 'This agent, described for A2A clients.',
      },
      {
        name: 'A2A endpoint',
        url: `${base}/a2a`,
        description: 'This endpoint. JSON-RPC 2.0, SendMessage only.',
      },
      {
        name: 'Sitemap',
        url: `${base}/sitemap-index.xml`,
        description: 'Every published URL, with lastmod.',
      },
    ],
    writing,
    projects,
    changelog: allChangelog.slice(0, CHANGELOG_LIMIT),
    counts: {
      writing: writing.length,
      projects: projects.length,
      // Both, so a reply that lists a truncated slice can say what it truncated.
      changelog: allChangelog.length,
      changelogListed: Math.min(allChangelog.length, CHANGELOG_LIMIT),
    },
  };
}

/** Write the digest, returning true when the bytes on disk changed. */
export function writeDigest(path = DIGEST_PATH) {
  const next = `${JSON.stringify(buildDigest(), null, 2)}\n`;
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // First run.
  }
  if (current === next) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, 'utf8');
  return true;
}

// The build targets Node 24, so import.meta.main is available; this spelling is kept because it
// also works under any older Node someone runs the script with by hand.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const changed = writeDigest();
  console.log(`[a2a-digest] ${changed ? 'wrote' : 'unchanged'} src/data/a2a-digest.json`);
}
