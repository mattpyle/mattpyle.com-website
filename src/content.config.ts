import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

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
    status:      z.enum(['active', 'in-progress', 'archived']),
    date:        z.coerce.date(),
  }),
});

export const collections = { writing, builds };
