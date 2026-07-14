// SHOW_DRAFTS gives a real production-build render of drafts locally (npm run
// preview serves dist/, where import.meta.env.DEV is always false). Never let
// it touch RSS, the sitemap, or llms.txt — see astro.config.mjs and the
// llms.txt endpoints, which filter on `!data.draft` unconditionally.
//
// Read from process.env, not import.meta.env: this only ever runs server-side
// (build time / SSR frontmatter), and Vite only forwards shell env vars into
// import.meta.env when they're VITE_-prefixed or listed in envPrefix — plain
// `SHOW_DRAFTS=true npm run build` would otherwise be silently ignored.
export const showDrafts = import.meta.env.DEV || process.env.SHOW_DRAFTS === 'true';
