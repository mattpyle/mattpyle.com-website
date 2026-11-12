import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Steward (agents/steward/src/activities/frontmatter.ts) hand-transcribes
// each collection's fields/enums/required-flags into its own RULES constant.
// Changing a schema here (fields, enums, required flags) means updating that
// RULES table in the same commit, or Steward will false-block on — or
// silently allow — a value this schema no longer agrees with.

const writing = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/writing' }),
  schema: ({ image }) => z.object({
    title:       z.string(),
    date:        z.coerce.date(),
    updated:     z.coerce.date().optional(),
    tags:        z.array(z.string()).default([]),
    draft:       z.boolean().default(false),
    description: z.string(),
    image:       z.string().optional(),
    /** Short, untruncated overrides for search engines — see CLAUDE.md "Authoring content". Leave unset unless the on-page title/description exceed SERP limits (~60/~155 chars). */
    seoTitle:       z.string().optional(),
    seoDescription: z.string().optional(),
    /** Optional hero on the post page, at the prose measure. Note the field above: `image` is the OG card override and stays a plain string; this one is an asset the build optimises. */
    hero:        image().optional(),
    /** Alt text for an informative hero. Omit for a purely decorative one (renders alt=""). */
    heroAlt:     z.string().optional(),
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/projects' }),
  schema: ({ image }) => z.object({
    title:       z.string(),
    description: z.string(),
    tags:        z.array(z.string()).default([]),
    github:      z.url().optional(),
    live:        z.url().optional(),
    status:      z.enum(['live', 'in-progress', 'archived']),
    date:        z.coerce.date(),
    /** Optional card thumbnail, an asset the build optimises. No alt field: the card's image slot is `aria-hidden` and the card's accessible name is the project title, so the image is decorative by construction and renders `alt=""`. A project without one keeps the placeholder hatch. */
    image:       image().optional(),
  }),
});

const changelog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/changelog' }),
  schema: ({ image }) => z.object({
    title:        z.string(),
    /** 1–2 sentences; shown on the /changelog index and as the entry dek. */
    summary:      z.string(),
    date:         z.coerce.date(),
    /** Exact publication time for deterministic same-day ordering. Historical entries may omit it. */
    publishedAt:  z.coerce.date().optional(),
    // Changelog dates describe when the change shipped; sitemap lastmod needs
    // an explicit page-content update date, even for newly authored entries.
    updated:      z.coerce.date(),
    /** Topical tags (writing, infra, a11y…) — the bordered pills. */
    tags:         z.array(z.string()).default([]),
    /** The distinguished, filled accent pill. */
    type:         z.enum(['launch', 'feature', 'content', 'infra', 'experiment']),
    /** Drives the coloured significance dot + legend. */
    significance: z.enum(['major', 'minor', 'patch']),
    /** Short, untruncated overrides for search engines. `title` and `summary` still drive the visible H1 and dek, and the JSON-LD, so an entry's on-page text never bends to a SERP budget. Leave unset unless the rendered title/description exceed ~60/~155 chars. */
    seoTitle:       z.string().optional(),
    seoDescription: z.string().optional(),
    /** Optional full-content-width hero on the entry page. */
    hero:         image().optional(),
    /** Alt text for an informative hero. Omit for a purely decorative one (renders alt=""). */
    heroAlt:      z.string().optional(),
    draft:        z.boolean().default(false),
  }),
});

/**
 * One problem on this site that its agents found and fixed, one file per fix.
 * `scripts/fix-log-entries.mjs` writes the facts once from the finding and its fix
 * pull request and never overwrites a file; a person or a model writes the title,
 * the lead, the measures and the story under `agents/steward/briefs/fix-log.md`.
 * Times are UTC instants; a page shows them in America/Vancouver.
 *
 * Outside Steward's RULES table on purpose: RULES covers the collections Steward
 * reviews before publishing (`COLLECTIONS` in agents/steward/src/config.ts), and
 * nothing reviews a fix entry. Steward writes these, it does not gate them.
 */
const lines = z.object({
  kind:  z.literal('lines'),
  /** What the lines are from, such as `llms.txt`. */
  label: z.string(),
  lines: z.array(z.object({ text: z.string(), mark: z.enum(['added', 'removed']).optional() })).min(1),
});
const specimen = z.discriminatedUnion('kind', [
  lines,
  z.object({ kind: z.literal('spoken'), label: z.string(), words: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('missing'), label: z.string(), text: z.string() }),
]);

const fixes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/fixes' }),
  schema: z.object({
    /** The finding's short key. Joins the entry to its finding; unique. */
    key:         z.string().regex(/^MP-\d+$/),
    title:       z.string().min(1),
    /** The page URL segment: /fix-log/<slug>/. Written once with the first title, never derived at build time, so a later title edit leaves the link alone. Unique. */
    slug:        z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    /** One sentence under the title. */
    lead:        z.string().min(1),
    type:        z.enum(['seo', 'agent-readiness', 'content', 'ux', 'accessibility', 'feature']),
    kind:        z.enum(['defect', 'opportunity']),
    /** `reopened` when the check on production still failed after the fix. */
    status:      z.enum(['fixed', 'reopened']),
    /** How the after was confirmed: a check on production, or the deploy that carries the fix. */
    confirmedBy: z.enum(['check', 'deploy']),
    /** The site path, or URL, where a reader can see the fix. */
    where:       z.string().min(1),
    /** Something visible changed, so a screenshot pair belongs here later. */
    visual:      z.boolean(),
    /** For a visual fix, the screen it is about. */
    screen:      z.enum(['phone', 'desktop']).optional(),
    /** The day the problem was first seen. */
    found:       z.coerce.date(),
    approved:    z.coerce.date(),
    /** When the fix was confirmed on production. */
    verified:    z.coerce.date(),
    /** The calendar day of a substantive edit (UTC, like `found`). The sitemap date is the later of this and `verified`. */
    updated:     z.coerce.date().optional(),
    /** The fix pull request first, then any later one that finished or repaired it. */
    changes:     z.array(z.object({
      number: z.number().int().positive(),
      title:  z.string(),
      opened: z.coerce.date(),
      merged: z.coerce.date(),
    })).min(1),
    /** The before and after, as named pairs. An entry shows its before and after once: one measure or one changed text, never both. */
    measures:    z.array(z.object({
      label:  z.string().min(1),
      before: z.string().min(1),
      after:  z.string().min(1),
      /** Words, not a number: shown in quotation marks. */
      quoted: z.boolean().default(false),
      /** Names for the two sides, when they are not Before and After. */
      sides:  z.tuple([z.string(), z.string()]).optional(),
    })).length(1).optional(),
    /** The before and after as changed lines, or words spoken, or a gap. Used when measures are not the best form. */
    text:        z.object({ before: specimen, after: specimen }).optional(),
    /** The checks run on production when the fix was confirmed. `before` is set only where a check also ran before the fix. */
    checks:      z.array(z.object({
      passed:   z.boolean(),
      method:   z.enum(['text', 'js', 'selector', 'markdown', 'header']),
      urls:     z.array(z.string()).min(1),
      viewport: z.string().optional(),
      expected: z.string(),
      measured: z.string(),
      before:   z.string().optional(),
    })).default([]),
  }).refine((entry) => Boolean(entry.measures) !== Boolean(entry.text), {
    message: 'An entry shows its before and after once: hold measures or changed text, not both and not neither.',
  }),
});

export const collections = { writing, projects, changelog, fixes };
