import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ApplicationFailure } from '@temporalio/common';
import { SITE_DIR, postRelPath, type Collection } from '../config.js';
import type { DraftSnapshot } from '../lib/report.js';
import { timed } from '../lib/logger.js';

export function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function listDraftSlugs(collection: Collection): Promise<string[]> {
  const dir = path.join(SITE_DIR, 'src', 'content', collection);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const drafts: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    if (matter(raw).data?.draft === true) drafts.push(name.replace(/\.md$/, ''));
  }
  return drafts;
}

/**
 * Spec §8.1. Reads the post's bytes, pins them with SHA-256, parses frontmatter.
 *
 * Note the hash is over the raw file bytes, not the parsed content: that is what
 * makes design rule 2 (verdicts pinned to content) hold for whitespace-only edits
 * too.
 */
export async function snapshotDraft(
  slug: string,
  collection: Collection = 'writing',
): Promise<DraftSnapshot> {
  const { result } = await timed('snapshotDraft', async () => {
    const rel = postRelPath(slug, collection);
    const abs = path.join(SITE_DIR, rel);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(abs);
    } catch {
      const drafts = await listDraftSlugs(collection);
      throw ApplicationFailure.nonRetryable(
        `No post at ${rel}. Available ${collection} draft slugs: ${drafts.length ? drafts.join(', ') : '(none)'}`,
        'PostNotFound',
      );
    }
    const parsed = matter(bytes.toString('utf8'));
    return {
      slug,
      collection,
      file: rel.split(path.sep).join('/'),
      contentSha256: sha256(bytes),
      frontmatter: parsed.data as Record<string, unknown>,
      body: parsed.content,
    } satisfies DraftSnapshot;
  });
  return result;
}

/**
 * Cheap re-read used by the approve path (spec §7.3 step 4) to detect that the
 * file changed under the review. Separate from snapshotDraft so the workflow can
 * ask "is this still the thing I reviewed?" without redoing the parse.
 */
export async function currentContentHash(
  slug: string,
  collection: Collection = 'writing',
): Promise<string | null> {
  const abs = path.join(SITE_DIR, postRelPath(slug, collection));
  try {
    return sha256(await fs.readFile(abs));
  } catch {
    return null;
  }
}
