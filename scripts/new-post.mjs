/**
 * Scaffold a new writing draft with schema-correct frontmatter.
 *
 * Usage:  npm run new-post -- "My post title"
 *
 * Takes the human-readable title, not a filename. The slug is derived from it
 * (lowercase, apostrophes dropped, runs of non-alphanumerics become hyphens), and
 * the title lands verbatim in the frontmatter. "How to implement WebMCP!" creates
 * how-to-implement-webmcp.md titled "How to implement WebMCP!".
 *
 * Creates src/content/writing/<slug>.md with draft: true, today's local date,
 * and the fields the writing collection's Zod schema expects (src/content.config.ts).
 * `draft: true` keeps it out of getStaticPaths, the indexes, RSS, the sitemap,
 * llms.txt, and OG generation in every environment, so the file is safe to commit
 * mid-draft. Refuses to overwrite an existing file.
 *
 * Field notes, mirroring the schema:
 * - description is required by the schema; a placeholder ships so the file parses,
 *   and Steward's review is the net for forgetting to replace it.
 * - updated is omitted on purpose: it is set on substantive edits after publish.
 * - seoTitle/seoDescription are omitted: only needed past SERP limits (~60/~155).
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const title = process.argv[2];
if (!title || title.startsWith('-')) {
  console.error('Usage: npm run new-post -- "My post title"');
  console.error('Give the human title, quoted; the filename is derived from it.');
  process.exit(1);
}

const slug = title
  .toLowerCase()
  .replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

if (!slug) {
  console.error(`Could not derive a slug from "${title}".`);
  process.exit(1);
}

// Local date, not UTC: an evening scaffold should carry today's date.
const now = new Date();
const date = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
].join('-');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'src', 'content', 'writing', `${slug}.md`);

if (existsSync(file)) {
  console.error(`Refusing to overwrite existing ${file}`);
  process.exit(1);
}

const frontmatter = `---
title: "${title.replace(/"/g, '\\"')}"
date: ${date}
description: "REPLACE: one to two sentences; drives the index card and meta description."
tags: []
featured: false
draft: true
---

`;

writeFileSync(file, frontmatter);
console.log(`Created src/content/writing/${slug}.md (draft: true)`);
console.log('Body headings start at h2; the template emits the h1 from title.');
