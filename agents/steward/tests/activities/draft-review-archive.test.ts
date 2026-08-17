import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The archive split: a review of an unpublished post must not be one `git add
 * -A` from public history, and a published post's review must keep landing in
 * the committed dataset exactly as before.
 *
 * Both roots are redirected here through the single `STEWARD_REVIEWS_DIR`
 * override (`DRAFT_REVIEWS_DIR` is derived from it), so nothing this file writes
 * can reach the real archive on either side.
 */
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-split-'));
const tmpSite = path.join(tmpRoot, 'site');
process.env.STEWARD_SITE_DIR = tmpSite;
process.env.STEWARD_REVIEWS_DIR = path.join(tmpRoot, 'reviews');

const { archiveReport } = await import('../../src/activities/archive.js');
const { promoteReviews } = await import('../../src/lib/promote-reviews.js');
const { readLatestReport } = await import('../../src/lib/read-report.js');
const { reviewIsUnpublished } = await import('../../src/lib/report.js');
const { DRAFT_REVIEWS_DIR, REVIEWS_DIR } = await import('../../src/config.js');
import type { ReviewMode, ReviewReport } from '../../src/lib/report.js';

function report(slug: string, draft: boolean | undefined, mode: ReviewMode = 'gate'): ReviewReport {
  return {
    schemaVersion: 1,
    slug,
    collection: 'writing',
    mode,
    ...(draft === undefined ? {} : { draft }),
    file: `src/content/writing/${slug}.md`,
    // Distinct per slug so the hash-keyed filenames do not collide.
    contentSha256: createHash('sha256').update(slug).digest('hex'),
    reviewedAt: new Date().toISOString(),
    workflowId: 'wf',
    runId: 'run',
    passes: [],
    patches: [],
    overall: 'pass',
    summary: 'PASS — no findings.',
    human: {},
    publish: {},
  };
}

async function writePost(slug: string, draft: boolean): Promise<void> {
  const dir = path.join(tmpSite, 'src', 'content', 'writing');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${slug}.md`),
    `---\ntitle: "t"\ndate: 2026-08-16\ndraft: ${draft}\n---\n\nbody\n`,
    'utf8',
  );
}

const exists = async (p: string): Promise<boolean> =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false);

test.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

// --- routing ---------------------------------------------------------------

test("a draft post's review is archived outside the committed dataset", async () => {
  const result = await archiveReport(report('held-draft', true));

  const held = path.join(DRAFT_REVIEWS_DIR, 'writing', 'held-draft');
  assert.equal(await exists(path.join(held, 'latest.json')), true, 'it lands in the holding path');
  assert.equal(
    await exists(path.join(REVIEWS_DIR, 'writing', 'held-draft')),
    false,
    'and nothing at all is written under reviews/',
  );
  // The returned path is still repo-relative and still round-trips, so every
  // reader (the workflow's `reportPath`, `steward report`) keeps working.
  assert.match(result.latestPath, /held-draft\/latest\.json$/);
  assert.equal((await readLatestReport('writing', 'held-draft'))?.slug, 'held-draft');
});

test("a published post's review is archived in reviews/, as before", async () => {
  await archiveReport(report('published-post', false, 'audit'));

  assert.equal(
    await exists(path.join(REVIEWS_DIR, 'writing', 'published-post', 'latest.json')),
    true,
  );
  assert.equal(await exists(path.join(DRAFT_REVIEWS_DIR, 'writing', 'published-post')), false);
});

test('a report with no draft flag falls back to the mode, and errs towards holding', async () => {
  // Every archive written before the flag existed. `gate` refuses anything that
  // is not `draft: true`, so a gate review is a draft's review by construction.
  assert.equal(reviewIsUnpublished({ draft: undefined, mode: 'gate' }), true);
  assert.equal(reviewIsUnpublished({ draft: undefined, mode: 'audit' }), false);
  // The flag wins over the mode when both are present: `steward audit` run
  // against a post that is still a draft is exactly the case the mode misses.
  assert.equal(reviewIsUnpublished({ draft: true, mode: 'audit' }), true);

  await archiveReport(report('legacy-gate', undefined));
  assert.equal(await exists(path.join(DRAFT_REVIEWS_DIR, 'writing', 'legacy-gate')), true);
  assert.equal(await exists(path.join(REVIEWS_DIR, 'writing', 'legacy-gate')), false);
});

// --- promotion -------------------------------------------------------------

test('promoteReviews moves a held review once its post publishes, and not before', async () => {
  await archiveReport(report('shipping-soon', true));
  await writePost('shipping-soon', true);

  const first = await promoteReviews();
  assert.equal(first.promoted.length, 0, 'still a draft — nothing moves');
  assert.equal(
    first.held.some((h) => h.slug === 'shipping-soon' && /draft: true/.test(h.reason)),
    true,
  );

  // The post ships: the merge lands and the checkout catches up.
  await writePost('shipping-soon', false);

  const second = await promoteReviews();
  const moved = second.promoted.find((p) => p.slug === 'shipping-soon');
  assert.ok(moved, 'the review is promoted');
  assert.equal(moved.files.length, 2, 'the hash-keyed file and latest.json both move');
  assert.equal(moved.files.includes('latest.json'), true);
  assert.equal(
    await exists(path.join(REVIEWS_DIR, 'writing', 'shipping-soon', 'latest.json')),
    true,
    'it is now in the committed dataset',
  );
  assert.equal(
    await exists(path.join(DRAFT_REVIEWS_DIR, 'writing', 'shipping-soon')),
    false,
    'and the holding directory is gone',
  );

  // Idempotent: a second run finds nothing left to do rather than failing.
  const third = await promoteReviews();
  assert.equal(
    third.promoted.some((p) => p.slug === 'shipping-soon'),
    false,
  );
});

test('a held review whose post does not exist stays held', async () => {
  await archiveReport(report('no-post-here', true));
  const { promoted, held } = await promoteReviews();

  assert.equal(promoted.some((p) => p.slug === 'no-post-here'), false);
  assert.equal(
    held.some((h) => h.slug === 'no-post-here' && /no post at/.test(h.reason)),
    true,
    'absence is not publication — a renamed or fixture-only slug is not promoted',
  );
  assert.equal(await exists(path.join(DRAFT_REVIEWS_DIR, 'writing', 'no-post-here')), true);
});
