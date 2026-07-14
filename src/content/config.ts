import { defineCollection, z } from 'astro:content';

const writing = defineCollection({
  type: 'content',
  schema: z.object({
    title:       z.string(),
    date:        z.date(),
    updated:     z.date().optional(),
    tags:        z.array(z.string()).default([]),
    featured:    z.boolean().default(false),
    draft:       z.boolean().default(false),
    description: z.string(),
    image:       z.string().optional(),
  }),
});

const builds = defineCollection({
  type: 'content',
  schema: z.object({
    title:       z.string(),
    description: z.string(),
    tags:        z.array(z.string()).default([]),
    github:      z.string().url().optional(),
    live:        z.string().url().optional(),
    status:      z.enum(['active', 'in-progress', 'archived']),
    date:        z.date(),
  }),
});

export const collections = { writing, builds };
