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
 * Ordering note: the changelog comparator below is a transcription of
 * compareChangelogEntries in src/lib/changelog-order.ts, which this script cannot import (it is
 * TypeScript, and this script stays plain ESM rather than leaning on Node's type stripping).
 * tests/a2a-digest.test.mjs runs the real comparator over the same entries and asserts the two
 * agree, so a change there fails here rather than silently reordering what an agent is told
 * shipped most recently.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCollection } from './lib/content-frontmatter.mjs';
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

const SIGNIFICANCE_PRIORITY = { major: 0, minor: 1, patch: 2 };

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

/** Transcription of compareChangelogEntries; see the file header. */
function compareChangelog(a, b) {
  const dateDifference = Date.parse(b.date) - Date.parse(a.date);
  if (dateDifference !== 0) return dateDifference;

  const aPublished = a.publishedAt ? Date.parse(a.publishedAt) : undefined;
  const bPublished = b.publishedAt ? Date.parse(b.publishedAt) : undefined;
  if (aPublished !== undefined && bPublished !== undefined) {
    const publishedDifference = bPublished - aPublished;
    if (publishedDifference !== 0) return publishedDifference;
  } else if (aPublished !== undefined) {
    return -1;
  } else if (bPublished !== undefined) {
    return 1;
  }

  const significanceDifference =
    SIGNIFICANCE_PRIORITY[a.significance] - SIGNIFICANCE_PRIORITY[b.significance];
  if (significanceDifference !== 0) return significanceDifference;

  const launchDifference = Number(b.type === 'launch') - Number(a.type === 'launch');
  if (launchDifference !== 0) return launchDifference;

  const titleDifference = a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
  if (titleDifference !== 0) return titleDifference;

  return a.slug.localeCompare(b.slug, 'en', { sensitivity: 'base' });
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

  const builds = readCollection(`${contentDir}builds`)
    .map(({ slug, data }) => ({
      title: requireString(data.title, `builds/${slug} title`),
      // Builds have no per-entry route; src/pages/builds/ is an index page only.
      url: `${base}/builds`,
      date: isoDate(data.date, `builds/${slug} date`),
      status: requireString(data.status, `builds/${slug} status`),
      tags: data.tags ?? [],
      description: requireString(data.description, `builds/${slug} description`),
      ...(data.github ? { github: data.github } : {}),
      ...(data.live ? { live: data.live } : {}),
    }))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const allChangelog = readCollection(`${contentDir}changelog`)
    .filter(({ data }) => data.draft !== true)
    .map(({ slug, data }) => ({
      slug,
      title: requireString(data.title, `changelog/${slug} title`),
      url: `${base}/changelog/${slug}`,
      date: isoDate(data.date, `changelog/${slug} date`),
      ...(data.publishedAt
        ? { publishedAt: isoDate(data.publishedAt, `changelog/${slug} publishedAt`) }
        : {}),
      type: requireString(data.type, `changelog/${slug} type`),
      significance: requireString(data.significance, `changelog/${slug} significance`),
      tags: data.tags ?? [],
      summary: requireString(data.summary, `changelog/${slug} summary`),
    }))
    .sort(compareChangelog);

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
    builds,
    changelog: allChangelog.slice(0, CHANGELOG_LIMIT),
    counts: {
      writing: writing.length,
      builds: builds.length,
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
