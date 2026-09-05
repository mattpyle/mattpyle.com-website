/**
 * The committed files under `src/data/` that a publish commit has to regenerate.
 *
 * **Why this exists.** Three of the site's `prebuild` scripts write files that
 * are committed, and three site tests assert the committed copy matches what the
 * generator produces from the content tree. A publish commit that carries the
 * post alone leaves all three stale, so `Site tests & astro check` goes red on
 * the PR — hit for real on PR 218 and again on PR 228, where
 * `tests/page-paths.test.mjs` and `tests/a2a-digest.test.mjs` failed on a
 * post-only publish. `agents/steward/tests/activities/cspell-published.test.ts`
 * went red with them.
 *
 * Same shape as the dictionary: anything the post changes that is not the post
 * has to travel with it. The dictionary is *resolved* from the author's checkout
 * (`lib/post-payload.ts`), so it is a payload group. These are *produced* in the
 * worktree from the tree the publish commit is about to create, and the author's
 * copies are irrelevant to them — so they are their own list rather than a fifth
 * payload group, and `writeAndStagePayload` never copies them across.
 *
 * Two consumers, one list: `activities/publish.ts` runs the scripts and stages
 * the outputs, and `lib/cleanup.ts` sweeps the outputs out of the author's
 * checkout after the merge.
 *
 * **Not the whole `prebuild`.** That script runs five, and the other two are
 * deliberately absent: `validate-content-references.mjs` is a check that writes
 * nothing, and `generate-og-images.mjs` needs `node_modules` and writes
 * gitignored `public/og/`. The build audit already builds the post; publish only
 * needs the committed data files.
 */

/** One generator: the script to run, and the committed file it writes. */
export interface GeneratedData {
  /** Repo-relative path of the script, run under the worktree's own copy. */
  script: string;
  /** Repo-relative path of the committed file it writes. */
  output: string;
}

/**
 * Every generator whose output is committed, in `prebuild`'s order.
 *
 * Each writes only when the bytes differ, which is what makes the publish leg's
 * idempotence check cover them: a re-approve against a base that already carries
 * the post regenerates identical files and stages nothing.
 *
 * None of them needs `node_modules` — every import is a `node:` builtin or a
 * repo-relative file — which is why they can run in a fresh publish worktree
 * that has never had an audit's `npm ci`. `generate-a2a-digest.mjs` imports a
 * `.ts` file, stripped natively by the Node 24 binary Steward already runs
 * under (`engines`, `.nvmrc`, and the Vercel project setting all pin it).
 */
export const GENERATED_DATA: readonly GeneratedData[] = [
  { script: 'scripts/generate-a2a-digest.mjs', output: 'src/data/a2a-digest.json' },
  {
    script: 'scripts/generate-agent-skills-index.mjs',
    output: 'src/data/agent-skills-index.json',
  },
  { script: 'scripts/generate-page-paths.mjs', output: 'src/data/page-paths.mjs' },
];

/** Just the committed paths, for the consumer that only cares about those. */
export const GENERATED_DATA_FILES: readonly string[] = GENERATED_DATA.map((g) => g.output);
