import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// The Steward (agents/steward/src/activities/frontmatter.ts) hand-transcribes
// each collection's fields/enums/required-flags into its own RULES constant.
// Changing a schema here (fields, enums, required flags) means updating that
// RULES table in the same commit, or the Steward will false-block on — or
// silently allow — a value this schema no longer agrees with.

const writing = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/writing' }),
  schema: z.object({
    title:       z.string(),
    date:        z.coerce.date(),
    updated:     z.coerce.date().optional(),
    tags:        z.array(z.string()).default([]),
    featured:    z.boolean().default(false),
    draft:       z.boolean().default(false),
    description: z.string(),
    image:       z.string().optional(),
    /** Short, untruncated overrides for search engines — see CLAUDE.md "Authoring content". Leave unset unless the on-page title/description exceed SERP limits (~60/~155 chars). */
    seoTitle:       z.string().optional(),
    seoDescription: z.string().optional(),
  }),
});

const builds = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/builds' }),
  schema: z.object({
    title:       z.string(),
    description: z.string(),
    tags:        z.array(z.string()).default([]),
    github:      z.url().optional(),
    live:        z.url().optional(),
    status:      z.enum(['live', 'in-progress', 'archived']),
    date:        z.coerce.date(),
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
    /** Optional full-content-width hero on the entry page. */
    hero:         image().optional(),
    draft:        z.boolean().default(false),
  }),
});

export const collections = { writing, builds, changelog };
