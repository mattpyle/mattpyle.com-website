import { config, fields, collection } from '@keystatic/core';

/**
 * SPIKE ONLY — branch spike/keystatic, not for merge.
 *
 * One collection, `writing`, mapping src/content/writing. Every field here is a
 * hand-restatement of the Zod schema in src/content.config.ts, which is the
 * point of question 7 in docs/work/keystatic-spike.md: this file is the third
 * copy of the writing schema, beside content.config.ts and Steward's RULES
 * table in agents/steward/src/activities/frontmatter.ts.
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
              directory: 'src/assets/writing',
              publicPath: '../../assets/writing/',
            },
          },
        }),
      },
    }),
  },
});
