import { config, fields, collection } from '@keystatic/core';

/**
 * Keystatic admin config — DEV ONLY.
 *
 * Nothing loads this file in a production build. `astro.config.mjs`, the config
 * every `astro build` uses, does not import @keystatic/astro; the integration is
 * mounted only by `astro.config.dev.mjs`, which only `npm run dev` passes with
 * `--config`. See the header of that file for the gate and why it cannot leak.
 *
 * One collection, `writing`, mapping src/content/writing. Every field here is a
 * hand-restatement of the Zod schema in src/content.config.ts, so this file is
 * the third copy of the writing schema, beside content.config.ts and Steward's
 * RULES table in agents/steward/src/activities/frontmatter.ts. A field the Zod
 * schema allows but this file omits does not degrade: Keystatic refuses to open
 * any entry that carries it.
 *
 * `image` is the OG social-card override consumed by src/pages/writing/[slug].astro.
 * It is a plain string path, not a body image, so it stays a text field.
 */
export default config({
  storage: { kind: 'local' },
  ui: {
    brand: { name: 'mattpyle.com' },
  },
  collections: {
    writing: collection({
      label: 'Writing',
      slugField: 'title',
      path: 'src/content/writing/*',
      format: { contentField: 'content' },
      entryLayout: 'content',
      columns: ['title', 'date'],
      schema: {
        title: fields.slug({
          name: { label: 'Title', validation: { isRequired: true } },
        }),
        date: fields.date({
          label: 'Date',
          validation: { isRequired: true },
        }),
        updated: fields.date({ label: 'Updated' }),
        tags: fields.array(fields.text({ label: 'Tag' }), {
          label: 'Tags',
          itemLabel: (props) => props.value,
        }),
        draft: fields.checkbox({ label: 'Draft', defaultValue: false }),
        description: fields.text({
          label: 'Description',
          multiline: true,
          validation: { isRequired: true },
        }),
        image: fields.text({ label: 'Image (OG card override)' }),
        seoTitle: fields.text({ label: 'SEO title' }),
        seoDescription: fields.text({ label: 'SEO description', multiline: true }),
        content: fields.markdoc({
          label: 'Content',
          // Plain .md on disk rather than Keystatic's default .mdoc.
          extension: 'md',
          options: {
            image: {
              // Body images land in src/assets/writing/<slug>/, with a relative
              // reference, which is what Astro's image pipeline needs. Keystatic
              // adds the per-entry subfolder itself.
              directory: 'src/assets/writing',
              publicPath: '../../assets/writing/',
            },
          },
        }),
      },
    }),
  },
});
