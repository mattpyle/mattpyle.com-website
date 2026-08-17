import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DRAFT_REVIEWS_DIR,
  REPO_ROOT,
  REVIEWS_DIR,
  SITE_DIR,
  postRelPath,
  type Collection,
} from '../config.js';
import { parseFrontmatter } from './frontmatter.js';
import { log } from './logger.js';

/**
 * The other half of the archive split (`config.ts`, {@link DRAFT_REVIEWS_DIR}).
 *
 * `archiveReport` holds an unpublished post's review out of the repo. This moves
 * it into the committed dataset once the post is live, so the dataset still
 * grows and the hold is a delay rather than a deletion.
 *
 * **What counts as shipped, here: the post file in the checkout no longer says
 * `draft: true`.** That is the same fact the site itself builds from, it needs
 * no network call, and it is only true locally after the publish PR is merged
 * and the checkout has caught up — which is exactly when `steward cleanup` runs.
 * A post whose file is missing (renamed, or never committed, or a fixture) is
 * left held: absence is not publication.
 *
 * Idempotent. Running it twice, or against an empty holding path, is a no-op.
 */

const COLLECTIONS: readonly Collection[] = ['writing', 'changelog'];

export interface PromotedReview {
  collection: Collection;
  slug: string;
  /** Repo-relative, forward slashes — the same shape `archiveReport` returns. */
  from: string;
  to: string;
  files: string[];
}

export interface PromoteReviewsResult {
  promoted: PromotedReview[];
  /** Slugs still held, with the reason, so the CLI can say why nothing moved. */
  held: { collection: Collection; slug: string; reason: string }[];
}

const rel = (p: string) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

/**
 * `true` when the post exists and is published, `false` when it exists and is
 * still a draft, `null` when there is no post file to read.
 */
async function isPublished(collection: Collection, slug: string): Promise<boolean | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(SITE_DIR, postRelPath(slug, collection)), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parseFrontmatter(raw).data?.draft !== true;
}

/**
 * Moves one held review directory into the public dataset.
 *
 * File by file with an explicit overwrite rather than `fs.rename` on the
 * directory: a slug can have both a held review and an older public one (a post
 * published, then re-reviewed as a draft for a rewrite), and `rename` onto an
 * existing directory fails on every platform. Moving the files merges the two
 * histories, which is what the hash-keyed layout is for, and `latest.json` is
 * overwritten by the newer copy on purpose.
 */
async function movePromoted(collection: Collection, slug: string): Promise<PromotedReview> {
  const from = path.join(DRAFT_REVIEWS_DIR, collection, slug);
  const to = path.join(REVIEWS_DIR, collection, slug);
  await fs.mkdir(to, { recursive: true });

  const names = (await fs.readdir(from, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name);

  for (const name of names) {
    // copy-then-unlink, not rename: the two roots are siblings today, but a
    // redirected `STEWARD_REVIEWS_DIR` can put them on different volumes, where
    // rename gives EXDEV.
    await fs.copyFile(path.join(from, name), path.join(to, name));
    await fs.unlink(path.join(from, name));
  }

  // Only if it is now empty. A leftover subdirectory is a surprise worth
  // leaving on disk to be looked at, not something to delete recursively.
  await fs.rmdir(from).catch(() => {});

  return { collection, slug, from: rel(from), to: rel(to), files: names.sort() };
}

/**
 * Promotes every held review whose post has since published. See the module
 * docblock for what "published" means here.
 */
export async function promoteReviews(): Promise<PromoteReviewsResult> {
  const promoted: PromotedReview[] = [];
  const held: PromoteReviewsResult['held'] = [];

  for (const collection of COLLECTIONS) {
    let slugs: string[];
    try {
      slugs = (await fs.readdir(path.join(DRAFT_REVIEWS_DIR, collection), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // Nothing held for this collection.
    }

    for (const slug of slugs.sort()) {
      const published = await isPublished(collection, slug);
      if (published === null) {
        held.push({
          collection,
          slug,
          reason: `no post at \`${postRelPath(slug, collection)}\` — nothing says it shipped`,
        });
        continue;
      }
      if (!published) {
        held.push({ collection, slug, reason: 'still `draft: true`' });
        continue;
      }
      promoted.push(await movePromoted(collection, slug));
    }
  }

  if (promoted.length > 0) {
    log.info(
      { promoted: promoted.map((p) => `${p.collection}/${p.slug}`) },
      'held reviews promoted into the public dataset',
    );
  }
  return { promoted, held };
}
