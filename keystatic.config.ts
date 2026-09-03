import { config, fields, collection } from '@keystatic/core';
import { block } from '@keystatic/core/content-components';

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
        // The hero, at the head of the post body. A real asset rather than the
        // string `image` above: the Zod schema declares it `image()`, so Astro
        // optimises it and emits intrinsic dimensions, and a path that does not
        // resolve fails the whole collection.
        //
        // Same `directory`/`publicPath` pair as the body images below, so a hero
        // and a body image sit side by side in src/assets/writing/<slug>/ and
        // both save the relative form `image()` resolves from the post's own
        // file. An absolute `/src/...` path here would not resolve and would
        // break every page in dev.
        hero: fields.image({
          label: 'Hero image',
          directory: 'src/assets/writing',
          publicPath: '../../assets/writing/',
        }),
        heroAlt: fields.text({
          label: 'Hero alt text',
          description: 'What the image tells the reader. Leave empty for a purely decorative hero, which renders alt="".',
        }),
        content: fields.mdx({
          label: 'Content',
          // Plain .md on disk rather than Keystatic's default .mdx. The mdx
          // field replaced fields.markdoc on 2026-08-31: markdoc serialises
          // every table as a {% table %} tag, which the site's remark pipeline
          // renders as literal text; mdx serialises tables as GFM pipe tables
          // (mdast-util-gfm-table), which is what the site and its agent
          // surfaces expect. Cost: the MDX parser reads a bare `<` or `{` in
          // prose as JSX, so placeholder lines like <TODO: ...> refuse to
          // open; keep those as plain text or inside code spans.
          extension: 'md',
          // The one declared component. The MDX field accepts only components
          // named here, and there is no raw-HTML block in the editor, so this is
          // the only route from the editor to a real element in the page.
          //
          // It serialises to one self-closing line, which plain markdown parses
          // as a block-level `html` node:
          //
          //   <Video src="/video/x.mp4" poster="/video/x.jpg" width={1574} height={820} />
          //
          // src/lib/video-embed.mjs turns that line into a <video> element, in
          // the site's markdown pipeline and in the two agent routes that emit
          // the body verbatim. Read its header before changing any name here: the
          // rewrite matches this exact shape and leaves anything else untouched.
          //
          // Every field is required. `fields.text` serialises an empty string as
          // `undefined`, which the serialiser writes as `poster={}` — a tag the
          // rewrite rejects, leaving JSX in the published page.
          //
          // No ContentView: that needs this config renamed to .tsx and React in
          // the editor. The site preview on `npm run dev` is the real check.
          components: {
            Video: block({
              label: 'Video',
              description: 'A self-hosted MP4 from public/video/, with a poster frame.',
              schema: {
                src: fields.text({
                  label: 'MP4 path',
                  description: 'Site-absolute, e.g. /video/chatgpt-site-tools.mp4',
                  validation: { isRequired: true },
                }),
                poster: fields.text({
                  label: 'Poster image path',
                  description: 'Site-absolute, e.g. /video/chatgpt-site-tools-poster.jpg',
                  validation: { isRequired: true },
                }),
                // Intrinsic pixel size of the file. Wrong numbers shift the
                // layout as the poster loads; public/ gets no processing, so
                // nothing derives them for you.
                width: fields.integer({
                  label: 'Width (px)',
                  validation: { isRequired: true, min: 1 },
                }),
                height: fields.integer({
                  label: 'Height (px)',
                  validation: { isRequired: true, min: 1 },
                }),
              },
            }),
          },
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
